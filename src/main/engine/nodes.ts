import {
    type CategorizerConfig,
    type FlowNode,
    type ProcessorConfig,
    type TerminalConfig,
    type TriggerConfig,
    UNMATCHED_PORT,
} from '@shared/flow';
import { type EmailEnvelope, emailHeader, now, type TraceEvent } from '@shared/trace';
import { runClaude } from '../claude/runner';
import { createEmailToolServer, EMAIL_SERVER_NAME, emailToolNames } from '../claude/emailTools';
import { getSettings } from '../store/settingsStore';
import { globalPluginFor } from '../store/skillStore';
import { flowDir } from '../paths';
import * as outlook from '../outlook/bridge';
import { GLOBAL_SKILL_PLUGIN, isGlobalRef } from '@shared/settings';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/** What the engine hands a node, and what it expects back. */
export interface NodeContext {
    /** The flow being run: its directory holds the skills this node may use. */
    flowId: string;
    node: FlowNode;
    email: EmailEnvelope;
    scratchDir: string;
    signal: AbortSignal;

    onEvent(event: TraceEvent): void;
}

export interface NodeOutcome {
    /** Port to leave by. Null ends the path here. */
    outPort: string | null;
    summary: string;
    /** Set on a terminal node, recorded on the run. */
    disposition?: string;
    error?: string;
}

function emailContext(email: EmailEnvelope, body: string | undefined): string {
    return [
        ...emailHeader(email),
        '',
        body ? `--- Body ---\n${body}` : `--- Preview (body not fetched) ---\n${email.bodyPreview}`,
    ].join('\n');
}

// ── Trigger ──────────────────────────────────────────────────────────────
// The email is already in hand; this pass just starts the trace at the trigger.

function runTrigger(config: TriggerConfig): NodeOutcome {
    return {
        outPort: 'out',
        summary: `Received in ${config.account}${config.folder ? `\\${config.folder}` : ' Inbox'}`,
    };
}

// ── Categorizer ──────────────────────────────────────────────────────────

async function runCategorizer(ctx: NodeContext, config: CategorizerConfig): Promise<NodeOutcome> {
    if (config.categories.length === 0) {
        return { outPort: UNMATCHED_PORT, summary: 'No categories defined — sent to Unmatched.' };
    }

    let body: string | undefined;
    if (config.includeBody) {
        try {
            const result = await outlook.readBody(ctx.email.ref, config.bodyMaxChars);
            body = result.body;
            ctx.email.body = result.body;
            ctx.onEvent({
                at: now(),
                type: 'outlook',
                label: `Read body (${result.bodyLength} characters)`,
            });
        } catch (e) {
            // An unreadable body means classifying on the preview, not failing.
            ctx.onEvent({
                at: now(),
                type: 'error',
                label: 'Could not read the body; classifying on the preview',
                detail: e instanceof Error ? e.message : String(e),
            });
        }
    }

    const ids = config.categories.map((c) => c.id);
    const prompt = [
        'Classify the email below into exactly one of the categories.',
        '',
        'Categories:',
        ...config.categories.map((c) => `- id "${c.id}" (${c.label}): ${c.description}`),
        `- id "${UNMATCHED_PORT}": none of the above genuinely fits.`,
        '',
        'Choose by what the email actually is, not by keywords alone. If it plausibly',
        `fits none of the described categories, choose "${UNMATCHED_PORT}" rather than`,
        'forcing a match — a wrong branch is more expensive than an unmatched one.',
        '',
        '--- Email ---',
        emailContext(ctx.email, body),
    ].join('\n');

    const result = await runClaude({
        prompt,
        model: config.model,
        cwd: flowDir(ctx.flowId),
        // One judgement on text already in the prompt: with the built-in tools
        // disabled it stays a single turn.
        tools: [],
        allowedTools: [],
        signal: ctx.signal,
        onEvent: ctx.onEvent,
        jsonSchema: {
            type: 'object',
            properties: {
                category: { type: 'string', enum: [...ids, UNMATCHED_PORT] },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                reason: { type: 'string' },
            },
            required: ['category', 'confidence', 'reason'],
            additionalProperties: false,
        },
    });

    if (!result.ok || !result.structured) {
        return {
            outPort: null,
            summary: 'Classification failed',
            error: result.error ?? 'no structured output',
        };
    }

    const answer = result.structured as { category: string; confidence: number; reason: string };
    const chosen = config.categories.find((c) => c.id === answer.category);

    return {
        outPort: chosen ? `cat:${chosen.id}` : UNMATCHED_PORT,
        summary: `${chosen?.label ?? 'Unmatched'} · ${Math.round((answer.confidence ?? 0) * 100)}% — ${answer.reason}`,
    };
}

// ── Processor ────────────────────────────────────────────────────────────

/** How each outcome the agent may report leaves the node. */
const PORT_FOR_OUTCOME: Record<string, string> = { done: 'done', 'needs-review': 'review', failed: 'error' };

async function runProcessor(ctx: NodeContext, config: ProcessorConfig): Promise<NodeOutcome> {
    const actions: string[] = [];
    const server = createEmailToolServer({
        email: ctx.email,
        scratchDir: ctx.scratchDir,
        config,
        onEvent: ctx.onEvent,
        actions,
    });

    const mcpServers: Record<string, McpServerConfig> = { [EMAIL_SERVER_NAME]: server };
    const allowedTools = emailToolNames(config);
    for (const extra of getSettings().mcpServers) {
        if (!extra.enabled || !extra.name.trim()) continue;
        mcpServers[extra.name] = { type: 'stdio', command: extra.command, args: extra.args };
        // Enabled wholesale: the user added the server deliberately, and naming each
        // tool would mean re-listing them on every upgrade.
        allowedTools.push(`mcp__${extra.name}`);
    }
    if (config.allowFileSystem) allowedTools.push('Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash');

    const prompt = [
        config.instruction.trim(),
        '',
        'You are handling exactly one email. Use the `mcp__email__*` tools to work with',
        'it — they are bound to this message and cannot reach any other. Read the full',
        'body before you decide anything.',
        '',
        `Scratch folder for this run (save and read files here): ${ctx.scratchDir}`,
        '',
        '--- Email ---',
        emailContext(ctx.email, ctx.email.body),
        '',
        'When you are finished, return the structured result describing what you did.',
    ].join('\n');

    // The global library lives outside the run's directory, so it arrives as a
    // plugin — and only when this node actually ticks something from it.
    const globalTicks = config.skills.filter(isGlobalRef).map((ref) => ref.slice(GLOBAL_SKILL_PLUGIN.length + 1));
    const plugin = globalTicks.length > 0 ? globalPluginFor(globalTicks) : null;

    const result = await runClaude({
        prompt,
        model: config.model,
        effort: config.effort,
        // The flow's own directory: 'project' is what makes the `.claude/skills`
        // beneath it discoverable, and no other flow's library sits under it.
        cwd: flowDir(ctx.flowId),
        settingSources: ['project'],
        plugins: plugin ? [{ type: 'local', path: plugin.path, skipMcpDiscovery: true }] : undefined,
        // The scratch folder is outside that directory, and saved attachments are
        // the whole point of it.
        additionalDirectories: [ctx.scratchDir],
        // Already in the SDK's own spelling: `global:name` for a plugin skill, a
        // bare name for one of the flow's own.
        skills: config.skills.length > 0 ? config.skills : undefined,
        allowedTools,
        mcpServers,
        signal: ctx.signal,
        onEvent: ctx.onEvent,
        jsonSchema: {
            type: 'object',
            properties: {
                outcome: {
                    type: 'string',
                    enum: ['done', 'needs-review', 'failed'],
                    description:
                        'done: handled, nothing left for a person. needs-review: a person has to decide or check something — say what in the summary. failed: something broke.',
                },
                summary: { type: 'string' },
                actions: { type: 'array', items: { type: 'string' } },
            },
            required: ['outcome', 'summary', 'actions'],
            additionalProperties: false,
        },
    }).finally(() => plugin?.dispose());

    if (!result.ok) {
        return {
            outPort: 'error',
            summary: result.error ?? 'Processing failed',
            error: result.error,
        };
    }

    const answer = (result.structured ?? {}) as {
        outcome?: string;
        summary?: string;
        actions?: string[];
    };
    // Both what the tools recorded and what Claude says it did go in the summary.
    // The tool record wins any argument: it is the one that touched Outlook.
    const performed = actions.length > 0 ? ` [${actions.join('; ')}]` : '';
    const stated = (answer.actions ?? []).join('; ');

    return {
        outPort: PORT_FOR_OUTCOME[answer.outcome ?? ''] ?? 'done',
        summary: `${answer.summary ?? 'Processed'}${performed}${stated ? ` — ${stated}` : ''}`,
    };
}

// ── Terminal ─────────────────────────────────────────────────────────────

async function runTerminal(ctx: NodeContext, config: TerminalConfig): Promise<NodeOutcome> {
    let moved = '';
    if (config.moveToFolder.trim()) {
        try {
            const result = await outlook.moveEmail(ctx.email.ref, config.moveToFolder.trim());
            moved =
                result.moved > 0
                    ? ` · filed in ${result.folderPath}`
                    : ` · could not file (${result.failed.map((f) => f.error).join('; ')})`;
            ctx.onEvent({ at: now(), type: 'outlook', label: `move → ${config.moveToFolder}` });
        } catch (e) {
            moved = ` · could not file (${e instanceof Error ? e.message : String(e)})`;
        }
    }

    return {
        outPort: null,
        disposition: config.disposition,
        summary: `${config.disposition}${moved}`,
    };
}

export async function executeNode(ctx: NodeContext): Promise<NodeOutcome> {
    // Narrowed once here, so no runner re-checks the kind it was chosen for.
    const config = ctx.node.config;
    switch (config.kind) {
        case 'trigger.outlook':
            return runTrigger(config);
        case 'categorizer':
            return runCategorizer(ctx, config);
        case 'processor':
            return runProcessor(ctx, config);
        case 'terminal':
            return runTerminal(ctx, config);
    }
}
