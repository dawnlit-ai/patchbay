import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentStatus, ModelOption } from '@shared/ipc';
import type { AgentId, AgentSetting } from '@shared/settings';
import type { LiveText, TraceEvent } from '@shared/trace';
import type { ChoiceAnswer, ChoiceQuestion } from './decision';

/**
 * An MCP server a run is handed: a command to start, an address to connect to,
 * or one this process serves itself. A command's `cwd` is the folder it is
 * started in; absent, the agent's own.
 */
export type AgentMcpServer =
    | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { type: 'http'; url: string; headers?: Record<string, string> }
    | { type: 'sse'; url: string; headers?: Record<string, string> }
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
    /**
     * Models the step goes to in turn when the one before is `unavailable`. Only
     * the last waits out a usage limit; the others hand it on at once.
     */
    fallbacks?: { model: string; effort?: string }[];
    /**
     * Whether a usage limit is waited out, as by default, rather than handed back
     * at once as `unavailable` for the next model to take.
     */
    waitOutLimit?: boolean;
    /** The run's working directory: the open workspace's folder. */
    cwd: string;
    /** Absolute paths the run may touch beyond `cwd` — the run's scratch folder. */
    additionalDirectories?: string[];
    /**
     * Plugin folders outside `cwd` whose `skills` folder holds skills the run may
     * use, each named `<plugin>:<skill>` — the only way Claude Code loads skills a
     * run's own working directory does not hold.
     */
    skillPlugins?: string[];
    /** The skills the run may use, as `<plugin>:<skill>`: every one in the workspace, and no other. */
    skills?: string[];
    /** Those of `skills` the step's prompt says to load before anything else: the node's ticks. */
    followSkills?: string[];
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
    signal?: AbortSignal;

    onEvent(event: TraceEvent): void;

    /** The block being written, each time it grows, and null once it is whole and on its way to `onEvent`. */
    onLive?(text: LiveText | null): void;
}

export interface AgentRunResult {
    ok: boolean;
    structured?: unknown;
    error?: string;
    /**
     * Why the agent could not take the step at all — at its usage limit, not
     * installed, or out of reach — when nothing that changes things ran. Another
     * model may take the step as it stands.
     */
    unavailable?: string;
}

/**
 * A step that only picks one of several named answers, asked as Jev asks it. An
 * agent that answers such a question itself takes it as it is; any other is asked
 * it in a prompt, held to a schema, and its answer read back in Jev's shape.
 */
export interface ChoiceRequest
    extends Pick<AgentRunRequest, 'model' | 'effort' | 'fallbacks' | 'waitOutLimit' | 'cwd' | 'signal' | 'onEvent' | 'onLive'> {
    question: ChoiceQuestion;
    /** What the question is about: Jev's `state`. */
    state: string;
    /** What the state is, to head it with in a prompt: "Email". */
    about: string;
    /** The answer a tie goes to, when it is one of those tied. */
    prefer?: string;
}

export interface ChoiceResult extends Omit<AgentRunResult, 'structured'> {
    /** Set when `ok`. */
    answer?: ChoiceAnswer;
}

/** One agent a step can run on. */
export interface AgentBackend {
    /** What Settings and its status call it: `claude`, `agy` or `jev`. */
    id: AgentId;

    /** Whether a node's stored model runs on this agent. */
    owns(model: string): boolean;

    /** The models it offers now. */
    listModels(): Promise<ModelOption[]>;

    /** When the model's usage limit is known to lift, or 0 when it is free to go. */
    heldUntil(model: string): number;

    /** Its version and whether it is signed in, asked of it now. Never a failure: what went wrong is the detail. */
    status(): Promise<AgentStatus>;

    run(request: AgentRunRequest): Promise<AgentRunResult>;

    /** Answers a choice itself, rather than being asked it in a prompt through `run`. */
    decide?(request: ChoiceRequest): Promise<ChoiceResult>;
}

/** What the agents take from the app around them. */
export interface AgentHost {
    /** The `claude` binary the app names, if it names one. Otherwise an installed one is looked for. */
    claudeExecutable(): string | undefined;

    /** The `agy` binary the app names, if it names one. Otherwise it is looked for where agy installs itself. */
    agyExecutable(): string | undefined;

    /**
     * Jev's API key, opened, and where it came from ("set in Patchbay"). Null when
     * there is none. Throws, saying why, when one is set but cannot be opened.
     */
    jevKey(): Promise<{ value: string; from: string } | null>;

    /** Every agent in the order Settings lists it, each switched on or off. */
    agents(): AgentSetting[];

    /** Something the app's own log should hear, beyond the run's trace. */
    warn(message: string, detail?: string): void;
}
