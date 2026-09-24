import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig, Options, SdkPluginConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel } from '@shared/flow';
import { now, type TraceEvent, truncate } from '@shared/trace';
import { getSettings } from '../store/settingsStore';

/**
 * The one place this app talks to Claude. Both AI node kinds come through here —
 * the Categorizer for a single structured answer with no tools, the Processor
 * for a full agent loop — so there is exactly one mapping from the SDK's message
 * stream onto the trace events a pass records.
 */

export interface ClaudeRunRequest {
    prompt: string;
    model: string;
    effort?: EffortLevel;
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
    text: string;
    error?: string;
}

/**
 * Where the `claude` binary lives. An explicit setting wins; otherwise prefer an
 * existing Claude Code install, which saves re-downloading the ~200MB platform
 * binary. Undefined lets the SDK resolve its own.
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

export async function runClaude(request: ClaudeRunRequest): Promise<ClaudeRunResult> {
    // Lazy: the SDK pulls in a large dependency graph, and a flow with no AI node
    // should not pay for it.
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    let structured: unknown;
    let text = '';
    let error: string | undefined;
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
    if (request.effort) options.effort = request.effort;
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
                        text += block.text;
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
                    if (typeof message.result === 'string' && message.result) text = message.result;
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

    // No structured output means the question went unanswered, whatever text came
    // back with it.
    if (!error && request.jsonSchema && structured === undefined) {
        error = 'Claude returned no structured output for the requested schema.';
    }

    if (error) request.onEvent({ at: now(), type: 'error', label: error });

    return { ok: !error, structured, text, error };
}
