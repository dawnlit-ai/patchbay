/** App-level settings, stored once per install rather than per flow. */

export interface McpServerSetting {
    /** Name Claude sees the tools under: they arrive as `mcp__<name>__*`. */
    name: string;
    command: string;
    args: string[];
    enabled: boolean;
}

/** One tool a server in Settings offers, as the server describes it. */
export interface McpServerTool {
    name: string;
    description: string;
}

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

/**
 * The agents a settings file lists, each once and in its order, with any it does
 * not name — as a file from before they could be ordered names none — on at the end.
 */
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
    /** Extra MCP servers, whose tools a Processor or Extractor is handed as its `mcpTools` names them. */
    mcpServers: McpServerSetting[];
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
        mcpServers: [],
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
