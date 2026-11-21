/** App-level settings, stored once per install rather than per flow. */

import { DEFAULT_MODEL, type ModelChoice } from './flow';

/**
 * How a server is reached: a command started on this computer, or an address.
 * `http` is MCP's Streamable HTTP; `sse` the older HTTP+SSE, which agy does not speak.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';

/** One tool a server offers, as the server describes it. */
export interface McpServerTool {
    name: string;
    description: string;
}

/**
 * The workspace files whose MCP servers Patchbay finds on its own, as paths
 * relative to the workspace, in the order a name defined twice is taken from.
 * These are the only servers a run is handed: one kept for every project is the
 * business of the agent it was added to, such as Claude Code or agy, for its own
 * sessions, and is never part of a run.
 */
export const WORKSPACE_MCP_FILES = ['.mcp.json', '.vscode/mcp.json', '.cursor/mcp.json', '.gemini/settings.json'] as const;

export type WorkspaceMcpFile = (typeof WORKSPACE_MCP_FILES)[number];

/**
 * Where a server a node can tick stands:
 * - `allowed` — allowed to run in this workspace: a run can be handed it.
 * - `new` — never allowed: nothing starts it until someone does.
 * - `changed` — allowed once, but its file has changed what it starts since, so it waits to be allowed again.
 * - `blocked` — refused in this workspace.
 * - `shadowed` — a file read earlier defines a server of that name, which is used instead.
 * - `invalid` — its definition cannot be used as written; `problem` says why.
 */
export type McpServerState = 'allowed' | 'new' | 'changed' | 'blocked' | 'shadowed' | 'invalid';

/**
 * A value a server's definition looks up — `${GITHUB_TOKEN}`, or VS Code's
 * `${input:github-token}` — and where it would come from if the server started now.
 * Never the value itself.
 */
export interface McpVariable {
    /** As the definition names it: `GITHUB_TOKEN`, or `input:github-token`. */
    name: string;
    /**
     * - `set` — set for this server in Patchbay, kept encrypted on this computer; it comes first.
     * - `environment` — found in Patchbay's environment. An `input:` is never looked for there.
     * - `default` — the definition's own, as in `${PORT:-3000}`.
     * - `missing` — none of these: nothing starts the server until it has one.
     */
    source: 'set' | 'environment' | 'default' | 'missing';
    /** What `.vscode/mcp.json`'s `inputs` says an `input:` is. */
    description?: string;
}

/**
 * One MCP server as the windows list it, found in the workspace.
 * Holds no secrets: an environment or a header is listed by its name alone.
 */
export interface McpServerEntry {
    name: string;
    /** The workspace file it was found in, such as `.mcp.json`. */
    source: WorkspaceMcpFile;
    type: McpTransport;
    /** What it starts or where it connects, as its definition words it, before any `${VAR}` is filled in. */
    summary: string;
    /** The names of the environment variables or headers it sets. */
    envKeys: string[];
    headerKeys: string[];
    /** The values its definition looks up, each once, in the order it first names them. */
    variables: McpVariable[];
    state: McpServerState;
    /** Why it is `invalid` or `shadowed`. */
    problem?: string;
}

/** Every MCP server a node in the open workspace could be handed, and the workspace files that could not be read. */
export interface McpListing {
    /** The open workspace's folder, or null with none open, when nothing is listed. */
    workspace: string | null;
    /** In the order their files are read. */
    servers: McpServerEntry[];
    unreadable: { source: WorkspaceMcpFile; problem: string }[];
}

/** What starts a server or where it connects, in a line, as the start window and the inspector show it. */
export function serverSummary(server: { type: McpTransport; command: string; args: string[]; url: string }): string {
    if (server.type !== 'stdio') return server.url;
    return [server.command, ...server.args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

/**
 * A server name Claude Code and agy both keep as it is, so `mcp__<name>__<tool>`
 * names the same tools on either.
 */
export const isUsableServerName = (name: string): boolean => /^[A-Za-z0-9_-]+$/.test(name);

/** The name of Patchbay's own email-scoped server in every run, which no other server may take. */
export const EMAIL_SERVER_NAME = 'email';

/** Patchbay's own MCP server, for an agent to drive the app. Off by default; loopback only, token required. */
export interface AgentControlSettings {
    enabled: boolean;
    port: number;
    /** Minted the first time the server is switched on, and shown in Settings. */
    token: string;
}

const DEFAULT_AGENT_CONTROL_PORT = 8787;

/**
 * The agents a step can run on: `claude` takes every model no other agent claims,
 * `agy` those stored as `agy:<id>`, and `jev` TypeSafe AI's, stored by their own
 * names (`jev-latest`), which answer a Categorizer's question and nothing else.
 */
export type AgentId = 'claude' | 'agy' | 'jev';

export const AGENT_IDS: AgentId[] = ['claude', 'agy', 'jev'];

/** What Settings and a run's trace call each agent. */
export const AGENT_NAMES: Record<AgentId, string> = {
    claude: 'Claude by Anthropic',
    agy: 'Antigravity by Google',
    jev: 'Jev by TypeSafe AI',
};

/**
 * The agents reached with an API key rather than a CLI signed in on this
 * computer, and the variable in Patchbay's environment that stands in for a key
 * not set in the app.
 */
export const AGENT_KEY_VARIABLES: Partial<Record<AgentId, string>> = {
    jev: 'TYPESAFE_AI_API_KEY',
};

/** Where an agent's API key comes from: set in Patchbay, Patchbay's environment, or nowhere yet. */
export type AgentKeySource = 'patchbay' | 'environment' | null;

/**
 * Off until switched on: each email a step on one of its models takes is sent to
 * a company the other agents do not send it to, so that is chosen, not assumed.
 */
const OFF_UNTIL_CHOSEN: AgentId[] = ['jev'];

/** One agent as Settings → Agents lists it. */
export interface AgentSetting {
    id: AgentId;
    /** Off, its models leave the model lists and a step on one goes straight to its next model. */
    enabled: boolean;
}

/**
 * The agents a settings file lists, each once and in its order, with any it does
 * not name at the end: on, but for the ones that wait to be chosen.
 */
export function agentsInOrder(stored: unknown): AgentSetting[] {
    const listed: AgentSetting[] = [];
    for (const a of Array.isArray(stored) ? stored : []) {
        if (AGENT_IDS.includes(a?.id) && !listed.some((l) => l.id === a.id)) {
            listed.push({id: a.id, enabled: a.enabled !== false});
        }
    }
    const missing = AGENT_IDS.filter((id) => !listed.some((a) => a.id === id));
    return [...listed, ...missing.map((id) => ({id, enabled: !OFF_UNTIL_CHOSEN.includes(id)}))];
}

/** Bounds for the concurrency cap. Past a handful, runs just queue at Outlook, which takes one caller at a time. */
export const CONCURRENT_RUNS_RANGE = {min: 1, max: 8} as const;

/** How far a run may go in a folder: read what is there, or also write and edit files in it. */
export type FolderAccess = 'read' | 'write';

export const FOLDER_ACCESS: FolderAccess[] = ['read', 'write'];

/**
 * A folder on this computer that a run may be handed, kept in Settings → Folders.
 * A node ticks it by `name`, so a flow names no path: a flow copied to another
 * computer finds its folder there under the same name.
 */
export interface FolderSetting {
    /** What a node ticks it by. Each once, whatever the letter case. */
    name: string;
    /** Absolute, as this computer spells it. */
    path: string;
    /** The most any node may do in it. */
    access: FolderAccess;
}

/** The folder named `name`, matched as Settings keeps names unique: whatever the letter case. */
export const findFolder = (folders: FolderSetting[], name: string): FolderSetting | undefined =>
    folders.find((f) => f.name.toLowerCase() === name.trim().toLowerCase());

/**
 * The folders a settings file lists, each with a name, an absolute path and a
 * known access, and each name once: a later one of the same name is dropped.
 */
export function foldersOf(stored: unknown): FolderSetting[] {
    const out: FolderSetting[] = [];
    for (const f of Array.isArray(stored) ? stored : []) {
        const name = typeof f?.name === 'string' ? f.name.trim() : '';
        const path = typeof f?.path === 'string' ? f.path.trim() : '';
        if (!name || !isAbsolutePath(path) || findFolder(out, name)) continue;
        out.push({name, path, access: f.access === 'write' ? 'write' : 'read'});
    }
    return out;
}

/** Absolute on Windows or a Mac, judged without node's path, which the renderer does not have. */
const isAbsolutePath = (path: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path);

/** The kinds of window, each opened at the size Settings → Appearance gives it. */
export type WindowKind = 'canvas' | 'welcome' | 'settings';

export const WINDOW_KINDS: WindowKind[] = ['canvas', 'welcome', 'settings'];

/** A window's width and height, before display scaling: at 150%, 1000 is 1,500 pixels on the screen. */
export interface WindowSize {
    width: number;
    height: number;
}

/** Each kind's size out of the box, and the smallest it can be set to: any smaller and its layout no longer fits. */
export const WINDOW_SIZES: Record<WindowKind, { initial: WindowSize; min: WindowSize }> = {
    canvas: {initial: {width: 1560, height: 980}, min: {width: 1100, height: 700}},
    welcome: {initial: {width: 1120, height: 800}, min: {width: 860, height: 520}},
    settings: {initial: {width: 920, height: 800}, min: {width: 740, height: 480}},
};

/** The largest a width or height can be set to. A screen smaller than a window shrinks it to fit in any case. */
export const WINDOW_SIZE_MAX = 10000;

/** Whether a window of this kind can open at `size`: whole numbers, no smaller than its layout needs. */
export function usableWindowSize(kind: WindowKind, size: WindowSize): boolean {
    const {min} = WINDOW_SIZES[kind];
    const fits = (n: number, least: number): boolean => Number.isInteger(n) && n >= least && n <= WINDOW_SIZE_MAX;
    return fits(size.width, min.width) && fits(size.height, min.height);
}

/** The screen a window is on, as much of it as windows may use: short of the taskbar, or the menu bar and Dock. */
export interface DisplayArea {
    width: number;
    height: number;
    /** What the system calls the screen, such as "Built-in Retina Display". Empty where it names none. */
    label: string;
}

/** A size worth offering a kind of window on a screen, and what to call it. */
export interface SuggestedSize {
    label: string;
    size: WindowSize;
}

/**
 * Sizes that suit a kind of window on `area`: all of it, most of it, about two
 * thirds of it, and half its width for working beside another app. Each but the
 * whole is rounded down to ten, and only those the window can open at are offered,
 * each size once.
 */
export function suggestedWindowSizes(kind: WindowKind, area: DisplayArea): SuggestedSize[] {
    const tens = (n: number): number => Math.floor(n / 10) * 10;
    const out: SuggestedSize[] = [];
    for (const suggestion of [
        {label: 'Whole screen', size: {width: area.width, height: area.height}},
        {label: 'Large', size: {width: tens(area.width * 0.85), height: tens(area.height * 0.85)}},
        {label: 'Medium', size: {width: tens(area.width * 0.7), height: tens(area.height * 0.7)}},
        {label: 'Half width', size: {width: Math.floor(area.width / 2), height: area.height}},
    ]) {
        const {width, height} = suggestion.size;
        if (!usableWindowSize(kind, suggestion.size)) continue;
        if (out.some(({size}) => size.width === width && size.height === height)) continue;
        out.push(suggestion);
    }
    return out;
}

/** The window sizes a settings file gives, each kind's own where its is missing or one it cannot open at. */
export function windowSizesOf(stored: unknown): Record<WindowKind, WindowSize> {
    const given = (stored ?? {}) as Partial<Record<WindowKind, Partial<WindowSize>>>;
    const out = {} as Record<WindowKind, WindowSize>;
    for (const kind of WINDOW_KINDS) {
        const size = {width: Number(given[kind]?.width), height: Number(given[kind]?.height)};
        out[kind] = usableWindowSize(kind, size) ? size : {...WINDOW_SIZES[kind].initial};
    }
    return out;
}

/** Which releases the app updates itself to: published ones, or a build of each day's changes. */
export type UpdateChannel = 'stable' | 'nightly';

export const UPDATE_CHANNELS: UpdateChannel[] = ['stable', 'nightly'];

export interface Settings {
    /** The `claude` executable. Empty finds the Claude Code installed on this computer. */
    claudeExecutablePath: string;
    /** The `agy` executable, for nodes on a model marked · agy. Empty looks where agy installs itself. */
    agyExecutablePath: string;
    /**
     * Every agent, in the order its models are listed: a new node starts on the
     * first one's. One switched off is passed over by every step.
     */
    agents: AgentSetting[];
    /** Master switch: when false the poller never starts, whatever a flow says. */
    pollingEnabled: boolean;
    /**
     * How many runs may be under way at once. Runs of different flows overlap;
     * one flow never runs twice at once, whatever this is set to.
     */
    maxConcurrentRuns: number;
    agentControl: AgentControlSettings;
    /** Unset in a settings file, a nightly build follows nightlies and any other build follows stable. */
    updateChannel: UpdateChannel;
    /**
     * Every folder a run's file tools may be handed, and none besides: a node
     * ticks from these. A shell, once a node lets its run have one, is not held to them.
     */
    folders: FolderSetting[];
    /**
     * The models every Categorizer, Extractor and Processor goes on to, in turn,
     * when its own are at their usage limit or out of reach, unless the node waits
     * for its own instead. Empty, a step waits for its own model's limit to lift.
     */
    fallbacks: ModelChoice[];
    /**
     * Lets F12 or Ctrl+Shift+I (Cmd+Option+I on a Mac) open Chromium's developer
     * tools on any window. Off, those keys do nothing and any tools open are closed.
     */
    devToolsEnabled: boolean;
    /**
     * The model the AI monitor reviews a run on, for every trigger that has it on.
     * At its usage limit or out of reach, the review goes on to the fallbacks above.
     */
    monitorModel: Pick<ModelChoice, 'model' | 'effort'>;
    /**
     * The size of each kind of window: one opened takes it, and those open take a
     * new one at once, unless maximised, full screen or minimised. A screen too
     * small for one shrinks it to fit.
     */
    windowSizes: Record<WindowKind, WindowSize>;
    /** Opens each new canvas maximised. Restored, it takes the canvas size above. */
    canvasMaximized: boolean;
}

export function defaultSettings(): Settings {
    return {
        claudeExecutablePath: '',
        agyExecutablePath: '',
        agents: agentsInOrder([]),
        pollingEnabled: true,
        maxConcurrentRuns: 3,
        agentControl: {enabled: false, port: DEFAULT_AGENT_CONTROL_PORT, token: ''},
        updateChannel: 'stable',
        folders: [],
        fallbacks: [],
        devToolsEnabled: false,
        monitorModel: {model: DEFAULT_MODEL, effort: ''},
        windowSizes: windowSizesOf({}),
        canvasMaximized: false,
    };
}

/** What Settings → Updates shows, live. */
export interface UpdateStatus {
    /** The version running now. */
    version: string;
    channel: UpdateChannel;
    /**
     * `unavailable` is a copy that cannot update itself: run from source, or not
     * unpacked from a release. `current` means the last check found nothing newer.
     */
    state: 'unavailable' | 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'failed';
    /** The version found, while it downloads and once it is ready to restart into. */
    available?: string;
    /** How much of it has come down, 0–100, while it downloads. */
    progress?: number;
    /** Why this copy cannot update, or what went wrong with the last check. */
    detail?: string;
    /** When a check last finished, whatever it found. */
    checkedAt?: string;
}

/** What the Settings panel shows about the agent-control server, live. */
export interface AgentControlStatus {
    enabled: boolean;
    /** Enabled and actually listening — a port already in use is neither. */
    running: boolean;
    /** The address to hand an MCP client. Empty while it is not listening. */
    url: string;
    token: string;
    lastError?: string;
    /** When an agent last called, so the panel can show a sign of life. */
    lastRequestAt?: string;
    /** Which agent made that call, such as "Claude Code" or "Antigravity". */
    lastRequestBy?: string;
}

/** Who made this and under what terms — shown in Settings → About. */
export interface AboutInfo {
    name: string;
    version: string;
    developer: string;
    license: string;
}

/** One skill in the open workspace's library, which every flow in it shares. */
export interface SkillSummary {
    name: string;
    description: string;
    /** Bytes of SKILL.md. */
    size: number;
    updatedAt: string;
    /**
     * The workspace's MCP server tools its frontmatter's `allowed-tools` names, as a
     * node ticks them: `mcp__<server>__<tool>`, or `mcp__<server>` for all of one's.
     * A node that ticks the skill is handed these.
     */
    tools: string[];
    /**
     * The rest of `allowed-tools`, as written: built-in tools such as Bash or Read,
     * and the email's own. A skill does not grant these; the node's own settings do.
     */
    ungranted: string[];
}

/**
 * The tools a node's ticked skills grant it, each with the skills that do. A
 * skill it does not tick grants nothing, though its run may still load it.
 */
export function skillGrants(skills: string[], library: SkillSummary[]): Map<string, string[]> {
    const grants = new Map<string, string[]>();
    for (const name of skills) {
        for (const tool of library.find((skill) => skill.name === name)?.tools ?? []) {
            grants.set(tool, [...(grants.get(tool) ?? []), name]);
        }
    }
    return grants;
}

/** Every MCP server tool a node's run is handed: those it ticks, and those its ticked skills grant, each once. */
export function nodeTools(node: { skills: string[]; mcpTools: string[] }, library: SkillSummary[]): string[] {
    return [...new Set([...node.mcpTools, ...skillGrants(node.skills, library).keys()])];
}

export interface SkillDetail extends SkillSummary {
    /** The whole SKILL.md, frontmatter included, as an agent reads and writes it. */
    content: string;
}

export interface EngineStatus {
    /** Whether any flow is switched on. */
    running: boolean;
    /** Flows switched on, whether or not a trigger of theirs names a mailbox yet. */
    flowIds: string[];
    /** One entry per trigger being polled — a flow may contribute several. */
    watching: {
        flowId: string;
        flowName: string;
        nodeId: string;
        nodeName: string;
        account: string;
        /** The folders it reads, in a few words, as the canvas shows them. */
        folders: string;
    }[];
    lastPollAt?: string;
    lastError?: string;
    activeRunIds: string[];
    /** Handed out and waiting: for a slot, or for an earlier run of the same flow. */
    queuedRunIds: string[];
    /** Ended, and being reviewed by the AI monitor. */
    reviewingRunIds: string[];
}
