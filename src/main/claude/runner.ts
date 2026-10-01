import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
    McpServerConfig,
    Options,
    SdkPluginConfig,
    SDKUserMessage,
    SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { isAgyModel } from '@shared/flow';
import type { ModelOption } from '@shared/ipc';
import { now, type TraceEvent, truncate } from '@shared/trace';
import { log } from '../log';
import { getSettings } from '../store/settingsStore';
import { EMAIL_SERVER_NAME } from './emailTools';
import { runAgy } from './agy';
import { holdUsage, usageHeldUntil, usageLimit, waitForUsage } from './usageGate';

/**
 * The one place the app talks to Claude, and so the one mapping from the SDK's
 * message stream onto a pass's trace events.
 */

export interface ClaudeRunRequest {
    prompt: string;
    model: string;
    /** One of the levels Claude Code lists for the model. Empty or absent leaves it to the model's default. */
    effort?: string;
    /** Agent SDK cwd. Must be the flow's directory, so its `.claude/skills` is discoverable. */
    cwd: string;
    /** Absolute paths the run may touch beyond `cwd` — the run's scratch folder. */
    additionalDirectories?: string[];
    /**
     * Skill directories outside `cwd`, each as a local plugin — the only way the
     * SDK loads skills a run's own working directory does not hold.
     */
    plugins?: SdkPluginConfig[];
    skills?: string[];
    allowedTools: string[];
    /** `[]` disables every built-in tool — right for a pure classification call. */
    tools?: string[];
    /**
     * Built-in tools taken out of the run altogether. Stronger than leaving them
     * out of `allowedTools`: `dontAsk` still lets read-only shell commands through.
     */
    disallowedTools?: string[];
    mcpServers?: Record<string, McpServerConfig>;
    /** When set, the run is constrained to this shape and `structured` is filled. */
    jsonSchema?: Record<string, unknown>;
    settingSources?: SettingSource[];
    signal?: AbortSignal;

    onEvent(event: TraceEvent): void;
}

export interface ClaudeRunResult {
    ok: boolean;
    structured?: unknown;
    error?: string;
}

/**
 * The `claude` binary: the setting, else an existing Claude Code install (saves a
 * ~200MB download), else undefined for the SDK's own.
 */
export function resolveClaudePath(): string | undefined {
    const configured = getSettings().claudeExecutablePath.trim();
    if (configured) return configured;
    const candidates =
        process.platform === 'win32'
            ? [join(homedir(), '.local', 'bin', 'claude.exe')]
            : [join(homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude'];
    return candidates.find((p) => existsSync(p));
}

/** How long a model list is reused; Claude Code can update itself while the app runs. */
const MODELS_TTL_MS = 10 * 60_000;

let modelsAsked: { exe: string | undefined; at: number; list: Promise<ModelOption[]> } | null = null;

async function askForModels(exe: string | undefined): Promise<ModelOption[]> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    // A prompt stream that never yields: the CLI answers control requests and is
    // closed before it runs anything, so asking costs nothing.
    let release = (): void => {
    };
    const held = new Promise<void>((resolve) => (release = resolve));

    async function* nothing(): AsyncGenerator<SDKUserMessage> {
        await held;
    }

    const q = query({
        prompt: nothing(),
        options: {
            // What a run is started with, so the list is the one a run can use.
            pathToClaudeCodeExecutable: exe,
            settingSources: [],
            strictMcpConfig: true,
            mcpServers: {},
            tools: [],
            persistSession: false,
        },
    });
    try {
        const models = await q.supportedModels();
        return models.map((m) => ({
            value: m.value,
            resolvedModel: m.resolvedModel,
            displayName: m.displayName,
            description: m.description,
            effortLevels: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
        }));
    } finally {
        release();
        q.close();
    }
}

/** The models the Claude login offers, asked of the CLI so the list never goes stale. */
export function listModels(): Promise<ModelOption[]> {
    const exe = resolveClaudePath();
    if (modelsAsked && modelsAsked.exe === exe && Date.now() - modelsAsked.at < MODELS_TTL_MS) {
        return modelsAsked.list;
    }
    const asked = { exe, at: Date.now(), list: askForModels(exe) };
    modelsAsked = asked;
    // A failure is not kept: once Claude Code is installed or logged in, the next
    // ask should find out.
    asked.list.catch(() => {
        if (modelsAsked === asked) modelsAsked = null;
    });
    return asked.list;
}

/** Content blocks arrive as a loose union; read them structurally. */
interface LooseBlock {
    type: string;
    id?: string;
    text?: string;
    thinking?: string;
    name?: string;
    input?: unknown;
    content?: unknown;
    is_error?: boolean;
    tool_use_id?: string;
}

function blocksOf(message: unknown): LooseBlock[] {
    const content = (message as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) ? (content as LooseBlock[]) : [];
}

function renderToolResult(block: LooseBlock): string {
    const { content } = block;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                const p = part as { type?: string; text?: string };
                return p.type === 'text' ? (p.text ?? '') : `[${p.type ?? 'block'}]`;
            })
            .join('\n');
    }
    return JSON.stringify(content ?? null);
}

/**
 * Tools a step can call again without doing anything twice: they read, or write
 * only into the run's own folder. Any other tool may have drafted, filed or
 * written a record, so a step cut short after one is not repeated.
 */
const REPEATABLE_TOOLS = new Set([
    'ToolSearch',
    'Skill',
    'Read',
    'Glob',
    'Grep',
    ...['read_email', 'record_note', 'save_file', 'save_attachment'].map((t) => `mcp__${EMAIL_SERVER_NAME}__${t}`),
]);

interface Attempt {
    structured?: unknown;
    error?: string;
    /** A tool outside REPEATABLE_TOOLS ran. */
    acted: boolean;
}

const clock = (at: number): string => new Date(at).toLocaleString();

export async function runClaude(request: ClaudeRunRequest): Promise<ClaudeRunResult> {
    if (isAgyModel(request.model)) return runAgy(request);

    // Lazy: the SDK pulls in a large dependency graph, and a flow with no AI node
    // should not pay for it.
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    /** Tool name by tool_use id, so a result can name the call it answers. */
    const toolNames = new Map<string, string>();

    const options: Options = {
        model: request.model,
        cwd: request.cwd,
        allowedTools: request.allowedTools,
        // Only the servers this app passes in. Otherwise the run would inherit the
        // machine's Claude Code config and behave differently on another desktop.
        strictMcpConfig: true,
        mcpServers: request.mcpServers ?? {},
        // A background run has no prompting surface, so anything not pre-approved
        // is denied rather than left hanging.
        permissionMode: 'dontAsk',
        settingSources: request.settingSources ?? [],
        persistSession: false,
        includePartialMessages: false,
        pathToClaudeCodeExecutable: resolveClaudePath(),
        stderr: (data) => {
            const line = data.trim();
            if (line) request.onEvent({ at: now(), type: 'error', label: 'claude stderr', detail: line });
        },
    };

    if (request.plugins?.length) options.plugins = request.plugins;
    if (request.additionalDirectories?.length) {
        options.additionalDirectories = request.additionalDirectories;
    }
    if (request.tools) options.tools = request.tools;
    if (request.disallowedTools?.length) options.disallowedTools = request.disallowedTools;
    // The SDK's type names only the levels it knew when it was built; the node's
    // came from the CLI's own list for the model.
    if (request.effort) options.effort = request.effort as Options['effort'];
    if (request.skills && request.skills.length > 0) options.skills = request.skills;
    if (request.jsonSchema) options.outputFormat = { type: 'json_schema', schema: request.jsonSchema };
    if (request.signal) {
        const controller = new AbortController();
        request.signal.addEventListener('abort', () => controller.abort(), { once: true });
        options.abortController = controller;
    }

    request.onEvent({
        at: now(),
        type: 'prompt',
        label: `Prompt to ${request.model}`,
        detail: truncate(request.prompt, 20_000),
    });

    const attempt = async (): Promise<Attempt> => {
        let structured: unknown;
        let error: string | undefined;
        let acted = false;
        try {
            for await (const message of query({ prompt: request.prompt, options })) {
                if (message.type === 'system' && message.subtype === 'init') {
                    request.onEvent({
                        at: now(),
                        type: 'note',
                        label: `Session ready — ${message.tools.length} tools, ${message.skills.length} skills`,
                        detail: [
                            `model: ${message.model}`,
                            `cwd: ${message.cwd}`,
                            `skills: ${message.skills.join(', ') || '(none)'}`,
                            `mcp: ${message.mcp_servers.map((s) => `${s.name}=${s.status}`).join(', ') || '(none)'}`,
                        ].join('\n'),
                    });
                    continue;
                }

                if (message.type === 'assistant') {
                    for (const block of blocksOf(message.message)) {
                        if (block.type === 'text' && block.text?.trim()) {
                            request.onEvent({
                                at: now(),
                                type: 'assistant',
                                label: block.text.trim().slice(0, 160),
                                detail: block.text
                            });
                        } else if (block.type === 'thinking' && block.thinking?.trim()) {
                            request.onEvent({ at: now(), type: 'thinking', label: 'thinking', detail: block.thinking });
                        } else if (block.type === 'tool_use') {
                            const name = block.name ?? 'tool';
                            // The answering result quotes this call's id, so the pair can be
                            // labelled in the trace.
                            if (block.id) toolNames.set(block.id, name);
                            if (!REPEATABLE_TOOLS.has(name)) acted = true;
                            request.onEvent({
                                at: now(),
                                type: 'tool-call',
                                label: name,
                                detail: truncate(JSON.stringify(block.input ?? {}, null, 2)),
                            });
                        }
                    }
                    continue;
                }

                if (message.type === 'user') {
                    for (const block of blocksOf(message.message)) {
                        if (block.type !== 'tool_result') continue;
                        const name = (block.tool_use_id && toolNames.get(block.tool_use_id)) || 'tool';
                        request.onEvent({
                            at: now(),
                            type: 'tool-result',
                            label: `${name} → ${block.is_error ? 'error' : 'ok'}`,
                            detail: truncate(renderToolResult(block)),
                        });
                    }
                    continue;
                }

                if (message.type === 'result') {
                    if (message.subtype === 'success') {
                        structured = message.structured_output;
                    } else {
                        error = `Claude ended with "${message.subtype}"`;
                    }
                }
            }
        } catch (e) {
            // query() throws after yielding a non-success result, so the events captured
            // above stay — this only fills in the message.
            error = e instanceof Error ? e.message : String(e);
        }
        return { structured, error, acted };
    };

    for (; ;) {
        const held = usageHeldUntil();
        if (held) {
            request.onEvent({
                at: now(),
                type: 'note',
                label: `Waiting for Claude's usage limit to reset at ${clock(held)}`
            });
        }
        try {
            await waitForUsage(request.signal);
        } catch {
            return settle(request, {
                error: 'Cancelled while waiting for Claude’s usage limit to reset.',
                acted: false
            });
        }

        const result = await attempt();
        const limit = result.error ? usageLimit(result.error) : null;
        if (!limit) return settle(request, result);
        if (holdUsage(limit)) {
            log.warn('run', `Claude's usage limit was hit, so every run waits until ${clock(limit.until)}`, {
                detail: result.error,
            });
        }
        // Asking again would repeat what those tools did.
        if (result.acted) {
            return settle(request, {
                ...result,
                error: `${result.error} — it came mid-step, after tools that change things had run, so the step is not repeated: run this email again once the limit resets.`,
            });
        }
        request.onEvent({ at: now(), type: 'error', label: result.error ?? 'usage limit' });
    }
}

function settle(request: ClaudeRunRequest, { structured, error }: Attempt): ClaudeRunResult {
    // No structured output means the question went unanswered, whatever text came
    // back with it.
    if (!error && request.jsonSchema && structured === undefined) {
        error = 'Claude returned no structured output for the requested schema.';
    }

    if (error) request.onEvent({ at: now(), type: 'error', label: error });

    return { ok: !error, structured, error };
}
