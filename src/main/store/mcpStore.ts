import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { currentWorkspace, mcpTrustFile, pathKey } from '../paths';
import type { AgentMcpServer } from '../agents/types';
import { readJson, writeJson } from './jsonFile';
import { getSettings } from './settingsStore';
import {
    EMAIL_SERVER_NAME,
    isUsableServerName,
    type McpListing,
    type McpServerEntry,
    type McpServerSetting,
    type McpTransport,
    serverSummary,
    WORKSPACE_MCP_FILES,
    type WorkspaceMcpFile,
} from '@shared/settings';

/**
 * The MCP servers a node can be handed: those in Settings, and those the open
 * workspace defines in the files other tools keep them in — Claude Code's
 * `.mcp.json`, VS Code's, Cursor's and Gemini CLI's. A workspace's server is a
 * command someone else may have written, so none is started — not even to list
 * its tools — until it has been allowed here, and allowing it holds only while
 * its file still says what it said then.
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
    hash?: string;
    launch?: UsableServer['launch'];
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
 * `${VAR}`, `${VAR:-default}` and `${env:VAR}` from Patchbay's environment;
 * `${workspaceFolder}`, `${userHome}` and `${pathSeparator}` as VS Code means
 * them. Gemini CLI's files also take a bare `$VAR`. A variable that is not set
 * fails the server rather than leaving a hole in its command.
 */
function expander(file: WorkspaceMcpFile, root: string): (text: string) => string {
    const pattern = file === '.gemini/settings.json' ? /\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g : /\$\{([^}]*)\}/g;
    const fromEnv = (name: string, fallback?: string): string => {
        const value = process.env[name];
        if (value !== undefined && value !== '') return value;
        if (fallback !== undefined) return fallback;
        throw new Error(`It needs \${${name}}, which is not set in Patchbay's environment.`);
    };
    return (text) =>
        text.replace(pattern, (whole, braced: string | undefined, bare: string | number | undefined) => {
            if (typeof bare === 'string') return fromEnv(bare);
            const inner = braced!.trim();
            if (inner === 'workspaceFolder' || inner === 'workspaceRoot') return root;
            if (inner === 'userHome') return homedir();
            if (inner === 'pathSeparator' || inner === '/') return sep;
            if (inner.startsWith('env:')) return fromEnv(inner.slice(4));
            if (inner.startsWith('input:')) {
                throw new Error(`It asks for ${whole} when it starts, and Patchbay has no one to ask.`);
            }
            const withDefault = /^([A-Za-z_][A-Za-z0-9_]*):-(.*)$/s.exec(inner);
            if (withDefault) return fromEnv(withDefault[1]!, withDefault[2]);
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return fromEnv(inner);
            throw new Error(`It uses ${whole}, which Patchbay cannot fill in.`);
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
function launchOf(file: WorkspaceMcpFile, def: Definition, root: string): UsableServer['launch'] {
    const fill = expander(file, root);
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

function settingsEntry(server: McpServerSetting): Found {
    const type = server.type ?? 'stdio';
    const launch: UsableServer['launch'] =
        type === 'stdio'
            ? {
                type,
                ...unwrapCmd(server.command, server.args),
                ...(server.env && Object.keys(server.env).length > 0 ? {env: server.env} : {}),
            }
            : {
                type,
                url: server.url ?? '',
                ...(server.headers && Object.keys(server.headers).length > 0 ? {headers: server.headers} : {}),
            };
    const entry: McpServerEntry = {
        name: server.name,
        source: 'settings',
        type,
        summary: serverSummary(launch.type === 'stdio' ? {
            type,
            command: launch.command,
            args: launch.args ?? []
        } : server),
        envKeys: type === 'stdio' ? Object.keys(server.env ?? {}) : [],
        headerKeys: type === 'stdio' ? [] : Object.keys(server.headers ?? {}),
        state: 'allowed',
    };
    if (server.name === EMAIL_SERVER_NAME) {
        return {
            entry: {
                ...entry,
                state: 'invalid',
                problem: `"${EMAIL_SERVER_NAME}" is the name of Patchbay's own email tools.`
            }
        };
    }
    if (type === 'stdio' ? !server.command.trim() : !server.url?.trim()) {
        return {
            entry: {
                ...entry,
                state: 'invalid',
                problem: type === 'stdio' ? 'It has no command.' : 'It has no URL.'
            }
        };
    }
    return {entry, launch};
}

function scan(): { workspace: string | null; found: Found[]; unreadable: McpListing['unreadable'] } {
    const found: Found[] = [];
    const unreadable: McpListing['unreadable'] = [];
    const inSettings = new Set<string>();
    for (const server of getSettings().mcpServers) {
        if (!server.enabled || !server.name.trim()) continue;
        inSettings.add(server.name);
        found.push(settingsEntry(server));
    }

    const root = currentWorkspace();
    if (!root) return {workspace: null, found, unreadable};
    const trusted = readTrust()[pathKey(root)] ?? {};
    /** Which file each name was first found in: the first is used. */
    const taken = new Map<string, WorkspaceMcpFile>();

    for (const file of WORKSPACE_MCP_FILES) {
        const path = join(root, file);
        if (!existsSync(path)) continue;
        let servers: Record<string, unknown>;
        try {
            const parsed = parseJsonc(readFileSync(path, 'utf8'));
            if (!isObject(parsed)) throw new Error('It is not a JSON object.');
            servers = serverMap(file, parsed);
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
            if (inSettings.has(name)) {
                found.push({
                    entry: {
                        ...entry,
                        state: 'shadowed',
                        problem: `Settings has a server named ${name} switched on, which is used instead.`
                    },
                });
                continue;
            }

            const hash = hashOf(def);
            let launch: UsableServer['launch'];
            try {
                launch = launchOf(file, def, root);
            } catch (e) {
                invalid(e instanceof Error ? e.message : String(e));
                continue;
            }
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
            found.push({entry: {...entry, state}, hash, launch});
        }
    }
    return {workspace: root, found, unreadable};
}

/** Every server a window can show, holding no secrets. */
export function listMcpServers(): McpListing {
    const {workspace, found, unreadable} = scan();
    return {workspace, servers: found.map((f) => f.entry), unreadable};
}

function usableIn(found: Found[]): Map<string, UsableServer> {
    const usable = new Map<string, UsableServer>();
    for (const {entry, launch} of found) {
        if (entry.state === 'allowed' && launch && !usable.has(entry.name)) {
            usable.set(entry.name, {name: entry.name, source: entry.source, launch});
        }
    }
    return usable;
}

/** The servers a run can be handed now, by name. */
export const usableServers = (): Map<string, UsableServer> => usableIn(scan().found);

/** One server a run or a listing can use, or an error saying what stands in its way. */
export function requireServer(name: string): UsableServer {
    const {found} = scan();
    const usable = usableIn(found).get(name);
    if (usable) return usable;
    const entry = found.find((f) => f.entry.name === name && f.entry.state !== 'shadowed')?.entry;
    if (!entry && getSettings().mcpServers.some((s) => s.name === name)) {
        throw new Error(`The MCP server "${name}" is switched off in Settings → MCP servers.`);
    }
    if (!entry) throw new Error(`There is no MCP server "${name}" in Settings or in this workspace.`);
    switch (entry.state) {
        case 'new':
            throw new Error(`${name} is defined in ${entry.source}, and has not been allowed to run yet. Allow it in the start window’s MCP tab, the inspector, or Settings → MCP servers.`);
        case 'changed':
            throw new Error(`${entry.source} has changed what ${name} starts since it was allowed. Allow it again in the start window’s MCP tab, the inspector, or Settings → MCP servers.`);
        case 'blocked':
            throw new Error(`${name}, from ${entry.source}, was not allowed to run here.`);
        default:
            throw new Error(`${name} cannot be used: ${entry.problem ?? 'its definition is incomplete.'}`);
    }
}

/**
 * Allow a workspace server to run, or refuse it, as its file defines it now.
 * Settings' servers need neither: whoever added one there allowed it.
 */
export function setServerTrust(name: string, allowed: boolean): McpListing {
    const {workspace, found} = scan();
    if (!workspace) throw new Error('No workspace is open.');
    const server = found.find((f) => f.entry.source !== 'settings' && f.entry.name === name && f.hash !== undefined);
    if (!server?.hash) throw new Error(`This workspace defines no server "${name}" that can be allowed.`);
    const trust = readTrust();
    const key = pathKey(workspace);
    trust[key] = {...trust[key], [name]: {hash: server.hash, allowed, at: new Date().toISOString()}};
    writeJson(mcpTrustFile(), trust);
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
