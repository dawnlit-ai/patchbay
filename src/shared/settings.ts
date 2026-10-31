/** App-level settings, stored once per install rather than per flow. */

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

/** The agents a step can run on: `claude` takes every model no other agent claims, `agy` those stored as `agy:<id>`. */
export type AgentId = 'claude' | 'agy';

export const AGENT_IDS: AgentId[] = ['claude', 'agy'];

/** What Settings and a run's trace call each agent. */
export const AGENT_NAMES: Record<AgentId, string> = {
    claude: 'Claude by Anthropic',
    agy: 'Antigravity by Google',
};

/** One agent as Settings → Agents lists it. */
export interface AgentSetting {
    id: AgentId;
    /** Off, its models leave the model lists and a step on one goes straight to its next model. */
    enabled: boolean;
}

/** The agents a settings file lists, each once and in its order, with any it does not name on at the end. */
export function agentsInOrder(stored: unknown): AgentSetting[] {
    const listed: AgentSetting[] = [];
    for (const a of Array.isArray(stored) ? stored : []) {
        if (AGENT_IDS.includes(a?.id) && !listed.some((l) => l.id === a.id)) {
            listed.push({id: a.id, enabled: a.enabled !== false});
        }
    }
    const missing = AGENT_IDS.filter((id) => !listed.some((a) => a.id === id));
    return [...listed, ...missing.map((id) => ({id, enabled: true}))];
}

/** Bounds for the concurrency cap. Past a handful, runs just queue at Outlook, which takes one caller at a time. */
export const CONCURRENT_RUNS_RANGE = {min: 1, max: 8} as const;

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
}

/** Who made this and under what terms — shown in Settings → About. */
export interface AboutInfo {
    name: string;
    version: string;
    developer: string;
    license: string;
    /** The directory holding this install's settings, runs and logs. Workspaces live wherever they were made. */
    dataDir: string;
}

/** One skill in the open workspace's library, which every flow in it shares. */
export interface SkillSummary {
    name: string;
    description: string;
    /** Bytes of SKILL.md. */
    size: number;
    updatedAt: string;
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
}
