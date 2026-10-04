import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { AGY_LEVEL_SUFFIX, AGY_LEVELS, AGY_MODEL_PREFIX, isAgyModel } from '@shared/flow';
import type { AgentStatus, ModelOption, UsageWindow } from '@shared/ipc';
import { now, truncate } from '@shared/trace';
import { serveOnLoopback } from './loopback';
import type { AgentBackend, AgentHost, AgentMcpServer, AgentRunRequest, AgentRunResult } from './types';
import { clock } from './usageGate';

/**
 * The models the Antigravity CLI (`agy`) offers — Gemini, and the Claude and GPT
 * models beside it, each group on a quota of its own — for a node whose model is
 * stored as `agy:<id>`. Each run gets a workspace of its own, and a plugin in it
 * that hands agy the run's MCP servers and its ticked skills, with a hook that
 * refuses every tool the node was not given: agy has no switch to leave its own
 * shell, browser or web search out. The hook can refuse but not grant. Headless,
 * agy calls an MCP tool only when the user's own agy settings allow it, so each
 * needs a rule there.
 */

/**
 * The `agy` binary: the one the host names, else where agy installs itself, as
 * an app opened from the Finder has no shell PATH to find it by.
 */
function resolveAgyPath(configured: string | undefined): string {
    if (configured) return configured;
    const candidates =
        process.platform === 'win32'
            ? [join(homedir(), '.local', 'bin', 'agy.exe')]
            : [join(homedir(), '.local', 'bin', 'agy'), '/usr/local/bin/agy'];
    return candidates.find((p) => existsSync(p)) ?? 'agy';
}

/** How long to wait before asking again after an outage, once per entry. */
const RETRY_DELAYS_MS = [5_000, 30_000];

/** What a failure caused by the network or Google's side, rather than by the step, says. */
const OUTAGE = /dial tcp|no such host|connection (?:refused|reset)|i\/o timeout|deadline exceeded|unexpected EOF|\b50[234]\b|UNAVAILABLE/i;

/** What a failure because the model's quota is used up says, beyond what `/usage` shows. */
const QUOTA = /RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit|usage limit/i;

interface Attempt {
    result?: StreamLine['result'];
    exited?: Exited;
    spawnError?: NodeJS.ErrnoException;
    /** The rules an MCP call the hook let through would need in agy's settings. */
    grants: Set<string>;
    /** An MCP tool outside the request's repeatable ones ran. */
    acted: boolean;
}

/** Why an attempt failed for reasons outside the step, if it did: worth asking again. */
function outageIn({ result, exited, spawnError }: Attempt): string | null {
    if (spawnError || result?.status === 'SUCCESS') return null;
    const message = `${result?.error ?? ''} ${exited?.stderr ?? ''}`;
    // A used-up quota lasts hours, so asking again in seconds is no use.
    if (QUOTA.test(message)) return null;
    if (!result) return `no result, exit ${exited?.code}`;
    return OUTAGE.exec(message)?.[0] ?? null;
}

/** Where agy keeps the rules a headless run's MCP calls need. */
const AGY_SETTINGS = '~/.gemini/antigravity-cli/settings.json';

/** The plugin a run's servers arrive under: agy names each one `patchbay_<server>`. */
const PLUGIN = 'patchbay';
const agyServer = (server: string): string => `${PLUGIN}_${server}`;

/** agy's own tools a step may use, within its folders; `finish` is what carries the result. */
const READ_TOOLS = ['view_file', 'list_dir', 'grep_search', 'find_by_name'];

/** What would need a shell or file-write rule in agy's settings, which a run is never given. */
const FILE_SYSTEM_TOOLS = ['Write', 'Edit', 'Bash'];

/**
 * The PreToolUse hook: decides each call against policy.json beside it. Run by
 * this app's own binary as Node, since a machine with agy need not have Node.
 */
const HOOK = `
const { readFileSync } = require("node:fs");
const { isAbsolute, join, relative, resolve } = require("node:path");
const policy = JSON.parse(readFileSync(__dirname + "/policy.json", "utf8"));
const { toolCall = {}, conversationId } = JSON.parse(readFileSync(0, "utf8"));
const { name, args = {} } = toolCall;
// agy leaves a long tool result in this conversation's own folder for the model to read.
const roots = conversationId ? [...policy.roots, join(policy.brain, conversationId)] : policy.roots;
const within = (p) => roots.some((root) => {
    const r = relative(root, resolve(policy.workspace, p));
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
});
function refusal() {
    if (name === "call_mcp_tool") {
        const id = args.ServerName + "/" + args.ToolName;
        return policy.mcp.includes(id) || policy.mcp.includes(args.ServerName + "/*") ? null : id + " is not one of this step's tools.";
    }
    if (name === "finish") return null;
    if (policy.read.includes(name)) {
        const outside = Object.entries(args).find(([key, value]) => /path|dir|file/i.test(key) && typeof value === "string" && value && !within(value));
        return outside ? outside[1] + " is outside this step's folders." : null;
    }
    return name + " is not available in this step.";
}
const reason = refusal();
process.stdout.write(JSON.stringify(reason ? { decision: "deny", reason } : { decision: "allow" }));
`;

function hookCommand(): string {
    const exe = process.execPath;
    return process.platform === 'win32'
        ? `set ELECTRON_RUN_AS_NODE=1&& "${exe}" hook.cjs`
        : `ELECTRON_RUN_AS_NODE=1 '${exe.replace(/'/g, `'\\''`)}' hook.cjs`;
}

interface Exited {
    code: number | null;
    stderr: string;
}

function runAgyCommand(
    exe: string,
    args: string[],
    options: { cwd?: string; input?: string; signal?: AbortSignal; onLine?(line: string): void } = {},
): Promise<Exited> {
    return new Promise((resolve, reject) => {
        const child = spawn(exe, args, { cwd: options.cwd, signal: options.signal });
        let stderr = '';
        createInterface({ input: child.stdout }).on('line', (line) => options.onLine?.(line));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr }));
        // On stdin rather than in the arguments, which Windows caps near 32,000 characters.
        child.stdin.end(options.input ?? '');
    });
}

const MODELS_TTL_MS = 10 * 60_000;

let modelsAsked: { exe: string; at: number; list: Promise<ModelOption[]> } | null = null;

/** What agy said went wrong: its last line, without the "Error:" in front. */
function complaint({ code, stderr }: Exited): string {
    return stderr.trim().split('\n').at(-1)?.replace(/^Error:\s*/, '').trim() || `agy exited with ${code}.`;
}

/** The models agy offers, or what agy says is in the way — not signed in, say. */
async function askForModels(exe: string, signal?: AbortSignal): Promise<ModelOption[]> {
    const lines: string[] = [];
    const exited = await runAgyCommand(exe, ['models'], { signal, onLine: (line) => lines.push(line) });
    if (exited.code !== 0) throw new Error(complaint(exited));
    // One entry per model, with the levels agy lists it at as its effort levels.
    const models = new Map<string, { name: string; levels: string[] }>();
    for (const line of lines) {
        const [id = '', name] = line.split('\t');
        // A line with no name is agy talking, as "Fetching available models..." is.
        if (!id || !name) continue;
        const level = AGY_LEVEL_SUFFIX.exec(id)?.[1];
        const model = level ? id.slice(0, -level.length - 1) : id;
        // "Gemini 3.1 Pro (High)" and "Claude Sonnet 5.5 (High)" name the level too.
        const entry = models.get(model) ?? {
            name: (level ? name.replace(/\s*\([^)]*\)\s*$/, '') : name).trim(),
            levels: [],
        };
        if (level) entry.levels.push(level);
        models.set(model, entry);
    }
    return [...models].map(([id, { name, levels }]) => ({
        value: `${AGY_MODEL_PREFIX}${id}`,
        displayName: `${name} · agy`,
        description:
            `${name} through the Antigravity CLI (agy), on its own Google login and quota. Each MCP tool a step calls needs a rule in ${AGY_SETTINGS}, and a Processor with file-system access cannot run on it.`,
        effortLevels: levels.sort((a, b) => AGY_LEVELS.indexOf(a) - AGY_LEVELS.indexOf(b)),
        // agy refuses a model listed by level unless the run names one.
        effortRequired: levels.length > 0,
    }));
}

/** The models agy offers. Empty when agy is not installed or not signed in, never a failure. */
function listAgyModels(exe: string): Promise<ModelOption[]> {
    if (modelsAsked && modelsAsked.exe === exe && Date.now() - modelsAsked.at < MODELS_TTL_MS) return modelsAsked.list;
    const asked = { exe, at: Date.now(), list: askForModels(exe).catch(() => []) };
    modelsAsked = asked;
    return asked.list;
}

/** Long enough for `agy models` to ask Google over a slow connection. */
const STATUS_TIMEOUT_MS = 30_000;

/** Why agy could not be asked, from the error its spawn or `askForModels` ended in. */
function unreachable(e: unknown, exe: string): string {
    const error = e as NodeJS.ErrnoException;
    if (error.name === 'AbortError') return `agy did not answer within ${STATUS_TIMEOUT_MS / 1000} seconds.`;
    if (error.code !== 'ENOENT') return error.message;
    // A bare name is what is left when it is in none of the places agy installs itself.
    return exe === 'agy' ? 'Not installed: not in ~/.local/bin, nor on the PATH.' : `Not found at ${exe}.`;
}

/** One group of models sharing a quota, as `agy -p /usage --output-format json` answers it. */
interface QuotaGroup {
    /** "Gemini Models", "Claude and GPT models". */
    name?: string;
    /** "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS". */
    description?: string;
    buckets?: { window?: string; remaining_fraction?: number; reset_time?: string }[];
}

interface UsageAnswer {
    command?: { data?: { groups?: QuotaGroup[] } };
}

/** "Gemini Models" is "Gemini", as what is said of it says it is about models. */
const groupName = (group: QuotaGroup): string => (group.name ?? 'Models').replace(/\s+models$/i, '');

/** Under this much of a window left, as Settings shows it, the quota is used up. */
const USED_UP = 0.005;

/** Long enough for `/usage` to answer once agy is signed in; a signed-out agy waits a minute instead. */
const QUOTA_TIMEOUT_MS = 15_000;

/** The groups `/usage` last answered with, to tell which one a model draws on. */
let quotaGroups: QuotaGroup[] = [];

/** When each group's quota comes back, by its name, while it is used up. */
const quotaHeld = new Map<string, number>();

/** The group whose name or models name the model's family: `gemini`, `claude`, `gpt`. */
function groupOf(groups: QuotaGroup[], model: string): QuotaGroup | undefined {
    const family = model.slice(AGY_MODEL_PREFIX.length).split('-')[0]?.toLowerCase();
    if (!family) return undefined;
    return groups.find((g) => `${g.name ?? ''} ${g.description ?? ''}`.toLowerCase().includes(family));
}

/** When the quota the model draws on comes back, or 0 when it has some left, as far as agy last said. */
function heldUntil(model: string): number {
    const group = groupOf(quotaGroups, model)?.name;
    const until = (group && quotaHeld.get(group)) || 0;
    return until > Date.now() ? until : 0;
}

/** agy's quota as it stands, which also tells `heldUntil` which groups are used up and until when. */
async function askForQuota(exe: string, signal: AbortSignal): Promise<QuotaGroup[]> {
    const lines: string[] = [];
    // Out of any folder of the user's, which agy would otherwise take for a project.
    const exited = await runAgyCommand(exe, ['-p', '/usage', '--output-format', 'json'], {
        cwd: tmpdir(),
        signal,
        onLine: (line) => lines.push(line),
    });
    if (exited.code !== 0) return [];
    const groups = (JSON.parse(lines.join('\n')) as UsageAnswer).command?.data?.groups ?? [];
    quotaGroups = groups;
    for (const group of groups) {
        if (!group.name) continue;
        // The latest reset among the windows used up: the quota is back only once each is.
        const back = (group.buckets ?? [])
            .filter((b) => typeof b.remaining_fraction === 'number' && b.remaining_fraction < USED_UP)
            .map((b) => Date.parse(b.reset_time ?? ''))
            .filter((at) => !Number.isNaN(at));
        if (back.length > 0) quotaHeld.set(group.name, Math.max(...back));
        else quotaHeld.delete(group.name);
    }
    return groups;
}

/** agy's windows, the shorter first. */
const USAGE_WINDOWS: [string, string][] = [['5h', '5 hours'], ['weekly', 'week']];

/**
 * agy's quota for each group of models it offers, as used rather than remaining
 * so it reads like Claude's. Asked only of a signed-in agy: a signed-out one waits
 * a minute for a browser sign-in instead of answering.
 */
async function askForUsage(exe: string, signal: AbortSignal): Promise<UsageWindow[]> {
    return (await askForQuota(exe, signal)).flatMap((group) =>
        USAGE_WINDOWS.flatMap(([window, named]) =>
            (group.buckets ?? [])
                .filter((b) => b.window === window && typeof b.remaining_fraction === 'number')
                .map((b) => ({
                    label: `${groupName(group)} · ${named}`,
                    percentUsed: Math.round((1 - (b.remaining_fraction ?? 1)) * 100),
                    resetsAt: b.reset_time ?? null,
                })),
        ),
    );
}

/** What `agy --version` says. */
async function askForVersion(exe: string, signal: AbortSignal): Promise<string | null> {
    const said: string[] = [];
    await runAgyCommand(exe, ['--version'], { signal, onLine: (line) => said.push(line) });
    return said[0]?.trim() || null;
}

/** The binary a run would start, its version, whether it is signed in, and its quota. */
async function agyStatus(exe: string): Promise<AgentStatus> {
    const base = { id: 'agy', name: 'agy', executable: exe };
    const timeout = AbortSignal.timeout(STATUS_TIMEOUT_MS);
    // All three at once, as each takes a second or two. Only a signed-in agy lists
    // its models, and the quota is asked before that is known, so a model list that
    // fails stops the quota too, rather than leaving agy waiting on a browser sign-in.
    const signedOut = new AbortController();
    const version = askForVersion(exe, timeout);
    const models = askForModels(exe, timeout);
    const usage = askForUsage(exe, AbortSignal.any([timeout, signedOut.signal])).catch((): UsageWindow[] => []);
    try {
        const [said, offered] = await Promise.all([version, models]);
        const count = `${offered.length} model${offered.length === 1 ? '' : 's'} on offer`;
        return { ...base, version: said, ready: true, detail: `Signed in · ${count}`, usage: await usage };
    } catch (e) {
        signedOut.abort();
        return {
            ...base,
            version: await version.catch(() => null),
            ready: false,
            detail: unreachable(e, exe),
            usage: [],
        };
    }
}

/** The run's MCP servers as agy's plugin config: the in-process ones served on loopback. */
async function pluginServers(
    servers: Record<string, AgentMcpServer>,
): Promise<{ config: Record<string, unknown>; close(): Promise<void> }> {
    const config: Record<string, unknown> = {};
    const closers: (() => Promise<void>)[] = [];
    const close = async (): Promise<void> => {
        await Promise.all(closers.map((c) => c()));
    };
    try {
        for (const [name, server] of Object.entries(servers)) {
            if (server.type === 'sdk') {
                const hosted = await serveOnLoopback(server.instance);
                closers.push(hosted.close);
                config[name] = { serverUrl: hosted.url };
            } else {
                config[name] = {
                    command: server.command,
                    args: server.args ?? [], ...(server.env ? { env: server.env } : {})
                };
            }
        }
    } catch (e) {
        await close();
        throw e;
    }
    return { config, close };
}

/** `mcp__server__tool` and `mcp__server` entries of an allowlist, as agy's `server/tool` and `server/*`. */
function mcpGrants(allowedTools: string[], servers: string[]): string[] {
    return allowedTools.flatMap((entry) => {
        const server = servers.find((s) => entry === `mcp__${s}` || entry.startsWith(`mcp__${s}__`));
        if (!server) return [];
        return [`${agyServer(server)}/${entry === `mcp__${server}` ? '*' : entry.slice(`mcp__${server}__`.length)}`];
    });
}

/** A skill as Claude names it: `<plugin>:<name>` for a plugin's, a bare name for the working directory's. */
function skillRef(ref: string): { plugin?: string; name: string } {
    const colon = ref.indexOf(':');
    return colon < 0 ? { name: ref } : { plugin: ref.slice(0, colon), name: ref.slice(colon + 1) };
}

/**
 * Each ticked skill, copied to where agy finds skills: `.agents/skills/<name>`.
 * A plugin's comes from the plugin folders the request names, the working
 * directory's own from its `.claude/skills`.
 */
async function copySkills(request: AgentRunRequest, workspace: string): Promise<string[]> {
    const copied: string[] = [];
    for (const ref of request.skills ?? []) {
        const { plugin, name } = skillRef(ref);
        const from = plugin
            ? request.skillPlugins?.map((p) => join(p, 'skills', name)).find((p) => existsSync(p))
            : join(request.cwd, '.claude', 'skills', name);
        if (!from || !existsSync(from)) continue;
        await cp(from, join(workspace, '.agents', 'skills', name), { recursive: true, dereference: true });
        copied.push(name);
    }
    return copied;
}

/** How the node's Claude wording maps onto agy, after its prompt. */
function environmentNotes(servers: string[], skills: string[], pluginNames: string[]): string[] {
    const one = skills.length === 1;
    const spelled = pluginNames.map((p) => `\`${p}:<name>\``).join(' or ');
    return [
        '',
        '--- This environment ---',
        ...(servers.length > 0
            ? [
                `A tool named \`mcp__<server>__<tool>\` above or in a skill is the MCP tool <tool> of server \`${PLUGIN}_<server>\`: ` +
                'call it with call_mcp_tool. Only the MCP tools this step names are yours; any other is refused.',
            ]
            : []),
        ...(skills.length > 0
            ? [
                `Before anything else, read the skill${one ? '' : 's'} this step is given — ${skills.map((s) => `\`${s}\``).join(', ')}` +
                `${spelled ? `, also written ${spelled}` : ''} — at .agents/skills/<name>/SKILL.md, and follow ${one ? 'it' : 'them'}. ` +
                'Where a skill says to load another with the Skill tool, read its SKILL.md; where it says Read, use view_file.',
            ]
            : []),
        'You cannot run commands or browse the web here, nor write a file but through these MCP tools. If the task needs more, say so in your result.',
    ];
}

/** One line of `--output-format stream-json`, read structurally. */
interface StreamLine {
    event?: string;
    init?: { model?: string; cwd?: string; tools?: string[] };
    step_update?: {
        step_index: number;
        state: string;
        step_type: string;
        text_delta?: string;
        tool_info?: {
            name?: string;
            parameters?: Record<string, unknown>;
            output?: string;
            error?: { message?: string };
        };
    };
    result?: {
        status?: string;
        error?: string;
        structured_output?: unknown;
        duration_seconds?: number;
        usage?: Record<string, number>;
        denied_actions?: { action: string; display_name?: string }[];
    };
}

/** A tool step as the trace names it: an MCP call by the Claude spelling the rest of the app uses. */
function describeTool(info: NonNullable<NonNullable<StreamLine['step_update']>['tool_info']>): {
    label: string;
    input: unknown;
    /** An MCP call's `server/tool`, as agy's rules and the hook's policy write it. */
    mcp?: string;
} {
    // agy adds these for its own UI.
    const { toolAction: _a, toolSummary: _s, ...params } = info.parameters ?? {};
    if (info.name === 'call_mcp_tool') {
        const server = String(params.ServerName ?? '');
        const tool = String(params.ToolName ?? '');
        const bare = server.startsWith(`${PLUGIN}_`) ? server.slice(PLUGIN.length + 1) : server;
        return { label: `mcp__${bare}__${tool}`, input: params.Arguments ?? {}, mcp: `${server}/${tool}` };
    }
    return { label: info.name ?? 'tool', input: params };
}

async function runAgy(exe: string, request: AgentRunRequest): Promise<AgentRunResult> {
    const model = request.model.slice(AGY_MODEL_PREFIX.length);
    // The id `agy models` lists this model at this level by.
    const shown = request.effort ? `${model}-${request.effort}` : model;
    const fail = (error: string): AgentRunResult => {
        request.onEvent({ at: now(), type: 'error', label: error });
        return { ok: false, error };
    };

    if (request.allowedTools.some((t) => FILE_SYSTEM_TOOLS.includes(t))) {
        return fail(
            `${model} runs through agy, which this app gives no shell and no file writes. ` +
            'Untick file-system access, or pick a Claude model for this node.',
        );
    }

    const workspace = await mkdtemp(join(tmpdir(), 'patchbay-agy-'));
    const plugin = join(workspace, '.agents', 'plugins', PLUGIN);
    let servers: Awaited<ReturnType<typeof pluginServers>> | undefined;
    try {
        servers = await pluginServers(request.mcpServers ?? {});
        const serverNames = Object.keys(request.mcpServers ?? {});
        const skills = await copySkills(request, workspace);
        const pluginNames = [...new Set((request.skills ?? []).flatMap((ref) => skillRef(ref).plugin ?? []))];
        const folders = [...new Set([request.cwd, ...(request.additionalDirectories ?? [])])];
        // A Categorizer's one judgement reads nothing, so it is given no folder to read.
        const readable = request.tools?.length === 0 && serverNames.length === 0 ? [] : folders;
        const agyHome = join(homedir(), '.gemini', 'antigravity-cli');
        const roots = [workspace, ...readable, join(agyHome, 'mcp')];
        const granted = mcpGrants(request.allowedTools, serverNames);
        const repeatable = mcpGrants(request.repeatableTools ?? [], serverNames);

        await mkdir(plugin, { recursive: true });
        await writeFile(join(plugin, 'plugin.json'), JSON.stringify({ name: PLUGIN }));
        await writeFile(join(plugin, 'mcp_config.json'), JSON.stringify({ mcpServers: servers.config }));
        await writeFile(join(plugin, 'hook.cjs'), HOOK);
        await writeFile(
            join(plugin, 'policy.json'),
            JSON.stringify({
                workspace,
                // agy may name a path by either spelling where the temp folder is a link.
                roots: [...new Set(roots.flatMap((r) => (existsSync(r) ? [r, realpathSync(r)] : [r])))],
                brain: join(agyHome, 'brain'),
                read: readable.length > 0 || skills.length > 0 ? READ_TOOLS : [],
                mcp: granted,
            }),
        );
        await writeFile(
            join(plugin, 'hooks.json'),
            JSON.stringify({
                [PLUGIN]: {
                    PreToolUse: [{
                        matcher: '*',
                        hooks: [{ type: 'command', command: hookCommand() }]
                    }]
                }
            }),
        );

        const args = ['--model', model, '--output-format', 'stream-json'];
        if (request.effort) args.push('--effort', request.effort);
        if (request.jsonSchema) {
            const schemaFile = join(workspace, 'schema.json');
            await writeFile(schemaFile, JSON.stringify(request.jsonSchema));
            args.push('--json-schema', schemaFile);
        }
        for (const folder of readable) args.push('--add-dir', folder);

        const prompt = [request.prompt, ...(request.tools?.length === 0 && serverNames.length === 0 ? [] : environmentNotes(serverNames, skills, pluginNames))].join('\n');
        request.onEvent({
            at: now(),
            type: 'prompt',
            label: `Prompt to ${shown} (agy)`,
            detail: truncate(prompt, 20_000),
        });

        /** One run of agy, and what the trace needs from it. */
        const once = async (): Promise<Attempt> => {
            const tools = new Map<number, ReturnType<typeof describeTool>>();
            const texts = new Map<number, string>();
            const attempt: Attempt = { grants: new Set(), acted: false };

            const onLine = (raw: string): void => {
                let line: StreamLine;
                try {
                    line = JSON.parse(raw) as StreamLine;
                } catch {
                    return;
                }
                if (line.event === 'init') {
                    request.onEvent({
                        at: now(),
                        type: 'note',
                        label: `Session ready — agy ${line.init?.model ?? model}, ${skills.length} skill(s), ${serverNames.length} MCP server(s)`,
                        detail: [
                            `workspace: ${workspace}`,
                            `folders: ${readable.join(', ') || '(none)'}`,
                            `skills: ${skills.join(', ') || '(none)'}`,
                            `mcp: ${serverNames.map(agyServer).join(', ') || '(none)'}`,
                        ].join('\n'),
                    });
                    return;
                }
                if (line.event === 'result') {
                    attempt.result = line.result;
                    return;
                }
                const step = line.step_update;
                if (!step) return;
                if (step.step_type === 'agent_response') {
                    const text = (texts.get(step.step_index) ?? '') + (step.text_delta ?? '');
                    texts.set(step.step_index, text);
                    if (step.state !== 'DONE') {
                        if (step.text_delta) request.onLive?.({ type: 'assistant', label: '', text });
                        return;
                    }
                    request.onLive?.(null);
                    if (text.trim()) {
                        request.onEvent({
                            at: now(),
                            type: 'assistant',
                            label: text.trim().slice(0, 160),
                            detail: text
                        });
                    }
                    return;
                }
                if (step.step_type !== 'tool' || !step.tool_info) return;
                if (!tools.has(step.step_index)) {
                    const tool = describeTool(step.tool_info);
                    tools.set(step.step_index, tool);
                    // Only what the hook lets through can have run, or been refused by agy's settings.
                    const server = tool.mcp?.split('/')[0];
                    if (tool.mcp && (granted.includes(tool.mcp) || granted.includes(`${server}/*`))) {
                        attempt.grants.add(`mcp(${tool.mcp})`);
                        if (!repeatable.includes(tool.mcp)) attempt.acted = true;
                    }
                    request.onEvent({
                        at: now(),
                        type: 'tool-call',
                        label: tool.label,
                        detail: truncate(JSON.stringify(tool.input, null, 2)),
                    });
                }
                if (step.state === 'DONE' || step.state === 'ERROR') {
                    const tool = tools.get(step.step_index);
                    const failed = step.state === 'ERROR';
                    const output = failed ? step.tool_info.error?.message : step.tool_info.output;
                    // A call agy's settings refused ends done, but with nothing to show for it.
                    const outcome = failed ? 'error' : output ? 'ok' : 'no result';
                    request.onEvent({
                        at: now(),
                        type: 'tool-result',
                        label: `${tool?.label ?? 'tool'} → ${outcome}`,
                        detail: truncate(output ?? ''),
                    });
                }
            };

            try {
                attempt.exited = await runAgyCommand(exe, args, {
                    cwd: workspace,
                    input: prompt,
                    signal: request.signal,
                    onLine
                });
            } catch (e) {
                attempt.spawnError = e as NodeJS.ErrnoException;
            }
            // A reply cut off mid-way never arrives whole.
            request.onLive?.(null);
            return attempt;
        };

        for (let tries = 0; ; tries++) {
            const attempt = await once();
            const outage = outageIn(attempt);
            const wait = RETRY_DELAYS_MS[tries];
            // Asking again after a tool that changes something could do it twice.
            if (!outage || attempt.acted || wait === undefined) return finish(attempt, outage);
            request.onEvent({
                at: now(),
                type: 'error',
                label: `agy failed (${outage}), so it is asked again in ${wait / 1000}s`
            });
            await sleep(wait, undefined, { signal: request.signal });
        }

        /** The run's result, and why another model should take the step if agy could not. */
        async function finish(attempt: Attempt, outage: string | null): Promise<AgentRunResult> {
            const result = settle(attempt);
            if (result.ok || attempt.acted) return result;
            let unavailable: string | null = null;
            if (attempt.spawnError?.code === 'ENOENT') unavailable = `agy is not installed, or not at ${exe}`;
            else if (outage) unavailable = `agy could not be reached (${outage})`;
            // A run agy finished failed on the step's own account.
            else if (!attempt.spawnError && attempt.result?.status !== 'SUCCESS') unavailable = await usedUp(attempt);
            return unavailable ? { ...result, unavailable } : result;
        }

        /** Whether the run failed because the model's quota is used up, asked of `/usage` whatever agy said. */
        async function usedUp({ result, exited }: Attempt): Promise<string | null> {
            const asking = [AbortSignal.timeout(QUOTA_TIMEOUT_MS), ...(request.signal ? [request.signal] : [])];
            await askForQuota(exe, AbortSignal.any(asking)).catch(() => []);
            const group = groupOf(quotaGroups, request.model);
            const named = group ? `agy's ${groupName(group)} quota` : `agy's quota for ${model}`;
            const until = heldUntil(request.model);
            if (until) return `${named} is used up until ${clock(until)}`;
            return QUOTA.test(`${result?.error ?? ''} ${exited?.stderr ?? ''}`) ? `${named} is used up` : null;
        }

        function settle({ result, exited, spawnError, grants }: Attempt): AgentRunResult {
            if (spawnError?.code === 'ENOENT') {
                return fail(`agy is not installed, or not at ${exe}. Set where it is under Settings → Agents.`);
            }
            if (spawnError) return fail(spawnError.message);
            if (!result) {
                return fail(`agy exited with ${exited?.code} and no result: ${exited?.stderr.trim() || '(nothing on stderr)'}`);
            }
            const usage = result.usage ?? {};
            request.onEvent({
                at: now(),
                type: 'note',
                label: `agy ${shown} finished in ${result.duration_seconds?.toFixed(1) ?? '?'}s`,
                detail: `input tokens: ${usage.input_tokens ?? '?'}, output: ${usage.output_tokens ?? '?'}, thinking: ${usage.thinking_tokens ?? '?'}`,
            });

            // The hook allowed these, so it was agy's own settings that refused one.
            if (result.denied_actions?.some((d) => d.action === 'mcp')) {
                const rules = [...grants].map((g) => `"${g}"`).join(', ');
                return fail(
                    `agy's own settings refused an MCP tool this step needs. Add ${rules || 'a rule for each tool it calls'} ` +
                    `to permissions.allow in ${AGY_SETTINGS}.`,
                );
            }
            if (result.status !== 'SUCCESS' || exited?.code !== 0) {
                return fail(`agy ended with ${result.status ?? `exit ${exited?.code}`}: ${result.error ?? exited?.stderr.trim()}`);
            }
            if (request.jsonSchema && result.structured_output === undefined) {
                return fail('agy returned no structured output for the requested schema.');
            }
            return { ok: true, structured: result.structured_output };
        }
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    } finally {
        await servers?.close();
        await rm(workspace, { recursive: true, force: true });
    }
}

/** The models agy offers, for a model stored as `agy:<id>`. */
export function agyBackend(host: AgentHost): AgentBackend {
    const exe = (): string => resolveAgyPath(host.agyExecutable());
    return {
        id: 'agy',
        owns: isAgyModel,
        listModels: () => listAgyModels(exe()),
        heldUntil,
        status: () => agyStatus(exe()),
        run: (request) => runAgy(exe(), request),
    };
}
