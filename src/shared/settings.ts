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

export const DEFAULT_AGENT_CONTROL_PORT = 8787;

/** Bounds for the concurrency cap. Past a handful, runs just queue at Outlook, which takes one caller at a time. */
export const CONCURRENT_RUNS_RANGE = { min: 1, max: 8 } as const;

export interface Settings {
    /** The `claude` executable. Empty finds an installed Claude Code, else uses the SDK's own. */
    claudeExecutablePath: string;
    /** The `agy` executable, for nodes on Gemini. Empty looks where agy installs itself. */
    agyExecutablePath: string;
    /** Extra MCP servers, whose tools a Processor or Extractor is handed as its `mcpTools` names them. */
    mcpServers: McpServerSetting[];
    /** Folder of `<name>/SKILL.md` directories to seed the global library from, while it is empty. */
    skillSeedPath: string;
    /** Folders of `<name>/SKILL.md` directories linked into the global library, highest first. */
    globalSkillFolders: string[];
    /** Master switch: when false the poller never starts, whatever a flow says. */
    pollingEnabled: boolean;
    /**
     * How many runs may be under way at once. Runs of different flows overlap;
     * one flow never runs twice at once, whatever this is set to.
     */
    maxConcurrentRuns: number;
    agentControl: AgentControlSettings;
    /** Where New flow or Duplicate last made a flow's folder, offered again next time. Empty offers `Documents/Patchbay`. */
    flowLocation: string;
}

export function defaultSettings(): Settings {
    return {
        claudeExecutablePath: '',
        agyExecutablePath: '',
        skillSeedPath: '',
        globalSkillFolders: [],
        mcpServers: [],
        pollingEnabled: true,
        maxConcurrentRuns: 3,
        agentControl: { enabled: false, port: DEFAULT_AGENT_CONTROL_PORT, token: '' },
        flowLocation: '',
    };
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
    /** The directory holding every flow, skill, run and log this install owns. */
    workspace: string;
}

/**
 * Which library a skill lives in. `global` is shared by every flow in the
 * install; `flow` belongs to one flow and travels with it.
 */
export type SkillScope = 'global' | 'flow';

export const SKILL_SCOPES: SkillScope[] = ['global', 'flow'];

/** The plugin name the global library reaches Claude under. */
export const GLOBAL_SKILL_PLUGIN = 'global';

/** How a ticked skill is written: `global:<name>` for the global library, the bare name for the flow's own. */
export function skillRef(scope: SkillScope, name: string): string {
    return scope === 'global' ? `${GLOBAL_SKILL_PLUGIN}:${name}` : name;
}

export function isGlobalRef(ref: string): boolean {
    return ref.startsWith(`${GLOBAL_SKILL_PLUGIN}:`);
}

export interface SkillSummary {
    name: string;
    scope: SkillScope;
    description: string;
    /** Bytes of SKILL.md. */
    size: number;
    /** The folder it is kept in. For a global skill, which of the library's folders. */
    folder: string;
    updatedAt: string;
}

/** One of the folders the global library reads, as Settings shows it. */
export interface GlobalSkillFolder {
    path: string;
    /** The workspace's own folder, which is always read, last, and takes new skills. */
    workspace: boolean;
    /** Gone: renamed, or on a drive that is not plugged in. */
    missing: boolean;
    /** Everything in it, `shadowed` where a folder above holds the same name and wins. */
    skills: (SkillSummary & { shadowed: boolean })[];
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
        folder: string;
    }[];
    lastPollAt?: string;
    lastError?: string;
    activeRunIds: string[];
    /** Handed out and waiting: for a slot, or for an earlier run of the same flow. */
    queuedRunIds: string[];
}
