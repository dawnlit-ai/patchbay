import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentStatus, ModelOption } from '@shared/ipc';
import type { TraceEvent } from '@shared/trace';

/** An MCP server a run is handed: a command to start, or one this process serves itself. */
export type AgentMcpServer =
    | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    | { type: 'sdk'; name: string; instance: McpServer };

/**
 * One step for an agent to take. It is worded as Claude Code words it — its tool
 * names, `mcp__<server>__<tool>` for an MCP tool, `<plugin>:<skill>` for a plugin's
 * skill — and a backend for another agent translates.
 */
export interface AgentRunRequest {
    prompt: string;
    model: string;
    /** One of the levels the backend lists for the model. Empty or absent leaves it to the model's default. */
    effort?: string;
    /** The run's working directory. Must be the flow's directory, so its `.claude/skills` is discoverable. */
    cwd: string;
    /** Absolute paths the run may touch beyond `cwd` — the run's scratch folder. */
    additionalDirectories?: string[];
    /**
     * Plugin folders outside `cwd` whose `skills` folder holds skills the run may
     * use, each named `<plugin>:<skill>` — the only way Claude Code loads skills a
     * run's own working directory does not hold.
     */
    skillPlugins?: string[];
    skills?: string[];
    allowedTools: string[];
    /** `[]` disables every built-in tool — right for a pure classification call. */
    tools?: string[];
    /**
     * Built-in tools taken out of the run altogether. Stronger than leaving them
     * out of `allowedTools`: `dontAsk` still lets read-only shell commands through.
     */
    disallowedTools?: string[];
    mcpServers?: Record<string, AgentMcpServer>;
    /**
     * MCP tools among `mcpServers`' that read, or write only into the run's own
     * folder. A step cut short after calling none but these may be asked again.
     */
    repeatableTools?: string[];
    /** When set, the run is constrained to this shape and `structured` is filled. */
    jsonSchema?: Record<string, unknown>;
    /** Claude Code's setting sources: `project` is what makes `cwd`'s `.claude/skills` discoverable. */
    settingSources?: ('user' | 'project' | 'local')[];
    signal?: AbortSignal;

    onEvent(event: TraceEvent): void;
}

export interface AgentRunResult {
    ok: boolean;
    structured?: unknown;
    error?: string;
}

/** One agent a step can run on. */
export interface AgentBackend {
    /** Whether a node's stored model runs on this agent. */
    owns(model: string): boolean;
    /** The models it offers now. */
    listModels(): Promise<ModelOption[]>;
    /** Its version and whether it is signed in, asked of it now. Never a failure: what went wrong is the detail. */
    status(): Promise<AgentStatus>;
    run(request: AgentRunRequest): Promise<AgentRunResult>;
}

/** What the agents take from the app around them. */
export interface AgentHost {
    /** The `claude` binary the app names, if it names one. Otherwise an installed one is looked for. */
    claudeExecutable(): string | undefined;
    /** The `agy` binary the app names, if it names one. Otherwise it is looked for where agy installs itself. */
    agyExecutable(): string | undefined;
    /** Something the app's own log should hear, beyond the run's trace. */
    warn(message: string, detail?: string): void;
}
