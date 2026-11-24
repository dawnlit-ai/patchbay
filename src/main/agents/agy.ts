import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
    type AgentHarness,
    type AgentModel,
    agyQuotaGroup,
    clock,
    type CommandOptions,
    type Exited,
    runCommand,
    withToolPath,
} from '@dawnlit/agent-harness';
import { AGY_MODEL_PREFIX, isAgyModel } from '@shared/flow';
import type { ModelOption } from '@shared/ipc';
import { now, truncate } from '@shared/trace';
import { errorMessage } from '@shared/util';
import { serveOnLoopback } from './loopback';
import { proxyServer } from './mcpProxy';
import { unquoteKeys } from './quotedKeys';
import type { AgentBackend, AgentMcpServer, AgentRunRequest, AgentRunResult } from './types';

/**
 * The models the Antigravity CLI (`agy`) offers — Gemini, and the Claude and GPT
 * models beside it, each group on a quota of its own — for a node whose model is
 * stored as `agy:<id>`. Each run gets a workspace of its own, and a plugin in it
 * that hands agy the workspace's skills and the run's MCP servers — each one run by
 * this app and served to agy through a proxy on loopback — with a hook that
 * refuses every tool the node was not given: agy has no switch to leave its own
 * shell, browser or web search out. The hook can refuse but not grant. Headless,
 * agy calls an MCP tool only when the user's own agy settings allow it, so each
 * needs a rule there.
 */

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
function outageIn({result, exited, spawnError}: Attempt): string | null {
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

/**
 * agy's own tools a step may use, within its folders; `finish` is what carries the result.
 * Gemini 4 is handed a smaller set, whose one reading tool is `read_file`, and it reads a PDF too.
 */
const READ_TOOLS = ['view_file', 'read_file', 'list_dir', 'grep_search', 'find_by_name'];

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
const inside = (p, root) => {
    const r = relative(root, resolve(policy.workspace, p));
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const within = (p) => roots.some((root) => inside(p, root));
// The plugin's mcp_config.json holds what each server is started with, its env and headers among it:
// not to be read, nor searched from a folder above it.
const hidden = (p) => policy.hidden.some((dir) => inside(p, dir) || (name === "grep_search" && inside(dir, resolve(policy.workspace, p))));
function refusal() {
    if (name === "call_mcp_tool") {
        const id = args.ServerName + "/" + args.ToolName;
        return policy.mcp.includes(id) || policy.mcp.includes(args.ServerName + "/*") ? null : id + " is not one of this step's tools.";
    }
    if (name === "finish") return null;
    if (policy.read.includes(name)) {
        const paths = Object.entries(args).filter(([key, value]) => /path|dir|file/i.test(key) && typeof value === "string" && value).map(([, value]) => value);
        const outside = paths.find((p) => !within(p));
        if (outside) return outside + " is outside this step's folders.";
        const kept = paths.find(hidden);
        return kept ? kept + " holds this run's own configuration, which is not for reading." : null;
    }
    return name + " is not available in this step.";
}
const reason = refusal();
process.stdout.write(JSON.stringify(reason ? { decision: "deny", reason } : { decision: "allow" }));
`;

/**
 * Where agy finds this app's binary to run the hook with: agy and everything it
 * starts inherit it.
 */
const HOOK_EXE_ENV = 'PATCHBAY_HOOK_EXE';

/**
 * The hook's launcher on Windows. agy runs a hook through `cmd /c`, having escaped
 * the command's quotes as `\"`, which cmd keeps — so a quoted path in the command
 * never reaches cmd whole. A batch file's quotes reach it as written, and the path
 * comes from the environment rather than the file, which cmd reads in the console's
 * code page.
 */
const HOOK_LAUNCHER = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%${HOOK_EXE_ENV}%" "%~dp0hook.cjs"\r\n`;

function hookCommand(): string {
    return process.platform === 'win32'
        ? '.\\hook.cmd'
        : `ELECTRON_RUN_AS_NODE=1 '${process.execPath.replace(/'/g, `'\\''`)}' hook.cjs`;
}

/** Runs agy so that its hook finds this app's binary: agy and everything it starts inherit it. */
function runAgyCommand(exe: string, args: string[], options: Omit<CommandOptions, 'env'> = {}): Promise<Exited> {
    // agy finds each MCP server's command on its own PATH, and the server inherits it.
    return runCommand(exe, args, {...options, env: withToolPath({...process.env, [HOOK_EXE_ENV]: process.execPath})});
}

/** A model agy offers, as the model lists show it: stored as `agy:<id>`. */
function agyOption(model: AgentModel): ModelOption {
    return {
        value: `${AGY_MODEL_PREFIX}${model.id}`,
        displayName: `${model.label} · agy`,
        description:
            `${model.label} through the Antigravity CLI (agy), on its own Google login and quota. Each MCP tool a step calls needs a rule in ${AGY_SETTINGS}, and a step that runs commands or writes files cannot run on it.`,
        effortLevels: model.efforts,
        // agy refuses a model listed by level unless the run names one.
        effortRequired: model.effortRequired ?? false,
    };
}

/**
 * The run's MCP servers as agy's plugin config. agy reaches none of them itself:
 * this app starts or reaches each one, and serves agy a server on loopback that
 * passes its requests through, so a tool call's arguments lose the quotes Gemini 4
 * writes inside keys before the tool reads them. The servers' commands, env and
 * headers stay in this app rather than in the plugin's config.
 */
async function pluginServers(
    servers: Record<string, AgentMcpServer>,
    defaultCwd: string,
    onUnquoted: (server: string, tool: string, keys: string[]) => void,
): Promise<{ config: Record<string, unknown>; close(): Promise<void> }> {
    // Before any is started, so a step that cannot run starts nothing.
    for (const [name, server] of Object.entries(servers)) {
        if (server.type === 'sse') {
            throw new Error(
                `MCP server "${name}" uses the older SSE transport, which agy does not support. ` +
                'Point it at a Streamable HTTP endpoint (type "http"), or pick a Claude model for this node.',
            );
        }
    }
    const config: Record<string, unknown> = {};
    const closers: (() => Promise<void>)[] = [];
    const close = async (): Promise<void> => {
        await Promise.all(closers.map((c) => c().catch(() => undefined)));
    };
    try {
        for (const [name, server] of Object.entries(servers)) {
            if (server.type === 'sse') continue;
            const proxied = await proxyServer(name, server, defaultCwd, (tool, keys) => onUnquoted(name, tool, keys));
            closers.push(proxied.close);
            const hosted = await serveOnLoopback(proxied.server);
            closers.push(hosted.close);
            config[name] = {serverUrl: hosted.url};
        }
    } catch (e) {
        await close();
        throw e;
    }
    return {config, close};
}

/** `mcp__server__tool` and `mcp__server` entries of an allowlist, as agy's `server/tool` and `server/*`. */
function mcpGrants(allowedTools: string[], servers: string[]): string[] {
    return allowedTools.flatMap((entry) => {
        const server = servers.find((s) => entry === `mcp__${s}` || entry.startsWith(`mcp__${s}__`));
        if (!server) return [];
        return [`${agyServer(server)}/${entry === `mcp__${server}` ? '*' : entry.slice(`mcp__${server}__`.length)}`];
    });
}

/** A skill as Claude names it: `<plugin>:<name>`. */
function skillRef(ref: string): { plugin?: string; name: string } {
    const colon = ref.indexOf(':');
    return colon < 0 ? {name: ref} : {plugin: ref.slice(0, colon), name: ref.slice(colon + 1)};
}

/**
 * Each skill the run may use, copied from the plugin folders the request names
 * to where agy finds skills: `.agents/skills/<name>`.
 */
async function copySkills(request: AgentRunRequest, workspace: string): Promise<string[]> {
    const copied: string[] = [];
    for (const ref of request.skills ?? []) {
        const {name} = skillRef(ref);
        const from = request.skillPlugins?.map((p) => join(p, 'skills', name)).find((p) => existsSync(p));
        if (!from) continue;
        await cp(from, join(workspace, '.agents', 'skills', name), {recursive: true, dereference: true});
        copied.push(name);
    }
    return copied;
}

/** How the node's Claude wording maps onto agy, after its prompt. */
function environmentNotes(servers: string[], skills: string[], follow: string[], pluginNames: string[]): string[] {
    const one = follow.length === 1;
    const listed = (names: string[]): string => names.map((s) => `\`${s}\``).join(', ');
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
                `The workspace's skills are at .agents/skills/<name>/SKILL.md: ${listed(skills)}` +
                `${spelled ? `, each also written ${spelled}` : ''}. ` +
                (follow.length > 0
                    ? `Before anything else, read the skill${one ? '' : 's'} this step is given — ${listed(follow)} — and follow ${one ? 'it' : 'them'}; ` +
                    'read another where the task or a skill calls for it. '
                    : 'Read one where its name fits the task. ') +
                'Where a skill says to load another with the Skill tool, read its SKILL.md; where it says Read, use your file-reading tool (view_file or read_file, whichever you have).',
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
    const {toolAction: _a, toolSummary: _s, ...params} = info.parameters ?? {};
    if (info.name === 'call_mcp_tool') {
        const server = String(params.ServerName ?? '');
        const tool = String(params.ToolName ?? '');
        const bare = server.startsWith(`${PLUGIN}_`) ? server.slice(PLUGIN.length + 1) : server;
        return {label: `mcp__${bare}__${tool}`, input: params.Arguments ?? {}, mcp: `${server}/${tool}`};
    }
    return {label: info.name ?? 'tool', input: params};
}

async function runAgy(harness: AgentHarness, request: AgentRunRequest): Promise<AgentRunResult> {
    const model = request.model.slice(AGY_MODEL_PREFIX.length);
    // The id `agy models` lists this model at this level by.
    const shown = request.effort ? `${model}-${request.effort}` : model;
    const fail = (error: string): AgentRunResult => {
        request.onEvent({at: now(), type: 'error', label: error});
        return {ok: false, error};
    };

    if (request.allowedTools.some((t) => FILE_SYSTEM_TOOLS.includes(t))) {
        return fail(
            `${model} runs through agy, which this app gives no shell and no file writes. ` +
            'Untick Run commands, and files anywhere if it is ticked, or pick a Claude model for this node.',
        );
    }
    if (request.folders && request.folders.write.length > 0) {
        return fail(
            `${model} runs through agy, which this app gives no file writes. ` +
            'Make each of the node’s folders read only, or pick a Claude model for this node.',
        );
    }

    const found = harness.locate('agy');
    // Unavailable rather than failed: a fallback on another agent can still take the step.
    if (!found) {
        return {
            ...fail('agy is not installed: it is neither where its installer puts it nor on the PATH. Set where it is under Settings → Agents.'),
            unavailable: 'agy is not installed',
        };
    }
    const exe: string = found;

    const workspace = await mkdtemp(join(tmpdir(), 'patchbay-agy-'));
    const plugin = join(workspace, '.agents', 'plugins', PLUGIN);
    let servers: Awaited<ReturnType<typeof pluginServers>> | undefined;
    try {
        servers = await pluginServers(request.mcpServers ?? {}, request.cwd, (server, tool, keys) =>
            request.onEvent({
                at: now(),
                type: 'note',
                label: `Took the quotes off ${keys.length} key(s) ${shown} wrote inside them, in what it gave mcp__${server}__${tool}`,
                detail: keys.join('\n'),
            }),
        );
        const serverNames = Object.keys(request.mcpServers ?? {});
        const skills = await copySkills(request, workspace);
        const follow = (request.followSkills ?? []).map((ref) => skillRef(ref).name).filter((name) => skills.includes(name));
        const pluginNames = [...new Set((request.skills ?? []).flatMap((ref) => skillRef(ref).plugin ?? []))];
        // A step held to its folders reads those alone, not the folder it was started from.
        const folders = request.folders
            ? [...new Set(request.folders.read)]
            : [...new Set([request.cwd, ...(request.additionalDirectories ?? [])])];
        // A Categorizer's one judgement reads nothing, so it is given no folder to read.
        const readable = request.tools?.length === 0 && serverNames.length === 0 ? [] : folders;
        const agyHome = join(homedir(), '.gemini', 'antigravity-cli');
        const roots = [workspace, ...readable, join(agyHome, 'mcp')];
        const granted = mcpGrants(request.allowedTools, serverNames);
        const repeatable = mcpGrants(request.repeatableTools ?? [], serverNames);

        await mkdir(plugin, {recursive: true});
        const plugins = dirname(plugin);
        /** Both spellings of a folder, where the temp folder is reached through a link. */
        const spellings = (dirs: string[]): string[] =>
            [...new Set(dirs.flatMap((r) => (existsSync(r) ? [r, realpathSync(r)] : [r])))];
        await writeFile(join(plugin, 'plugin.json'), JSON.stringify({name: PLUGIN}));
        await writeFile(join(plugin, 'mcp_config.json'), JSON.stringify({mcpServers: servers.config}));
        await writeFile(join(plugin, 'hook.cjs'), HOOK);
        if (process.platform === 'win32') await writeFile(join(plugin, 'hook.cmd'), HOOK_LAUNCHER);
        await writeFile(
            join(plugin, 'policy.json'),
            JSON.stringify({
                workspace,
                // agy may name a path by either spelling where the temp folder is a link.
                roots: spellings(roots),
                hidden: spellings([plugins]),
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
                        hooks: [{type: 'command', command: hookCommand()}]
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

        const prompt = [request.prompt, ...(request.tools?.length === 0 && serverNames.length === 0 ? [] : environmentNotes(serverNames, skills, follow, pluginNames))].join('\n');
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
            const attempt: Attempt = {grants: new Set(), acted: false};

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
                        if (step.text_delta) request.onLive?.({type: 'assistant', label: '', text});
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
                    // An MCP call agy's settings refused ends done, but with nothing to show for it.
                    // A file read ends done with none too, when the file went to the model as a PDF or an image.
                    const outcome = failed ? 'error' : output || !tool?.mcp ? 'ok' : 'no result';
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
            await sleep(wait, undefined, {signal: request.signal});
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
            return unavailable ? {...result, unavailable} : result;
        }

        /** Whether the run failed because the model's quota is used up, asked of `/usage` whatever agy said. */
        async function usedUp({result, exited}: Attempt): Promise<string | null> {
            await harness.usage('agy', {signal: request.signal}).catch(() => []);
            const group = agyQuotaGroup(model);
            const named = group ? `agy's ${group} quota` : `agy's quota for ${model}`;
            const until = harness.heldUntil('agy', model);
            if (until) return `${named} is used up until ${clock(until)}`;
            return QUOTA.test(`${result?.error ?? ''} ${exited?.stderr ?? ''}`) ? `${named} is used up` : null;
        }

        function settle({result, exited, spawnError, grants}: Attempt): AgentRunResult {
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
            const {value: structured, unquoted} = unquoteKeys(result.structured_output);
            if (unquoted.length > 0) {
                request.onEvent({
                    at: now(),
                    type: 'note',
                    label: `Took the quotes off ${unquoted.length} key(s) ${shown} wrote inside them`,
                    detail: unquoted.join('\n'),
                });
            }
            return {ok: true, structured};
        }
    } catch (e) {
        return fail(errorMessage(e));
    } finally {
        await servers?.close();
        await rm(workspace, {recursive: true, force: true});
    }
}

/** The models agy offers, for a model stored as `agy:<id>`. */
export function agyBackend(harness: AgentHarness): AgentBackend {
    return {
        id: 'agy',
        owns: isAgyModel,
        // None while agy is not installed or not signed in, never a failure.
        listModels: () => harness.models('agy').then((models) => models.map(agyOption), () => []),
        heldUntil: (model) => harness.heldUntil('agy', model.slice(AGY_MODEL_PREFIX.length)),
        status: () => harness.status('agy'),
        run: (request) => runAgy(harness, request),
    };
}
