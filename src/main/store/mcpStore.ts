import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { currentWorkspace, mcpTrustFile, pathKey } from '../paths';
import type { AgentMcpServer } from '../agents/types';
import { readJson, writeJson } from './jsonFile';
import { secretNames, serverSecrets, setSecret } from './secretStore';
import {
    EMAIL_SERVER_NAME,
    isUsableServerName,
    type McpListing,
    type McpServerEntry,
    type McpTransport,
    type McpVariable,
    serverSummary,
    WORKSPACE_MCP_FILES,
    type WorkspaceMcpFile,
} from '@shared/settings';

/**
 * The MCP servers a node can be handed: those the open workspace defines in the
 * files other tools keep them in — Claude Code's `.mcp.json`, VS Code's, Cursor's
 * and Gemini CLI's. Patchbay keeps none of its own: one wanted in every project
 * belongs to the agent it was added to, for that agent's own sessions. A
 * workspace's server is a command someone else may have written, so none is
 * started — not even to list its tools — until it has been allowed here, and
 * allowing it holds only while its file still says what it said then. A value
 * its definition looks up can be set for it here, kept encrypted in the app's
 * data, and is read only when the server is started.
 */

/** A server that can be started or connected to, and where it was defined. */
export interface UsableServer {
    name: string;
    source: McpServerEntry['source'];
    launch: Exclude<AgentMcpServer, { type: 'sdk' }>;
}

/** A server as its file defines it, before any variable is filled in. What is allowed is this. */
interface Definition {
    type: McpTransport;
    command: string;
    args: string[];
    env: Record<string, string>;
    url: string;
    headers: Record<string, string>;
    cwd: string;
}

interface Found {
    entry: McpServerEntry;
    /** Present for a server that can be allowed: not one shadowed, nor one Patchbay cannot read. */
    hash?: string;
    file?: WorkspaceMcpFile;
    def?: Definition;
}

// ── Reading the files ─────────────────────────────────────────────────────

/**
 * JSON with comments and trailing commas, as VS Code writes its own. Both are
 * taken out with strings left alone, then the rest is ordinary JSON.
 */
export function parseJsonc(text: string): unknown {
    const source = text.replace(/^\uFEFF/, '');
    let bare = '';
    for (let i = 0; i < source.length; i++) {
        const c = source[i]!;
        if (c === '"') {
            const end = stringEnd(source, i);
            bare += source.slice(i, end);
            i = end - 1;
        } else if (c === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') i++;
            bare += '\n';
        } else if (c === '/' && source[i + 1] === '*') {
            const end = source.indexOf('*/', i + 2);
            i = end < 0 ? source.length : end + 1;
        } else {
            bare += c;
        }
    }
    let json = '';
    for (let i = 0; i < bare.length; i++) {
        const c = bare[i]!;
        if (c === '"') {
            const end = stringEnd(bare, i);
            json += bare.slice(i, end);
            i = end - 1;
        } else if (c === ',' && /^\s*[}\]]/.test(bare.slice(i + 1))) {
            // A trailing comma: dropped.
        } else {
            json += c;
        }
    }
    return JSON.parse(json);
}

/** Where the string starting at `start`'s opening quote ends, past its closing one. */
function stringEnd(text: string, start: number): number {
    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') return i + 1;
    }
    return text.length;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Where in its file a server list is: VS Code calls it `servers`, the rest `mcpServers`. */
function serverMap(file: WorkspaceMcpFile, root: Record<string, unknown>): Record<string, unknown> {
    const map = file === '.vscode/mcp.json' ? root.servers : root.mcpServers;
    return isObject(map) ? map : {};
}

/** An object of strings: environment variables or headers. Numbers and booleans are written as text. */
function stringMap(value: unknown, what: string): Record<string, string> {
    if (value === undefined) return {};
    if (!isObject(value)) throw new Error(`Its ${what} is not an object of names and values.`);
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(value)) {
        if (typeof v === 'string') out[key] = v;
        else if (typeof v === 'number' || typeof v === 'boolean') out[key] = String(v);
        else throw new Error(`Its ${what} gives ${key} a value that is not text.`);
    }
    return out;
}

/** Which transport a definition means, as each tool spells it. */
function transportOf(file: WorkspaceMcpFile, def: Record<string, unknown>): McpTransport {
    const declared = def.type;
    if (typeof declared === 'string') {
        const t = declared.toLowerCase();
        if (t === 'stdio') return 'stdio';
        if (t === 'http' || t === 'streamable-http' || t === 'streamablehttp') return 'http';
        if (t === 'sse') return 'sse';
        throw new Error(`Its type "${declared}" is not one Patchbay knows: stdio, http or sse.`);
    }
    if (typeof def.command === 'string') return 'stdio';
    // Gemini CLI: httpUrl is Streamable HTTP, url the older SSE.
    if (file === '.gemini/settings.json') {
        if (typeof def.httpUrl === 'string') return 'http';
        if (typeof def.url === 'string') return 'sse';
    }
    if (typeof def.url === 'string' || typeof def.serverUrl === 'string') return 'http';
    throw new Error('It has neither a command to start nor a url to connect to.');
}

/** A server as its file defines it, read strictly: anything Patchbay would have to guess at is refused. */
function readDefinition(file: WorkspaceMcpFile, raw: unknown): Definition {
    if (!isObject(raw)) throw new Error('Its definition is not an object.');
    if (raw.disabled === true) throw new Error(`It is switched off in ${file}.`);
    if (raw.envFile !== undefined) throw new Error('It reads an envFile, which Patchbay does not.');
    const type = transportOf(file, raw);
    const def: Definition = {type, command: '', args: [], env: {}, url: '', headers: {}, cwd: ''};
    if (type === 'stdio') {
        if (typeof raw.command !== 'string' || !raw.command.trim()) throw new Error('It has no command to start.');
        def.command = raw.command;
        if (raw.args !== undefined) {
            if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
                throw new Error('Its args are not a list of text.');
            }
            def.args = raw.args as string[];
        }
        def.env = stringMap(raw.env, 'env');
        if (raw.cwd !== undefined) {
            if (typeof raw.cwd !== 'string') throw new Error('Its cwd is not text.');
            def.cwd = raw.cwd;
        }
    } else {
        const url = file === '.gemini/settings.json' && type === 'http' ? raw.httpUrl : (raw.url ?? raw.serverUrl);
        if (typeof url !== 'string' || !url.trim()) throw new Error('It has no url to connect to.');
        def.url = url;
        def.headers = stringMap(raw.headers, 'headers');
    }
    return def;
}

// ── Filling in variables ──────────────────────────────────────────────────

/**
 * A `${…}` that is looked up rather than known: `name` is what a value set for
 * the server is kept under, `env` where Patchbay's environment is looked in
 * after that — never, for VS Code's prompted `${input:…}` — and `fallback` the
 * definition's own default.
 */
interface Lookup {
    name: string;
    env?: string;
    fallback?: string;
}

/** Gemini CLI's files also take a bare `$VAR`. */
const variablePattern = (file: WorkspaceMcpFile): RegExp =>
    file === '.gemini/settings.json' ? /\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g : /\$\{([^}]*)\}/g;

/**
 * What one variable stands for. `${workspaceFolder}`, `${userHome}` and
 * `${pathSeparator}` are known, as VS Code means them; `${VAR}`, `${VAR:-default}`,
 * `${env:VAR}` and `${input:id}` are looked up. Anything else is refused.
 */
function variable(whole: string, braced: string | undefined, bare: string | undefined, root: string): {
    known: string
} | Lookup {
    if (bare !== undefined) return {name: bare, env: bare};
    const inner = braced!.trim();
    if (inner === 'workspaceFolder' || inner === 'workspaceRoot') return {known: root};
    if (inner === 'userHome') return {known: homedir()};
    if (inner === 'pathSeparator' || inner === '/') return {known: sep};
    const named = inner.startsWith('env:') ? inner.slice(4).trim() : inner.startsWith('input:') ? inner.slice(6).trim() : null;
    if (named) return inner.startsWith('env:') ? {name: named, env: named} : {name: `input:${named}`};
    const withDefault = /^([A-Za-z_][A-Za-z0-9_]*):-(.*)$/s.exec(inner);
    if (withDefault) return {name: withDefault[1]!, env: withDefault[1]!, fallback: withDefault[2]!};
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return {name: inner, env: inner};
    throw new Error(`It uses ${whole}, which Patchbay cannot fill in.`);
}

/** Every text of a definition a variable can be written in. */
const textsOf = (def: Definition): string[] =>
    [def.command, ...def.args, ...Object.values(def.env), def.url, ...Object.values(def.headers), def.cwd];

/**
 * What a definition looks up, each once, in the order it first names them. A
 * default counts only where every use of the name gives one. Throws on a
 * variable Patchbay cannot fill in.
 */
function lookupsOf(file: WorkspaceMcpFile, def: Definition, root: string): Lookup[] {
    const seen = new Map<string, Lookup>();
    for (const text of textsOf(def)) {
        for (const match of text.matchAll(variablePattern(file))) {
            const part = variable(match[0], match[1], match[2], root);
            if ('known' in part) continue;
            const earlier = seen.get(part.name);
            if (!earlier) seen.set(part.name, part);
            else if (part.fallback === undefined) delete earlier.fallback;
        }
    }
    return [...seen.values()];
}

/** Set in Patchbay's environment, an empty value counting as unset. */
const fromEnv = (name: string | undefined): string | undefined =>
    name !== undefined && process.env[name] ? process.env[name] : undefined;

function sourceOf(lookup: Lookup, set: Set<string>): McpVariable['source'] {
    if (set.has(lookup.name)) return 'set';
    if (fromEnv(lookup.env) !== undefined) return 'environment';
    return lookup.fallback !== undefined ? 'default' : 'missing';
}

/**
 * Fills in each variable: from the values set for this server, then Patchbay's
 * environment, then the definition's default. One with none of them fails the
 * server rather than leaving a hole in its command.
 */
function filler(file: WorkspaceMcpFile, root: string, values: Record<string, string>): (text: string) => string {
    return (text) =>
        // With one group, as all but Gemini CLI's pattern have, the offset arrives where `bare` would.
        text.replace(variablePattern(file), (whole, braced: string | undefined, bare: string | number | undefined) => {
            const part = variable(whole, braced, typeof bare === 'string' ? bare : undefined, root);
            if ('known' in part) return part.known;
            const value = values[part.name] ?? fromEnv(part.env) ?? part.fallback;
            if (value === undefined) throw new Error(`It needs a value for ${part.name}, which is not set for it.`);
            return value;
        });
}

const mapValues = (map: Record<string, string>, fn: (v: string) => string): Record<string, string> =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, fn(v)]));

/**
 * MCP configs written on Windows often wrap `npx` or `uvx` in `cmd /c …`
 * because Windows cannot spawn a `.cmd` shim directly. On macOS and Linux
 * there is no `cmd`, and the wrapped program runs directly.
 */
function unwrapCmd(command: string, args: string[]): { command: string; args: string[] } {
    if (process.platform === 'win32') return {command, args};
    const inline = /^cmd(?:\.exe)?\s+\/[cC]\s+(.+)$/i.exec(command.trim());
    if (inline?.[1]) {
        const parts = inline[1].trim().split(/\s+/);
        return {command: parts[0]!, args: [...parts.slice(1), ...args]};
    }
    if (/^cmd(?:\.exe)?$/i.test(command.trim()) && /^\/[cC]$/.test(args[0]?.trim() ?? '') && args[1]?.trim()) {
        if (args.length === 2 && /\s/.test(args[1])) {
            const parts = args[1].trim().split(/\s+/);
            return {command: parts[0]!, args: parts.slice(1)};
        }
        return {command: args[1].trim(), args: args.slice(2)};
    }
    return {command, args};
}

/** The definition with its variables filled in, as a run is handed it. */
function launchOf(file: WorkspaceMcpFile, def: Definition, root: string, values: Record<string, string>): UsableServer['launch'] {
    const fill = filler(file, root, values);
    if (def.type === 'stdio') {
        const env = mapValues(def.env, fill);
        const {command, args} = unwrapCmd(fill(def.command), def.args.map(fill));
        return {
            type: 'stdio',
            command,
            args,
            ...(Object.keys(env).length > 0 ? {env} : {}),
            // Relative to the workspace, which is where a run of its flows works.
            cwd: def.cwd ? resolve(root, fill(def.cwd)) : root,
        };
    }
    const headers = mapValues(def.headers, fill);
    return {type: def.type, url: fill(def.url), ...(Object.keys(headers).length > 0 ? {headers} : {})};
}

const hashOf = (def: Definition): string => createHash('sha256').update(JSON.stringify(def)).digest('hex');

// ── Allowing ──────────────────────────────────────────────────────────────

interface TrustRecord {
    /** The definition allowed or refused: a different one is asked about afresh. */
    hash: string;
    allowed: boolean;
    at: string;
}

type TrustFile = Record<string, Record<string, TrustRecord>>;

const readTrust = (): TrustFile => {
    const raw = readJson<unknown>(mcpTrustFile(), {});
    return isObject(raw) ? (raw as TrustFile) : {};
};

// ── The list ──────────────────────────────────────────────────────────────

function scan(): { workspace: string | null; found: Found[]; unreadable: McpListing['unreadable'] } {
    const found: Found[] = [];
    const unreadable: McpListing['unreadable'] = [];
    const root = currentWorkspace();
    if (!root) return {workspace: null, found, unreadable};
    const trusted = readTrust()[pathKey(root)] ?? {};
    const secrets = secretNames(pathKey(root));
    /** Which file each name was first found in: the first is used. */
    const taken = new Map<string, WorkspaceMcpFile>();

    for (const file of WORKSPACE_MCP_FILES) {
        const path = join(root, file);
        if (!existsSync(path)) continue;
        let servers: Record<string, unknown>;
        /** What VS Code's `inputs` say each `${input:…}` is, by the name its value is kept under. */
        const described = new Map<string, string>();
        try {
            const parsed = parseJsonc(readFileSync(path, 'utf8'));
            if (!isObject(parsed)) throw new Error('It is not a JSON object.');
            servers = serverMap(file, parsed);
            for (const input of Array.isArray(parsed.inputs) ? parsed.inputs : []) {
                if (isObject(input) && typeof input.id === 'string' && typeof input.description === 'string') {
                    described.set(`input:${input.id.trim()}`, input.description);
                }
            }
        } catch (e) {
            unreadable.push({source: file, problem: e instanceof Error ? e.message : String(e)});
            continue;
        }
        for (const [name, raw] of Object.entries(servers)) {
            const entry: McpServerEntry = {
                name,
                source: file,
                type: 'stdio',
                summary: '',
                envKeys: [],
                headerKeys: [],
                variables: [],
                state: 'invalid',
            };
            const invalid = (problem: string): void => void found.push({entry: {...entry, problem}});
            let def: Definition;
            try {
                def = readDefinition(file, raw);
            } catch (e) {
                invalid(e instanceof Error ? e.message : String(e));
                continue;
            }
            entry.type = def.type;
            const stdio = def.type === 'stdio' ? unwrapCmd(def.command, def.args) : null;
            entry.summary = serverSummary(stdio ? {...def, command: stdio.command, args: stdio.args} : def);
            entry.envKeys = Object.keys(def.env);
            entry.headerKeys = Object.keys(def.headers);

            if (!isUsableServerName(name)) {
                invalid('A server name here has to be letters, digits, - and _ only, so its tools are named alike on every agent.');
                continue;
            }
            if (name === EMAIL_SERVER_NAME) {
                invalid(`"${EMAIL_SERVER_NAME}" is the name of Patchbay's own email tools.`);
                continue;
            }
            const earlier = taken.get(name);
            if (earlier) {
                found.push({
                    entry: {
                        ...entry,
                        state: 'shadowed',
                        problem: `${earlier} also defines ${name}, and is read first.`
                    }
                });
                continue;
            }
            taken.set(name, file);

            let lookups: Lookup[];
            try {
                lookups = lookupsOf(file, def, root);
            } catch (e) {
                invalid(e instanceof Error ? e.message : String(e));
                continue;
            }
            const set = secrets.get(name) ?? new Set<string>();
            entry.variables = lookups.map((lookup) => {
                const description = described.get(lookup.name);
                return {name: lookup.name, source: sourceOf(lookup, set), ...(description ? {description} : {})};
            });

            const hash = hashOf(def);
            const record = trusted[name];
            const state = !record
                ? 'new'
                : record.hash !== hash
                    ? record.allowed
                        ? 'changed'
                        : 'new'
                    : record.allowed
                        ? 'allowed'
                        : 'blocked';
            found.push({entry: {...entry, state}, hash, file, def});
        }
    }
    return {workspace: root, found, unreadable};
}

/** Every server a window can show, holding no secrets. */
export function listMcpServers(): McpListing {
    const {workspace, found, unreadable} = scan();
    return {workspace, servers: found.map((f) => f.entry), unreadable};
}

const missingIn = (entry: McpServerEntry): string[] =>
    entry.variables.filter((v) => v.source === 'missing').map((v) => v.name);

/**
 * The servers a run could be handed now, by name: allowed, with every value
 * they look up to be had. None is started, and no value is opened, to say so.
 */
export function usableServers(): Set<string> {
    return new Set(scan().found.filter(({
                                            entry,
                                            def
                                        }) => entry.state === 'allowed' && def && missingIn(entry).length === 0)
        .map(({entry}) => entry.name));
}

/**
 * One server as a run or a listing starts it, its variables filled in with the
 * values set for it, or an error saying what stands in its way.
 */
export async function requireServer(name: string): Promise<UsableServer> {
    const {workspace, found} = scan();
    const server = found.find((f) => f.entry.name === name && f.entry.state !== 'shadowed');
    if (!workspace || !server) throw new Error(`There is no MCP server "${name}" in this workspace.`);
    const {entry, file, def} = server;
    switch (entry.state) {
        case 'new':
            throw new Error(`${name} is defined in ${entry.source}, and has not been allowed to run yet. Allow it in the start window’s MCP tab or the inspector.`);
        case 'changed':
            throw new Error(`${entry.source} has changed what ${name} starts since it was allowed. Allow it again in the start window’s MCP tab or the inspector.`);
        case 'blocked':
            throw new Error(`${name}, from ${entry.source}, was not allowed to run here.`);
        case 'allowed':
            break;
        default:
            throw new Error(`${name} cannot be used: ${entry.problem ?? 'its definition is incomplete.'}`);
    }
    if (!file || !def) throw new Error(`${name} cannot be used: its definition could not be read.`);
    const missing = missingIn(entry);
    if (missing.length > 0) {
        throw new Error(
            `${name} needs a value for ${missing.join(', ')}, which is set neither for it nor in Patchbay’s environment. Set it in the start window’s MCP tab or the inspector.`,
        );
    }
    const values = await serverSecrets(pathKey(workspace), name);
    return {name, source: entry.source, launch: launchOf(file, def, workspace, values)};
}

/** Allow a workspace server to run, or refuse it, as its file defines it now. */
export function setServerTrust(name: string, allowed: boolean): McpListing {
    const {workspace, found} = scan();
    if (!workspace) throw new Error('No workspace is open.');
    const server = found.find((f) => f.entry.name === name && f.hash !== undefined);
    if (!server?.hash) throw new Error(`This workspace defines no server "${name}" that can be allowed.`);
    const trust = readTrust();
    const key = pathKey(workspace);
    trust[key] = {...trust[key], [name]: {hash: server.hash, allowed, at: new Date().toISOString()}};
    writeJson(mcpTrustFile(), trust);
    return listMcpServers();
}

/**
 * Set a value one of the workspace's servers looks up, or take it away with null,
 * which leaves the server to Patchbay's environment or its default. Kept for this
 * server alone, and never read back to a window.
 */
export async function setServerSecret(name: string, variable: string, value: string | null): Promise<McpListing> {
    const {workspace, found} = scan();
    if (!workspace) throw new Error('No workspace is open.');
    const server = found.find((f) => f.entry.name === name && f.def !== undefined);
    if (!server) throw new Error(`This workspace defines no server "${name}" a value can be set for.`);
    // Taking one away is let through even once the definition has stopped using it.
    if (value !== null && !server.entry.variables.some((v) => v.name === variable)) {
        throw new Error(`${name}’s definition does not look up ${variable}.`);
    }
    await setSecret(pathKey(workspace), name, variable, value);
    return listMcpServers();
}

/** Where one of the workspace's server files is, for opening in an editor. */
export function mcpFilePath(source: WorkspaceMcpFile): string {
    const root = currentWorkspace();
    if (!root) throw new Error('No workspace is open.');
    if (!(WORKSPACE_MCP_FILES as readonly string[]).includes(source)) throw new Error(`${source} is not a server file.`);
    const path = join(root, source);
    if (!existsSync(path)) throw new Error(`This workspace has no ${source} any more.`);
    return path;
}

const MCP_TEMPLATE = `${JSON.stringify({mcpServers: {}}, null, 2)}\n`;

/**
 * Write a `.mcp.json` at the top of the workspace folder when it has none,
 * and return its path for opening in an editor.
 */
export function createMcpFile(): string {
    const root = currentWorkspace();
    if (!root) throw new Error('No workspace is open.');
    const path = join(root, '.mcp.json');
    if (!existsSync(path)) writeFileSync(path, MCP_TEMPLATE, {encoding: 'utf-8', flag: 'wx'});
    return path;
}
