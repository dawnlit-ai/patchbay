import { join } from 'node:path';
import type { FlowNode } from '@shared/flow';
import { UNMATCHED_PORT } from '@shared/flow';
import type { EmailEnvelope, PassCost, TraceEvent } from '@shared/trace';
import { runClaude } from '../claude/runner';
import { createEmailToolServer, EMAIL_SERVER_NAME, emailToolNames } from '../claude/emailTools';
import { getSettings } from '../store/settingsStore';
import { workspaceRoot } from '../paths';
import * as outlook from '../outlook/bridge';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/** What the engine hands a node, and what it expects back. */
export interface NodeContext {
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
    cost?: PassCost;
    /** Set on a terminal node, recorded on the run. */
    disposition?: string;
    error?: string;
}

const now = (): string => new Date().toISOString();

function emailContext(email: EmailEnvelope, body: string | undefined): string {
    return [
        `From: ${email.senderName} <${email.senderEmail}>`,
        `Subject: ${email.subject}`,
        `Received: ${email.receivedTime}`,
        `Attachments: ${email.attachmentNames.join(', ') || '(none)'}`,
        '',
        body ? `--- Body ---\n${body}` : `--- Preview (body not fetched) ---\n${email.bodyPreview}`,
    ].join('\n');
}

// ── Trigger ──────────────────────────────────────────────────────────────
// The email is already in hand by the time a run exists; this pass exists so the
// trace starts where the canvas does.

function runTrigger(ctx: NodeContext): NodeOutcome {
    const config = ctx.node.config;
    if (config.kind !== 'trigger.outlook') throw new Error('not a trigger');
    return {
        outPort: 'out',
        summary: `Received in ${config.account}${config.folder ? `\\${config.folder}` : ' Inbox'}`,
    };
}

// ── Categorizer ──────────────────────────────────────────────────────────

async function runCategorizer(ctx: NodeContext): Promise<NodeOutcome> {
    const config = ctx.node.config;
    if (config.kind !== 'categorizer') throw new Error('not a categorizer');

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
            // A body we could not read is a reason to classify on the preview, not a
            // reason to fail the email.
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
        maxTurns: 4,
        cwd: workspaceRoot(),
        // Classification is one judgement on text already in the prompt. Disabling
        // the built-in tools keeps it to a single turn instead of letting the model
        // reach for a file search it has no use for.
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
            cost: result.cost,
            error: result.error ?? 'no structured output',
        };
    }

    const answer = result.structured as { category: string; confidence: number; reason: string };
    const chosen = config.categories.find((c) => c.id === answer.category);
    const label = chosen?.label ?? 'Unmatched';
    const port = chosen ? `cat:${chosen.id}` : UNMATCHED_PORT;

    return {
        outPort: port,
        summary: `${label} · ${Math.round((answer.confidence ?? 0) * 100)}% — ${answer.reason}`,
        cost: result.cost,
    };
}

// ── Processor ────────────────────────────────────────────────────────────

async function runProcessor(ctx: NodeContext): Promise<NodeOutcome> {
    const config = ctx.node.config;
    if (config.kind !== 'processor') throw new Error('not a processor');

    const actions: string[] = [];
    const server = createEmailToolServer({
        email: ctx.email,
        scratchDir: ctx.scratchDir,
        config,
        onEvent: ctx.onEvent,
        actions,
    });

    const mcpServers: Record<string, McpServerConfig> = { [EMAIL_SERVER_NAME]: server };
    for (const extra of getSettings().mcpServers) {
        if (!extra.enabled || !extra.name.trim()) continue;
        mcpServers[extra.name] = { type: 'stdio', command: extra.command, args: extra.args };
    }

    const allowedTools = [...emailToolNames(config)];
    // Extra MCP servers are enabled wholesale — the user added them deliberately,
    // and naming every tool would mean re-listing them on each upgrade.
    for (const extra of getSettings().mcpServers) {
        if (extra.enabled && extra.name.trim()) allowedTools.push(`mcp__${extra.name}`);
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

    const result = await runClaude({
        prompt,
        model: config.model,
        effort: config.effort,
        maxTurns: config.maxTurns,
        maxBudgetUsd: config.maxBudgetUsd,
        cwd: workspaceRoot(),
        // 'project' is what makes the workspace's .claude/skills discoverable.
        settingSources: ['project'],
        skills: config.skills.length > 0 ? config.skills : undefined,
        allowedTools,
        mcpServers,
        signal: ctx.signal,
        onEvent: ctx.onEvent,
        jsonSchema: {
            type: 'object',
            properties: {
                outcome: { type: 'string', enum: ['done', 'needs-review', 'failed'] },
                summary: { type: 'string' },
                actions: { type: 'array', items: { type: 'string' } },
            },
            required: ['outcome', 'summary', 'actions'],
            additionalProperties: false,
        },
    });

    if (!result.ok) {
        return {
            outPort: 'error',
            summary: result.error ?? 'Processing failed',
            cost: result.cost,
            error: result.error,
        };
    }

    const answer = (result.structured ?? {}) as {
        outcome?: string;
        summary?: string;
        actions?: string[];
    };
    // Two sources of truth for what happened: what Claude says it did, and what
    // the tools actually recorded. Both go in the summary; the tool record wins
    // any argument, because it is the one that touched Outlook.
    const performed = actions.length > 0 ? ` [${actions.join('; ')}]` : '';
    const stated = (answer.actions ?? []).join('; ');

    return {
        outPort: answer.outcome === 'failed' ? 'error' : 'done',
        summary: `${answer.summary ?? 'Processed'}${performed}${stated ? ` — ${stated}` : ''}`,
        cost: result.cost,
    };
}

// ── Terminal ─────────────────────────────────────────────────────────────

async function runTerminal(ctx: NodeContext): Promise<NodeOutcome> {
    const config = ctx.node.config;
    if (config.kind !== 'terminal') throw new Error('not a terminal');

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
    switch (ctx.node.kind) {
        case 'trigger.outlook':
            return runTrigger(ctx);
        case 'categorizer':
            return runCategorizer(ctx);
        case 'processor':
            return runProcessor(ctx);
        case 'terminal':
            return runTerminal(ctx);
    }
}

export const scratchFor = (runsRoot: string, runId: string): string => join(runsRoot, `${runId}.files`);
