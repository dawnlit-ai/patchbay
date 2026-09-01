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
     * Folder of `<name>/SKILL.md` directories to seed the global library from,
     * read only while that library is empty so edits here never fight an upstream
     * copy.
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

/**
 * Which library a skill lives in. `global` is shared by every flow in the
 * install; `flow` belongs to one flow and travels with it.
 */
export type SkillScope = 'global' | 'flow';

export const SKILL_SCOPES: SkillScope[] = ['global', 'flow'];

/** The plugin name the global library reaches Claude under. */
export const GLOBAL_SKILL_PLUGIN = 'global';

/**
 * How a ticked skill is written in a Processor's config, and handed to the Agent
 * SDK: a global skill is plugin-qualified, a flow's own is its bare name. The two
 * libraries may hold the same name without either shadowing the other.
 */
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
