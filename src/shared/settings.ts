/** App-level settings, stored once per install rather than per flow. */

export interface McpServerSetting {
    /** Name Claude sees the tools under: they arrive as `mcp__<name>__*`. */
    name: string;
    command: string;
    args: string[];
    enabled: boolean;
}

export interface Settings {
    /**
     * The `claude` executable the Agent SDK drives. Empty resolves the SDK's own
     * bundled binary; pointing at an existing Claude Code install avoids a second
     * ~200MB download.
     */
    claudeExecutablePath: string;
    /** Extra MCP servers handed to every Processor node. */
    mcpServers: McpServerSetting[];
    /**
     * Folder of `<name>/SKILL.md` directories to seed the library from, read only
     * while the library is empty so edits here never fight an upstream copy.
     */
    skillSeedPath: string;
    /** Default model for new nodes. */
    defaultModel: string;
    /** Master switch: when false the poller never starts, whatever a flow says. */
    pollingEnabled: boolean;
    /**
     * Write canvas edits back as they happen. Off means the flow on screen is a
     * draft until Save, and the engine keeps running the last saved version.
     */
    autoSaveFlows: boolean;
}

export function defaultSettings(): Settings {
    return {
        claudeExecutablePath: '',
        skillSeedPath: '',
        mcpServers: [],
        defaultModel: 'claude-opus-5',
        pollingEnabled: true,
        autoSaveFlows: true,
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
}
