import type { AgentStatus, ModelOption } from '@shared/ipc';
import { AGENT_NAMES } from '@shared/settings';
import { now } from '@shared/trace';
import { agyBackend } from './agy';
import { claudeBackend } from './claude';
import type { AgentBackend, AgentHost, AgentRunRequest, AgentRunResult } from './types';
import { clock } from './usageGate';

/**
 * The agents a step can run on, behind one call. Nothing in this folder reaches
 * into the app: what it needs from it comes in as the host.
 */

export type { AgentHost, AgentMcpServer, AgentRunRequest, AgentRunResult } from './types';

export interface Agents {
    /** Runs the step on the agent its model belongs to, or on each fallback in turn while the one before cannot take it. */
    run(request: AgentRunRequest): Promise<AgentRunResult>;

    /** Each switched-on agent's models, in the order Settings lists them, none from one whose CLI is not installed. */
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
    const backends = [claude, ...others];
    // One Settings does not list is on, as a settings file from before an agent existed lists none of its.
    const switchedOn = (backend: AgentBackend): boolean =>
        host.agents().find((a) => a.id === backend.id)?.enabled !== false;

    /**
     * A model known to be at its limit is passed over without being asked. The
     * last one is always asked, and waits out a limit rather than handing it on.
     * One whose agent is switched off is never asked.
     */
    const run = async ({fallbacks = [], ...step}: AgentRunRequest): Promise<AgentRunResult> => {
        const later = [...fallbacks];
        let choice: { model: string; effort?: string } = {model: step.model, effort: step.effort};
        for (; ;) {
            const next = later.shift();
            const backend = backendFor(choice.model);
            const held = next ? backend.heldUntil(choice.model) : 0;
            const result: AgentRunResult = !switchedOn(backend)
                ? {ok: false, unavailable: `${AGENT_NAMES[backend.id]} is switched off in Settings → Agents`}
                : held
                    ? {ok: false, unavailable: `${choice.model} is at its usage limit until ${clock(held)}`}
                    : await backend.run({...step, ...choice, waitOutLimit: !next});
            // A cancelled run goes no further.
            if (result.ok || !next || !result.unavailable || step.signal?.aborted) return result;
            step.onEvent({
                at: now(),
                type: 'note',
                label: `${result.unavailable}, so the step goes to ${next.model}`
            });
            choice = next;
        }
    };

    const checking = new Map<string, Promise<AgentStatus>>();
    const found = new Map<string, AgentStatus>();
    return {
        run,
        listModels: async () => {
            const order = host.agents().map((a) => a.id);
            const listing = backends
                .filter(switchedOn)
                .toSorted((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
            return (await Promise.all(listing.map((b) => b.listModels()))).flat();
        },
        status: (id) => {
            const under = checking.get(id);
            if (under) return under;
            const backend = backends.find((b) => b.id === id);
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
