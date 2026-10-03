import type { AgentStatus, ModelOption } from '@shared/ipc';
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

    /**
     * One agent's version, sign-in and usage, asked of it now. A check of it
     * already under way is joined rather than started again.
     */
    status(id: string): Promise<AgentStatus>;

    /** What the last check of that agent found, to show while the next one runs. Null before the first. */
    lastStatus(id: string): AgentStatus | null;
}

export function createAgents(host: AgentHost): Agents {
    const claude = claudeBackend(host);
    // Claude's models carry no prefix, so it takes whatever the others do not claim.
    const others: AgentBackend[] = [agyBackend(host)];
    const backendFor = (model: string): AgentBackend => others.find((b) => b.owns(model)) ?? claude;
    const checking = new Map<string, Promise<AgentStatus>>();
    const found = new Map<string, AgentStatus>();
    return {
        run: (request) => backendFor(request.model).run(request),
        listModels: async () => (await Promise.all([claude, ...others].map((b) => b.listModels()))).flat(),
        status: (id) => {
            const under = checking.get(id);
            if (under) return under;
            const backend = [claude, ...others].find((b) => b.id === id);
            if (!backend) return Promise.reject(new Error(`There is no agent "${id}".`));
            const check = backend
                .status()
                .then((status) => {
                    found.set(id, status);
                    return status;
                })
                .finally(() => checking.delete(id));
            checking.set(id, check);
            return check;
        },
        lastStatus: (id) => found.get(id) ?? null,
    };
}
