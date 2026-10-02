import type { ModelOption } from '@shared/ipc';
import { agyBackend } from './agy';
import { claudeBackend } from './claude';
import type { AgentBackend, AgentHost, AgentRunRequest, AgentRunResult } from './types';

/**
 * The agents a step can run on, behind one call. Nothing in this folder reaches
 * into the app: what it needs from it comes in as the host.
 */

export type { AgentHost, AgentMcpServer, AgentRunRequest, AgentRunResult } from './types';

export interface Agents {
    /** Runs the step on the agent its model belongs to. */
    run(request: AgentRunRequest): Promise<AgentRunResult>;
    /** Claude's models first, then the others', each empty when its CLI is not installed. */
    listModels(): Promise<ModelOption[]>;
}

export function createAgents(host: AgentHost): Agents {
    const claude = claudeBackend(host);
    // Claude's models carry no prefix, so it takes whatever the others do not claim.
    const others: AgentBackend[] = [agyBackend];
    const backendFor = (model: string): AgentBackend => others.find((b) => b.owns(model)) ?? claude;
    return {
        run: (request) => backendFor(request.model).run(request),
        listModels: async () => (await Promise.all([claude, ...others].map((b) => b.listModels()))).flat(),
    };
}
