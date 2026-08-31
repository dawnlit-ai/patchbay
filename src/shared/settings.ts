/** App-level settings, stored once per install rather than per flow. */

export interface McpServerSetting {
    /** Name Claude sees the tools under, e.g. "smart-logistics". */
    name: string;
    command: string;
    args: string[];
    enabled: boolean;
}

export interface Settings {
    /**
     * Path to the `claude` executable the Agent SDK drives. Empty lets the SDK
     * resolve its own bundled platform binary; on a machine with Claude Code
     * already installed, pointing at that binary avoids a second ~200MB download.
     */
    claudeExecutablePath: string;
    /** Extra MCP servers handed to every Processor node. */
    mcpServers: McpServerSetting[];
    /**
     * Folder of `<name>/SKILL.md` directories the library is seeded from on first
     * run. Empty means "look in the usual places" (see seedSkillLibrary). Only ever
     * read when the library is empty, so editing skills here never fights an
     * upstream copy.
     */
    skillSeedPath: string;
    /** Default model for new nodes. */
    defaultModel: string;
    /** Master switch: when false the poller never starts, whatever a flow says. */
    pollingEnabled: boolean;
}

export function defaultSettings(): Settings {
    return {
        claudeExecutablePath: '',
        skillSeedPath: '',
        mcpServers: [],
        defaultModel: 'claude-opus-5',
        pollingEnabled: true,
    };
}

/** Who made this and under what terms — shown in Settings → About. */
export interface AboutInfo {
    name: string;
    version: string;
    developer: string;
    developerUrl: string;
    license: string;
}

export interface SkillSummary {
    name: string;
    description: string;
    /** Bytes of SKILL.md, so the library list can show something real. */
    size: number;
    updatedAt: string;
}

export interface SkillDetail extends SkillSummary {
    /** The whole SKILL.md, frontmatter included — the app edits it as one file. */
    content: string;
}

export interface EngineStatus {
    running: boolean;
    /** Per-flow poll state, keyed by flow id. */
    watching: { flowId: string; flowName: string; account: string; folder: string }[];
    lastPollAt?: string;
    lastError?: string;
    activeRunIds: string[];
}
