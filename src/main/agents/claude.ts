import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
    AccountInfo,
    Options,
    Query,
    SDKControlGetUsageResponse,
    SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentStatus, ModelOption, UsageWindow } from '@shared/ipc';
import { now, truncate } from '@shared/trace';
import type { AgentBackend, AgentHost, AgentRunRequest, AgentRunResult } from './types';
import { holdUsage, usageHeldUntil, usageLimit, waitForUsage } from './usageGate';

/**
 * Claude through the Claude Agent SDK, and so the one mapping from the SDK's
 * message stream onto a pass's trace events.
 */

/**
 * The `claude` binary: the one the host names, else an existing Claude Code
 * install (saves a ~200MB download), else undefined for the SDK's own.
 */
function resolveClaudePath(configured: string | undefined): string | undefined {
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

/** Asks the CLI something about itself, in a session that never runs a turn. */
async function askIdle<T>(exe: string | undefined, ask: (q: Query) => Promise<T>): Promise<T> {
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
            // What a run is started with, so the answer is the one a run would get.
            pathToClaudeCodeExecutable: exe,
            settingSources: [],
            strictMcpConfig: true,
            mcpServers: {},
            tools: [],
            persistSession: false,
        },
    });
    try {
        return await ask(q);
    } finally {
        release();
        q.close();
    }
}

async function askForModels(exe: string | undefined): Promise<ModelOption[]> {
    const models = await askIdle(exe, (q) => q.supportedModels());
    return models.map((m) => ({
        value: m.value,
        resolvedModel: m.resolvedModel,
        // Marked like agy's, as the two share one list.
        displayName: `${m.displayName} · claude`,
        description: m.description,
        effortLevels: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
    }));
}

/** The models the Claude login offers, asked of the CLI so the list never goes stale. */
function listModels(exe: string | undefined): Promise<ModelOption[]> {
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

/** Long enough for the SDK to unpack its own copy of Claude Code on a first start. */
const STATUS_TIMEOUT_MS = 30_000;

function within<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${STATUS_TIMEOUT_MS / 1000} seconds`)), STATUS_TIMEOUT_MS);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** "2.1.288" from `claude --version`'s "2.1.288 (Claude Code)". */
async function versionOf(exe: string): Promise<string | null> {
    try {
        const { stdout } = await promisify(execFile)(exe, ['--version'], { timeout: STATUS_TIMEOUT_MS });
        return stdout.trim().split(/\s+/)[0] || null;
    } catch {
        return null;
    }
}

/** Who a run would be billed to, or null when it has nothing to sign its requests with. */
function signedInAs(account: AccountInfo): string | null {
    if (account.email) return [`Signed in as ${account.email}`, account.subscriptionType].filter(Boolean).join(' · ');
    if (account.apiKeySource && account.apiKeySource !== 'none') return `Using an API key from ${account.apiKeySource}`;
    // Bedrock, Vertex and the rest sign requests with their own cloud credentials.
    if (account.apiProvider && account.apiProvider !== 'firstParty') return `Through ${account.apiProvider}`;
    return null;
}

/** The plan's limits that carry a figure, each as "<models> · <window>". None for an API key. */
function planUsage(usage: SDKControlGetUsageResponse | null): UsageWindow[] {
    const limits = usage?.rate_limits;
    if (!limits) return [];
    type Limit = { utilization: number | null; resets_at: string | null } | null | undefined;
    const named: [string, Limit][] = [
        ['All models · 5 hours', limits.five_hour],
        ['All models · week', limits.seven_day],
        ['Opus · week', limits.seven_day_opus],
        ['Sonnet · week', limits.seven_day_sonnet],
        ...(limits.model_scoped ?? []).map((m): [string, Limit] => [`${m.display_name} · week`, m]),
    ];
    return named.flatMap(([label, limit]) =>
        limit && limit.utilization !== null ? [{ label, percentUsed: limit.utilization, resetsAt: limit.resets_at }] : [],
    );
}

/** The binary a run would start, its version, whether it is signed in, and its plan's usage — asked as a run would. */
async function claudeStatus(exe: string | undefined): Promise<AgentStatus> {
    const base = { id: 'claude', name: 'Claude Code', executable: exe ?? '' };
    const asked = askIdle(exe, async (q) => {
        const account = await q.accountInfo();
        // Experimental in the SDK, so a CLI that cannot answer it just shows no usage.
        const usage = signedInAs(account)
            ? await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => null)
            : null;
        return { account, usage };
    });
    const [version, answer] = await Promise.all([
        exe ? versionOf(exe) : Promise.resolve(null),
        within(asked, 'Claude Code').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    ]);
    if (answer instanceof Error) {
        const missing = exe !== undefined && /ENOENT|not found/i.test(answer.message);
        return {
            ...base,
            version,
            ready: false,
            detail: missing ? `Not found at ${exe}.` : `It did not start: ${answer.message}`,
            usage: [],
        };
    }
    const who = signedInAs(answer.account);
    return {
        ...base,
        version,
        ready: who !== null,
        detail: who ?? 'Not signed in. Run claude in a terminal and sign in with /login.',
        usage: planUsage(answer.usage),
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

const clock = (at: number): string => new Date(at).toLocaleString();

async function runClaude(host: AgentHost, request: AgentRunRequest): Promise<AgentRunResult> {
    // Lazy: the SDK pulls in a large dependency graph, and a flow with no AI node
    // should not pay for it.
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    /** Tool name by tool_use id, so a result can name the call it answers. */
    const toolNames = new Map<string, string>();
    const repeatable = new Set([...REPEATABLE_TOOLS, ...(request.repeatableTools ?? [])]);

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
        pathToClaudeCodeExecutable: resolveClaudePath(host.claudeExecutable()),
        stderr: (data) => {
            const line = data.trim();
            if (line) request.onEvent({ at: now(), type: 'error', label: 'claude stderr', detail: line });
        },
    };

    if (request.skillPlugins?.length) {
        options.plugins = request.skillPlugins.map((path) => ({ type: 'local', path, skipMcpDiscovery: true }));
    }
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
            host.warn(`Claude's usage limit was hit, so every run waits until ${clock(limit.until)}`, result.error);
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

function settle(request: AgentRunRequest, { structured, error }: Attempt): AgentRunResult {
    // No structured output means the question went unanswered, whatever text came
    // back with it.
    if (!error && request.jsonSchema && structured === undefined) {
        error = 'Claude returned no structured output for the requested schema.';
    }

    if (error) request.onEvent({ at: now(), type: 'error', label: error });

    return { ok: !error, structured, error };
}

/** Claude takes any model another backend does not claim: its aliases carry no prefix. */
export function claudeBackend(host: AgentHost): AgentBackend {
    return {
        owns: () => true,
        listModels: () => listModels(resolveClaudePath(host.claudeExecutable())),
        status: () => claudeStatus(resolveClaudePath(host.claudeExecutable())),
        run: (request) => runClaude(host, request),
    };
}
