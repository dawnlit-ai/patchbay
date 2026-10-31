import type { AgentStatus, ModelOption } from '@shared/ipc';
import { AGENT_NAMES } from '@shared/settings';
import { now } from '@shared/trace';
import { agyBackend } from './agy';
import { claudeBackend } from './claude';
import { choicePrompt, choiceSchema, readChoice } from './decision';
import { jevBackend } from './jev';
import type { AgentBackend, AgentHost, AgentRunRequest, AgentRunResult, ChoiceRequest, ChoiceResult } from './types';
import { clock } from './usageGate';

/**
 * The agents a step can run on, behind one call. Nothing in this folder reaches
 * into the app: what it needs from it comes in as the host.
 */

export type { AgentHost, AgentMcpServer, AgentRunRequest, AgentRunResult, ChoiceRequest, ChoiceResult } from './types';

export interface Agents {
    /** Runs the step on the agent its model belongs to, or on each fallback in turn while the one before cannot take it. */
    run(request: AgentRunRequest): Promise<AgentRunResult>;

    /**
     * Asks the question of the agent its model belongs to, or of each fallback in
     * turn, as `run` does: Jev answers it as it is, any other agent in a prompt.
     * Every answer comes back in Jev's shape.
     */
    decide(request: ChoiceRequest): Promise<ChoiceResult>;

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
    const others: AgentBackend[] = [agyBackend(host), jevBackend(host)];
    const backendFor = (model: string): AgentBackend => others.find((b) => b.owns(model)) ?? claude;
    const backends = [claude, ...others];
    const switchedOn = (backend: AgentBackend): boolean =>
        host.agents().find((a) => a.id === backend.id)?.enabled !== false;

    type Choice = { model: string; effort?: string };

    /**
     * A model known to be at its limit is passed over without being asked. The
     * last one is always asked, and waits out a limit rather than handing it on.
     * One whose agent is switched off is never asked.
     */
    const inTurn = async <R extends { ok: boolean; unavailable?: string }>(
        step: Pick<AgentRunRequest, 'model' | 'effort' | 'fallbacks' | 'signal' | 'onEvent'>,
        ask: (backend: AgentBackend, choice: Choice, waitOutLimit: boolean) => Promise<R>,
    ): Promise<R | { ok: false; unavailable: string }> => {
        const later = [...(step.fallbacks ?? [])];
        let choice: Choice = {model: step.model, effort: step.effort};
        for (; ;) {
            const next = later.shift();
            const backend = backendFor(choice.model);
            const held = next ? backend.heldUntil(choice.model) : 0;
            const result = !switchedOn(backend)
                ? {ok: false as const, unavailable: `${AGENT_NAMES[backend.id]} is switched off in Settings → Agents`}
                : held
                    ? {ok: false as const, unavailable: `${choice.model} is at its usage limit until ${clock(held)}`}
                    : await ask(backend, choice, !next);
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

    const run = ({fallbacks, ...step}: AgentRunRequest): Promise<AgentRunResult> =>
        inTurn({...step, fallbacks}, (backend, choice, waitOutLimit) => backend.run({...step, ...choice, waitOutLimit}));

    const decide = ({fallbacks, question, state, about, prefer, ...step}: ChoiceRequest): Promise<ChoiceResult> =>
        inTurn({...step, fallbacks}, async (backend, choice, waitOutLimit): Promise<ChoiceResult> => {
            if (backend.decide) return backend.decide({...step, ...choice, waitOutLimit, question, state, about, prefer});
            const result = await backend.run({
                ...step,
                ...choice,
                waitOutLimit,
                prompt: [...choicePrompt(question), '', `--- ${about} ---`, state].join('\n'),
                // One judgement on text already in the prompt: with the built-in tools
                // disabled it stays a single turn.
                tools: [],
                allowedTools: [],
                jsonSchema: choiceSchema(question),
            });
            if (!result.ok) return {ok: false, error: result.error, unavailable: result.unavailable};
            const answer = readChoice(question, result.structured, prefer);
            return answer ? {ok: true, answer} : {ok: false, error: `${choice.model} gave no answer any probability.`};
        });

    const checking = new Map<string, Promise<AgentStatus>>();
    const found = new Map<string, AgentStatus>();
    return {
        run,
        decide,
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
