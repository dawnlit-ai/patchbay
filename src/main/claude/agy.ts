import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { AGY_MODEL_PREFIX } from '@shared/flow';
import type { ModelOption } from '@shared/ipc';
import { GLOBAL_SKILL_PLUGIN, isGlobalRef } from '@shared/settings';
import { now, truncate } from '@shared/trace';
import { serveOnLoopback } from './loopback';
import type { ClaudeRunRequest, ClaudeRunResult } from './runner';

/**
 * Gemini through the Antigravity CLI (`agy`), for a node whose model is stored as
 * `agy:<id>`. Each run gets a workspace of its own, and a plugin in it that hands
 * agy the run's MCP servers and its ticked skills, with a hook that refuses every
 * tool the node was not given: agy has no switch to leave its own shell, browser
 * or web search out. The hook can refuse but not grant. Headless, agy calls an MCP
 * tool only when the user's own agy settings allow it, so each needs a rule there.
 */

/** Where agy installs itself; an app opened from the Finder has no shell PATH to find it by. */
function resolveAgyPath(): string {
    const candidates =
        process.platform === 'win32'
            ? [join(homedir(), '.local', 'bin', 'agy.exe')]
            : [join(homedir(), '.local', 'bin', 'agy'), '/usr/local/bin/agy'];
    return candidates.find((p) => existsSync(p)) ?? 'agy';
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
    args: string[],
    options: { cwd?: string; input?: string; signal?: AbortSignal; onLine?(line: string): void } = {},
): Promise<Exited> {
    return new Promise((resolve, reject) => {
        const child = spawn(resolveAgyPath(), args, { cwd: options.cwd, signal: options.signal });
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

let modelsAsked: { at: number; list: Promise<ModelOption[]> } | null = null;

async function askForModels(): Promise<ModelOption[]> {
    const lines: string[] = [];
    const { code } = await runAgyCommand(['models'], { onLine: (line) => lines.push(line) });
    if (code !== 0) return [];
    return lines
        .map((line) => line.split('\t') as [string, string?])
        // Gemini only: the Claude models agy also offers are better run directly.
        .filter((row): row is [string, string] => row[0].startsWith('gemini-') && !!row[1])
        .map(([id, name]) => ({
            value: `${AGY_MODEL_PREFIX}${id}`,
            displayName: `${name.trim()} · agy`,
            description:
                `Gemini through the Antigravity CLI (agy), on its own Google login. Each MCP tool a step calls needs a rule in ${AGY_SETTINGS}, and a Processor with file-system access cannot run on it.`,
            // The level is part of the id.
            effortLevels: [],
        }));
}

/** The Gemini models agy offers. Empty when agy is not installed or not signed in, never a failure. */
export function listAgyModels(): Promise<ModelOption[]> {
    if (modelsAsked && Date.now() - modelsAsked.at < MODELS_TTL_MS) return modelsAsked.list;
    const asked = { at: Date.now(), list: askForModels().catch(() => []) };
    modelsAsked = asked;
    return asked.list;
}

/** The run's MCP servers as agy's plugin config: the in-process ones served on loopback. */
async function pluginServers(
    servers: Record<string, McpServerConfig>,
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
            } else if (server.type === undefined || server.type === 'stdio') {
                config[name] = {
                    command: server.command,
                    args: server.args ?? [], ...(server.env ? { env: server.env } : {})
                };
            } else {
                throw new Error(`agy is not handed ${server.type} servers yet, so it cannot reach ${name}.`);
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

/**
 * Each ticked skill, copied to where agy finds skills: `.agents/skills/<name>`.
 * A global one comes from the plugin the node built for Claude, a flow's own from
 * its `.claude/skills`.
 */
async function copySkills(request: ClaudeRunRequest, workspace: string): Promise<string[]> {
    const copied: string[] = [];
    for (const ref of request.skills ?? []) {
        const name = isGlobalRef(ref) ? ref.slice(GLOBAL_SKILL_PLUGIN.length + 1) : ref;
        const from = isGlobalRef(ref)
            ? request.plugins?.map((p) => join(p.path, 'skills', name)).find((p) => existsSync(p))
            : join(request.cwd, '.claude', 'skills', name);
        if (!from || !existsSync(from)) continue;
        await cp(from, join(workspace, '.agents', 'skills', name), { recursive: true, dereference: true });
        copied.push(name);
    }
    return copied;
}

/** How the node's Claude wording maps onto agy, after its prompt. */
function environmentNotes(servers: string[], skills: string[]): string[] {
    const one = skills.length === 1;
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
                `Before anything else, read the skill${one ? '' : 's'} this step is given — ${skills.map((s) => `\`${s}\``).join(', ')}, ` +
                `also written \`global:<name>\` — at .agents/skills/<name>/SKILL.md, and follow ${one ? 'it' : 'them'}. ` +
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

export async function runAgy(request: ClaudeRunRequest): Promise<ClaudeRunResult> {
    const model = request.model.slice(AGY_MODEL_PREFIX.length);
    const fail = (error: string): ClaudeRunResult => {
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
        const folders = [...new Set([request.cwd, ...(request.additionalDirectories ?? [])])];
        // A Categorizer's one judgement reads nothing, so it is given no folder to read.
        const readable = request.tools?.length === 0 && serverNames.length === 0 ? [] : folders;
        const agyHome = join(homedir(), '.gemini', 'antigravity-cli');
        const roots = [workspace, ...readable, join(agyHome, 'mcp')];
        const granted = mcpGrants(request.allowedTools, serverNames);

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
        if (request.jsonSchema) {
            const schemaFile = join(workspace, 'schema.json');
            await writeFile(schemaFile, JSON.stringify(request.jsonSchema));
            args.push('--json-schema', schemaFile);
        }
        for (const folder of readable) args.push('--add-dir', folder);

        const prompt = [request.prompt, ...(request.tools?.length === 0 && serverNames.length === 0 ? [] : environmentNotes(serverNames, skills))].join('\n');
        request.onEvent({
            at: now(),
            type: 'prompt',
            label: `Prompt to ${model} (agy)`,
            detail: truncate(prompt, 20_000),
        });

        const tools = new Map<number, ReturnType<typeof describeTool>>();
        const texts = new Map<number, string>();
        const grants = new Set<string>();
        let result: StreamLine['result'];

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
                result = line.result;
                return;
            }
            const step = line.step_update;
            if (!step) return;
            if (step.step_type === 'agent_response') {
                const text = (texts.get(step.step_index) ?? '') + (step.text_delta ?? '');
                texts.set(step.step_index, text);
                if (step.state === 'DONE' && text.trim()) {
                    request.onEvent({ at: now(), type: 'assistant', label: text.trim().slice(0, 160), detail: text });
                }
                return;
            }
            if (step.step_type !== 'tool' || !step.tool_info) return;
            if (!tools.has(step.step_index)) {
                const tool = describeTool(step.tool_info);
                tools.set(step.step_index, tool);
                // Only what the hook lets through can have been refused by agy's settings.
                const server = tool.mcp?.split('/')[0];
                if (tool.mcp && (granted.includes(tool.mcp) || granted.includes(`${server}/*`))) grants.add(`mcp(${tool.mcp})`);
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

        let exited: Exited;
        try {
            exited = await runAgyCommand(args, { cwd: workspace, input: prompt, signal: request.signal, onLine });
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                return fail('agy is not installed, or not where this app looks for it (~/.local/bin).');
            }
            return fail(e instanceof Error ? e.message : String(e));
        }

        if (!result) {
            return fail(`agy exited with ${exited.code} and no result: ${exited.stderr.trim() || '(nothing on stderr)'}`);
        }
        const usage = result.usage ?? {};
        request.onEvent({
            at: now(),
            type: 'note',
            label: `agy ${model} finished in ${result.duration_seconds?.toFixed(1) ?? '?'}s`,
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
        if (result.status !== 'SUCCESS' || exited.code !== 0) {
            return fail(`agy ended with ${result.status ?? `exit ${exited.code}`}: ${result.error ?? exited.stderr.trim()}`);
        }
        if (request.jsonSchema && result.structured_output === undefined) {
            return fail('agy returned no structured output for the requested schema.');
        }
        return { ok: true, structured: result.structured_output };
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    } finally {
        await servers?.close();
        await rm(workspace, { recursive: true, force: true });
    }
}
