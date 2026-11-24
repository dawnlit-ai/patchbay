import { resolve } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
    type AgentHarness,
    type AgentModel,
    CLAUDE_NOT_INSTALLED,
    clock,
    holdUsage,
    sdkExecutable,
    usageHeldUntil,
    usageLimit,
    waitForUsage,
    withToolPath,
} from '@dawnlit/agent-harness';
import type { ModelOption } from '@shared/ipc';
import { type LiveText, now, truncate } from '@shared/trace';
import { errorMessage } from '@shared/util';
import { folderHook, writeRules } from './folderPolicy';
import type { AgentBackend, AgentHost, AgentMcpServer, AgentRunRequest, AgentRunResult } from './types';

/**
 * Claude through the Claude Agent SDK, and so the one mapping from the SDK's
 * message stream onto a pass's trace events. Where Claude Code is installed, and
 * its models, sign-in and usage, are asked through the agent harness.
 */

/** A model the Claude login offers, as the model lists show it. */
function claudeOption(model: AgentModel): ModelOption {
    return {
        value: model.id,
        resolvedModel: model.resolvedModel,
        // Marked like agy's, as the two share one list.
        displayName: `${model.label} · claude`,
        description: model.description ?? '',
        effortLevels: model.efforts,
    };
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

/** One Messages API streaming event, read structurally like the blocks above. */
interface LooseStreamEvent {
    type: string;
    content_block?: LooseBlock;
    delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
}

/** The block a `content_block_start` opens, as it will be traced once whole. Null for one with nothing to show. */
function liveBlock(block: LooseBlock | undefined): LiveText | null {
    switch (block?.type) {
        case 'text':
            return {type: 'assistant', label: '', text: ''};
        case 'thinking':
            return {type: 'thinking', label: 'thinking', text: ''};
        case 'tool_use':
            return {type: 'tool-call', label: block.name ?? 'tool', text: ''};
        default:
            return null;
    }
}

function renderToolResult(block: LooseBlock): string {
    const {content} = block;
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
 * Built-in tools a step can call again without doing anything twice: they only
 * read. Any tool but these and the request's repeatable ones may have drafted,
 * filed or written a record, so a step cut short after one is not repeated.
 */
const REPEATABLE_TOOLS = ['ToolSearch', 'Skill', 'Read', 'Glob', 'Grep'];

interface Attempt {
    structured?: unknown;
    error?: string;
    /** A tool outside REPEATABLE_TOOLS ran. */
    acted: boolean;
}

/**
 * The run's MCP servers as the SDK takes them. It has no folder of a command's
 * own to start it in — Claude Code starts each in the run's — so a server whose
 * definition names another is refused rather than started where its relative
 * paths lead elsewhere.
 */
function claudeServers(servers: Record<string, AgentMcpServer>, cwd: string): NonNullable<Options['mcpServers']> {
    const out: NonNullable<Options['mcpServers']> = {};
    for (const [name, server] of Object.entries(servers)) {
        if (server.type === 'sdk' || server.type === 'http' || server.type === 'sse') {
            out[name] = server;
        } else {
            if (server.cwd && resolve(server.cwd) !== resolve(cwd)) {
                throw new Error(
                    `MCP server "${name}" has to start in ${server.cwd}, and Claude starts every server in ${cwd}. ` +
                    'Take its cwd out of its definition, or pick an agy model for this node.',
                );
            }
            out[name] = {
                type: 'stdio',
                command: server.command,
                ...(server.args ? {args: server.args} : {}),
                ...(server.env ? {env: server.env} : {}),
            };
        }
    }
    return out;
}

async function runClaude(harness: AgentHarness, host: AgentHost, request: AgentRunRequest): Promise<AgentRunResult> {
    const exe = harness.locate('claude');
    // Unavailable rather than failed: a fallback on another agent can still take the step.
    if (!exe) {
        return {...settle(request, {error: CLAUDE_NOT_INSTALLED, acted: false}), unavailable: CLAUDE_NOT_INSTALLED};
    }

    // Lazy: the SDK pulls in a large dependency graph, and a flow with no AI node
    // should not pay for it.
    const {query} = await import('@anthropic-ai/claude-agent-sdk');

    /** Tool name by tool_use id, so a result can name the call it answers. */
    const toolNames = new Map<string, string>();
    const repeatable = new Set([...REPEATABLE_TOOLS, ...(request.repeatableTools ?? [])]);

    let executable: string;
    let mcpServers: NonNullable<Options['mcpServers']>;
    try {
        // The SDK starts the binary itself, so npm's claude.cmd is followed to what it starts.
        executable = sdkExecutable(exe);
        mcpServers = claudeServers(request.mcpServers ?? {}, request.cwd);
    } catch (e) {
        return settle(request, {error: errorMessage(e), acted: false});
    }

    const options: Options = {
        model: request.model,
        cwd: request.cwd,
        allowedTools: request.allowedTools,
        // Only the servers this app passes in. Otherwise the run would inherit the
        // machine's Claude Code config and behave differently on another desktop.
        strictMcpConfig: true,
        mcpServers,
        // Claude Code finds each server's command on its own PATH, and the server inherits it.
        env: withToolPath(process.env),
        // A background run has no prompting surface, so anything not pre-approved
        // is denied rather than left hanging.
        permissionMode: 'dontAsk',
        // None: a workspace's own Claude Code settings and skills are not a step's.
        settingSources: [],
        persistSession: false,
        includePartialMessages: request.onLive !== undefined,
        pathToClaudeCodeExecutable: executable,
        stderr: (data) => {
            const line = data.trim();
            if (line) request.onEvent({at: now(), type: 'error', label: 'claude stderr', detail: line});
        },
    };

    if (request.skillPlugins?.length) {
        options.plugins = request.skillPlugins.map((path) => ({type: 'local', path, skipMcpDiscovery: true}));
    }
    const directories = [
        ...new Set([...(request.additionalDirectories ?? []), ...(request.folders?.read ?? []), ...(request.folders?.write ?? [])]),
    ];
    if (directories.length > 0) options.additionalDirectories = directories;
    if (request.folders) {
        // The hook refuses whatever reaches outside the folders; the rules let an
        // edit into a write folder, which the hook alone cannot under `dontAsk`.
        options.hooks = {PreToolUse: [{hooks: [folderHook(request.folders, request.skillPlugins ?? [])]}]};
        options.allowedTools = [...request.allowedTools, ...writeRules(request.folders)];
    }
    if (request.tools) options.tools = request.tools;
    if (request.disallowedTools?.length) options.disallowedTools = request.disallowedTools;
    // The SDK's type names only the levels it knew when it was built; the node's
    // came from the CLI's own list for the model.
    if (request.effort) options.effort = request.effort as Options['effort'];
    if (request.skills && request.skills.length > 0) options.skills = request.skills;
    if (request.jsonSchema) options.outputFormat = {type: 'json_schema', schema: request.jsonSchema};
    if (request.signal) {
        const controller = new AbortController();
        // A cancel can land while the SDK loads or the run's servers are set up,
        // before there is a listener to hear it.
        if (request.signal.aborted) controller.abort();
        else request.signal.addEventListener('abort', () => controller.abort(), {once: true});
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
        let live = null as LiveText | null;
        try {
            for await (const message of query({prompt: request.prompt, options})) {
                if (message.type === 'stream_event') {
                    // A subagent's blocks would interleave with this run's own.
                    if (message.parent_tool_use_id) continue;
                    const event = message.event as LooseStreamEvent;
                    if (event.type === 'content_block_start') {
                        live = liveBlock(event.content_block);
                    } else if (event.type === 'content_block_delta' && live) {
                        const {delta} = event;
                        // A thinking block's signature arrives as a delta too, with none of these.
                        const more = delta?.text ?? delta?.thinking ?? delta?.partial_json;
                        if (!more) continue;
                        live = {...live, text: live.text + more};
                        request.onLive?.(live);
                    } else if (event.type === 'content_block_stop' && live) {
                        // The whole block follows as an assistant message.
                        live = null;
                        request.onLive?.(null);
                    }
                    continue;
                }

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
                            request.onEvent({at: now(), type: 'thinking', label: 'thinking', detail: block.thinking});
                        } else if (block.type === 'tool_use') {
                            const name = block.name ?? 'tool';
                            // The answering result quotes this call's id, so the pair can be
                            // labelled in the trace.
                            if (block.id) toolNames.set(block.id, name);
                            if (!repeatable.has(name)) acted = true;
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
            error = errorMessage(e);
        }
        // A block cut off mid-way never arrives whole.
        if (live) request.onLive?.(null);
        return {structured, error, acted};
    };

    for (; ;) {
        const held = usageHeldUntil();
        if (held && request.waitOutLimit === false) {
            const unavailable = `Claude is at its usage limit until ${clock(held)}`;
            return {...settle(request, {error: unavailable, acted: false}), unavailable};
        }
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
            host.warn(`Claude's usage limit was hit, so every run waits until ${clock(limit.until)}`, result.error);
        }
        // Asking again would repeat what those tools did.
        if (result.acted) {
            return settle(request, {
                ...result,
                error: `${result.error} — it came mid-step, after tools that change things had run, so the step is not repeated: run this email again once the limit resets.`,
            });
        }
        if (request.waitOutLimit === false) {
            return {
                ...settle(request, result),
                unavailable: `Claude hit its usage limit, which lifts at ${clock(limit.until)}`
            };
        }
        request.onEvent({at: now(), type: 'error', label: result.error ?? 'usage limit'});
    }
}

function settle(request: AgentRunRequest, {structured, error}: Attempt): AgentRunResult {
    // No structured output means the question went unanswered, whatever text came
    // back with it.
    if (!error && request.jsonSchema && structured === undefined) {
        error = 'Claude returned no structured output for the requested schema.';
    }

    if (error) request.onEvent({at: now(), type: 'error', label: error});

    return {ok: !error, structured, error};
}

/** Claude takes any model another backend does not claim: its aliases carry no prefix. */
export function claudeBackend(host: AgentHost, harness: AgentHarness): AgentBackend {
    return {
        id: 'claude',
        owns: () => true,
        // None while Claude Code is not installed, so the other agents' models still list.
        listModels: async () => (harness.locate('claude') ? (await harness.models('claude')).map(claudeOption) : []),
        // The limit belongs to the login, so it holds every model alike.
        heldUntil: usageHeldUntil,
        status: () => harness.status('claude'),
        run: (request) => runClaude(harness, host, request),
    };
}
