import { z } from 'zod';
import {
    type CategorizerConfig,
    type ExtractorConfig,
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
    /** Slots earlier nodes on this path filled, by name. */
    data: Readonly<Record<string, unknown>>;
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
    /** Slots this node filled, by name, for the nodes after it. */
    provided?: Record<string, unknown>;
    error?: string;
}

function emailContext(email: EmailEnvelope, body: string | undefined): string {
    return [
        ...emailHeader(email),
        '',
        body ? `--- Body ---\n${body}` : `--- Preview (body not fetched) ---\n${email.bodyPreview}`,
    ].join('\n');
}

/** The slots a node reads, as JSON blocks after the email. */
function slotContext(ctx: NodeContext, names: string[]): string[] {
    return names.flatMap((name) => [
        '',
        `--- ${name} (filled by an earlier node in this flow) ---`,
        JSON.stringify(ctx.data[name] ?? null, null, 2),
    ]);
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

// ── Extractor ────────────────────────────────────────────────────────────

/** How much of the body goes into an Extractor's prompt. */
const EXTRACT_BODY_CHARS = 50_000;

async function runExtractor(ctx: NodeContext, config: ExtractorConfig): Promise<NodeOutcome> {
    // Read up front, so an extraction from the body alone is a single turn.
    let body = ctx.email.body;
    if (body === undefined) {
        try {
            const result = await outlook.readBody(ctx.email.ref, EXTRACT_BODY_CHARS);
            body = result.body;
            ctx.email.body = result.body;
            ctx.onEvent({ at: now(), type: 'outlook', label: `Read body (${result.bodyLength} characters)` });
        } catch (e) {
            return {
                outPort: 'error',
                summary: 'Could not read the body',
                error: e instanceof Error ? e.message : String(e)
            };
        }
    }

    // Built before Claude is asked, so a schema zod cannot follow fails fast.
    let validator: z.ZodType;
    try {
        validator = z.fromJSONSchema(config.schema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (e) {
        const message = `The schema cannot be used: ${e instanceof Error ? e.message : String(e)}`;
        return { outPort: 'error', summary: message, error: message };
    }

    const capabilities = {
        readEmail: true,
        allowSaveAttachments: config.includeAttachments,
        allowDraftReply: false,
        allowMoveEmail: false,
    };
    const server = createEmailToolServer({
        email: ctx.email,
        scratchDir: ctx.scratchDir,
        config: capabilities,
        onEvent: ctx.onEvent,
        actions: [],
    });
    const allowedTools = emailToolNames(capabilities);
    if (config.includeAttachments) allowedTools.push('Read');

    const prompt = [
        'Extract the data described by the schema of `data` from the email below.',
        config.instruction.trim(),
        '',
        'Take every value from the email itself. When the email does not give a field, do',
        'not guess one: leave it out if the schema allows that, or give an empty value if it',
        'does not, and list the field\'s path (e.g. "containers.0.number") in `missing`.',
        config.includeAttachments
            ? 'The attachments may hold what the body does not: save the ones that could, with `mcp__email__save_attachment`, and read them with Read.'
            : 'Work from the body alone; the attachments are not available here.',
        '',
        '--- Email ---',
        emailContext(ctx.email, body),
    ].join('\n');

    const result = await runClaude({
        prompt,
        model: config.model,
        effort: config.effort,
        cwd: flowDir(ctx.flowId),
        additionalDirectories: config.includeAttachments ? [ctx.scratchDir] : undefined,
        tools: config.includeAttachments ? ['Read'] : [],
        allowedTools,
        mcpServers: { [EMAIL_SERVER_NAME]: server },
        signal: ctx.signal,
        onEvent: ctx.onEvent,
        jsonSchema: {
            type: 'object',
            properties: {
                data: config.schema,
                missing: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Path of every field the email did not give.',
                },
                note: { type: 'string', description: 'Anything a person should know about this extraction.' },
            },
            required: ['data', 'missing', 'note'],
            additionalProperties: false,
        },
    });

    if (!result.ok) {
        return { outPort: 'error', summary: result.error ?? 'Extraction failed', error: result.error };
    }

    const answer = (result.structured ?? {}) as { data?: unknown; missing?: string[]; note?: string };
    ctx.onEvent({
        at: now(),
        type: 'note',
        label: `Extracted ${config.output}`,
        detail: JSON.stringify(answer, null, 2),
    });

    const checked = validator.safeParse(answer.data);
    const problems = [
        ...(answer.missing ?? []).map((path) => `${path}: not in the email`),
        ...(checked.success ? [] : checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)),
    ];
    const note = answer.note?.trim() ? ` — ${answer.note.trim()}` : '';
    if (problems.length > 0) {
        return { outPort: 'invalid', summary: `${config.output} incomplete: ${problems.join('; ')}${note}` };
    }
    return {
        outPort: 'valid',
        summary: `${config.output} extracted${note}`,
        provided: { [config.output]: answer.data },
    };
}

// ── Processor ────────────────────────────────────────────────────────────

/** How each outcome the agent may report leaves the node. */
const PORT_FOR_OUTCOME: Record<string, string> = { done: 'done', 'needs-review': 'review', failed: 'error' };

async function runProcessor(ctx: NodeContext, config: ProcessorConfig): Promise<NodeOutcome> {
    // Built before Claude is asked, as the Extractor does, so a bad schema costs no run.
    let validator: z.ZodType | undefined;
    if (config.output) {
        try {
            validator = z.fromJSONSchema(config.schema as Parameters<typeof z.fromJSONSchema>[0]);
        } catch (e) {
            const message = `The schema of ${config.output} cannot be used: ${e instanceof Error ? e.message : String(e)}`;
            return { outPort: 'error', summary: message, error: message };
        }
    }

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

    const acting = config.allowDraftReply || config.allowMoveEmail;
    const prompt = [
        config.instruction.trim(),
        '',
        ...(config.readEmail
            ? [
                'You are handling exactly one email. Use the `mcp__email__*` tools to work with',
                'it — they are bound to this message and cannot reach any other. Read the full',
                'body before you decide anything.',
            ]
            : [
                'You are working from the data below, which earlier steps took from one email;',
                'the email itself is not yours to read.',
                ...(acting
                    ? ['The `mcp__email__*` tools act on that email and cannot reach any other.']
                    : []),
            ]),
        '',
        `Scratch folder for this run (save and read files here): ${ctx.scratchDir}`,
        ...(config.readEmail ? ['', '--- Email ---', emailContext(ctx.email, ctx.email.body)] : []),
        ...slotContext(ctx, config.inputs),
        '',
        'When you are finished, return the structured result describing what you did.',
        ...(config.output
            ? [
                `With the outcome "done", put your result in \`data\`: the nodes after this one read it`,
                `as "${config.output}", and it is all of your work they get. Leave \`data\` out otherwise.`,
            ]
            : []),
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
                // Optional in the shape, since a run that stops for review has
                // nothing to hand on; Done without it is caught below.
                ...(config.output ? { data: config.schema } : {}),
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
        data?: unknown;
    };
    // Both what the tools recorded and what Claude says it did go in the summary.
    // The tool record wins any argument: it is the one that touched Outlook.
    const performed = actions.length > 0 ? ` [${actions.join('; ')}]` : '';
    const stated = (answer.actions ?? []).join('; ');
    const summary = `${answer.summary ?? 'Processed'}${performed}${stated ? ` — ${stated}` : ''}`;
    const outPort = PORT_FOR_OUTCOME[answer.outcome ?? ''] ?? 'done';

    if (!validator) return { outPort, summary };

    if (answer.data !== undefined) {
        ctx.onEvent({
            at: now(),
            type: 'note',
            label: `Filled ${config.output}`,
            detail: JSON.stringify(answer.data, null, 2),
        });
    }
    if (outPort !== 'done') return { outPort, summary };

    // The nodes after Done read this slot unconditionally, so a result that
    // doesn't match is a broken run rather than a thinner one.
    const checked = answer.data === undefined ? null : validator.safeParse(answer.data);
    if (!checked?.success) {
        const problems = checked
            ? checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
            : 'it returned none';
        const message = `Finished as done, but ${config.output} does not match its schema: ${problems}`;
        return { outPort: 'error', summary: `${message} — ${summary}`, error: message };
    }
    return { outPort, summary, provided: { [config.output]: answer.data } };
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
        case 'extractor':
            return runExtractor(ctx, config);
        case 'processor':
            return runProcessor(ctx, config);
        case 'terminal':
            return runTerminal(ctx, config);
    }
}
