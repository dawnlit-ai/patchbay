import { setTimeout as sleep } from 'node:timers/promises';
import { isJevModel } from '@shared/flow';
import type { AgentStatus, ModelOption } from '@shared/ipc';
import { now, truncate } from '@shared/trace';
import { jevChoice } from './decision';
import type { AgentBackend, AgentHost, ChoiceRequest, ChoiceResult } from './types';
import { clock } from './usageGate';

/**
 * Jev, TypeSafe AI's model, through its System One API: it answers a typed
 * question with a probability for each answer and writes no text, so it takes a
 * Categorizer's question — sent as it stands, the email as its state — and no
 * other step. It is reached with an API key, not a CLI signed in on this computer,
 * and each email it is asked about is sent to TypeSafe AI.
 */

const API = 'https://api.typesafe.ai';

/** What the one question of a Categorizer's request is called; the answer comes back under it. */
const QUESTION = 'category';

const NO_KEY = 'No TypeSafe API key — set one in Settings → Agents';

/** As long as TypeSafe's own clients wait for an answer. */
const REQUEST_TIMEOUT_MS = 60_000;

/** How long to wait before asking again after an outage, once per entry. */
const RETRY_DELAYS_MS = [5_000, 30_000];

/** How long a rate limit that names no time is waited out, and how many times. */
const RATE_LIMIT_MS = 30_000;
const RATE_LIMIT_WAITS = 10;

/** How long a model list is reused. */
const MODELS_TTL_MS = 10 * 60_000;

/** When the rate limit lifts. It belongs to the key, so it holds every Jev model alike. */
let heldUntil = 0;

/** The version each alias last answered as (`jev-latest` → `jev-1.14.0`), and each version seen answering. */
const answeredAs = new Map<string, string>();
const versionsSeen = new Set<string>();

let modelsAsked: { key: string; at: number; list: Promise<{ name: string; description: string }[]> } | null = null;

const reasonOf = (e: unknown): string => {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : null;
    return cause ?? (e instanceof Error ? e.message : String(e));
};

/** What an error response says, from the `detail` TypeSafe puts it in. */
function errorText(body: string): string {
    let detail: unknown;
    try {
        detail = (JSON.parse(body) as { detail?: unknown }).detail;
    } catch {
        return truncate(body.trim(), 500) || 'no detail';
    }
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
        return detail
            .map((d: { loc?: unknown[]; msg?: string }) => [d.loc?.join('.'), d.msg].filter(Boolean).join(': '))
            .join('; ');
    }
    const message = (detail as { message?: unknown } | undefined)?.message;
    return typeof message === 'string' ? message : truncate(body, 500);
}

/** When a 429 says to ask again: seconds, or a date. */
function retryAfter(response: Response): number | null {
    const header = response.headers.get('retry-after');
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(header);
    return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function send(key: string, path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return fetch(`${API}${path}`, {
        ...init,
        headers: {...init.headers, Authorization: `Bearer ${key}`},
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
}

/** The models the key may use, as TypeSafe lists them: its aliases. Throws, saying why, when it cannot list them. */
async function fetchModels(key: { value: string; from: string }): Promise<{ name: string; description: string }[]> {
    let response: Response;
    try {
        response = await send(key.value, '/v1/models', {});
    } catch (e) {
        throw new Error(`api.typesafe.ai could not be reached: ${reasonOf(e)}`);
    }
    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
        throw new Error(`TypeSafe refused the API key ${key.from} — set it again in Settings → Agents`);
    }
    if (!response.ok) throw new Error(`TypeSafe answered ${response.status}: ${errorText(body)}`);
    const models = (JSON.parse(body) as { models?: { name?: unknown; description?: unknown }[] }).models ?? [];
    // A model not named jev-… would be taken for Claude's, so it is left out.
    return models.flatMap((m) =>
        typeof m.name === 'string' && isJevModel(m.name)
            ? [{name: m.name, description: typeof m.description === 'string' ? m.description : ''}]
            : [],
    );
}

/** "Jev latest", "Jev 1.14.0". */
const shownAs = (name: string): string => `Jev ${name.slice('jev-'.length)} · jev`;

/**
 * The aliases TypeSafe lists, each with the version it last answered as, then
 * every version seen answering this session, for a node to be pinned to: the
 * listing names no versions, though the API answers to them.
 */
async function listJevModels(host: AgentHost): Promise<ModelOption[]> {
    const key = await host.jevKey().catch(() => null);
    if (!key) return [];
    if (!modelsAsked || modelsAsked.key !== key.value || Date.now() - modelsAsked.at >= MODELS_TTL_MS) {
        const asked = {key: key.value, at: Date.now(), list: fetchModels(key)};
        modelsAsked = asked;
        // A failure is not kept: the next ask, once the key or the network is back, should find out.
        asked.list.catch(() => {
            if (modelsAsked === asked) modelsAsked = null;
        });
    }
    const aliases = await modelsAsked.list.catch(() => []);
    const names = new Set(aliases.map((a) => a.name));
    return [
        ...aliases.map((a): ModelOption => ({
            value: a.name,
            resolvedModel: answeredAs.get(a.name),
            displayName: shownAs(a.name),
            description: a.description,
            effortLevels: [],
        })),
        ...[...versionsSeen].filter((v) => !names.has(v)).toSorted().map((v): ModelOption => ({
            value: v,
            displayName: shownAs(v),
            description: `Pinned: stays on ${v} when jev-latest moves on to a newer version.`,
            effortLevels: [],
        })),
    ];
}

/** Whether the key is there and TypeSafe takes it, asked now. Its version is the one jev-latest last answered as, once it has. */
async function jevStatus(host: AgentHost): Promise<AgentStatus> {
    const base = {id: 'jev', name: 'Jev', executable: API, usage: []};
    const version = answeredAs.get('jev-latest')?.slice('jev-'.length) ?? null;
    let key: Awaited<ReturnType<AgentHost['jevKey']>>;
    try {
        key = await host.jevKey();
    } catch (e) {
        return {...base, version, ready: false, detail: reasonOf(e)};
    }
    if (!key) return {...base, version, ready: false, detail: NO_KEY};
    try {
        const asked = {key: key.value, at: Date.now(), list: fetchModels(key)};
        const models = await asked.list;
        modelsAsked = asked;
        return {
            ...base,
            version,
            ready: true,
            detail: `API key ${key.from} · ${models.map((m) => m.name).join(', ') || 'no models listed'}`,
        };
    } catch (e) {
        return {...base, version, ready: false, detail: reasonOf(e)};
    }
}

async function decide(host: AgentHost, request: ChoiceRequest): Promise<ChoiceResult> {
    const fail = (error: string): ChoiceResult => {
        request.onEvent({at: now(), type: 'error', label: error});
        return {ok: false, error};
    };
    // Nothing was sent that changes anything, so the next model may take the step.
    const unavailable = (why: string): ChoiceResult => ({...fail(why), unavailable: why});
    const cancelled = (): ChoiceResult => fail('Cancelled.');

    let key: Awaited<ReturnType<AgentHost['jevKey']>>;
    try {
        key = await host.jevKey();
    } catch (e) {
        return unavailable(reasonOf(e));
    }
    if (!key) return unavailable(NO_KEY);

    const asked = {model: request.model, state: request.state, questions: {[QUESTION]: request.question}};
    request.onEvent({
        at: now(),
        type: 'prompt',
        label: `Question to ${request.model} (jev)`,
        detail: truncate(JSON.stringify(asked, null, 2), 20_000),
    });
    const body = JSON.stringify(asked);

    let outages = 0;
    let waits = 0;
    for (; ;) {
        const started = Date.now();
        let response: Response;
        let text: string;
        try {
            response = await send(key.value, '/v1/systemone', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body,
            }, request.signal);
            text = await response.text();
        } catch (e) {
            if (request.signal?.aborted) return cancelled();
            const why = `api.typesafe.ai could not be reached: ${reasonOf(e)}`;
            const delay = RETRY_DELAYS_MS[outages++];
            if (delay === undefined) return unavailable(why);
            request.onEvent({at: now(), type: 'note', label: `${why} — asking again in ${delay / 1000}s`});
            try {
                await sleep(delay, undefined, {signal: request.signal});
            } catch {
                return cancelled();
            }
            continue;
        }

        if (response.status === 429 || response.status >= 500) {
            const limited = response.status === 429;
            const wait = limited ? (retryAfter(response) ?? RATE_LIMIT_MS) : RETRY_DELAYS_MS[outages++];
            const why = limited
                ? `Jev is rate-limited: ${errorText(text)}`
                : `TypeSafe answered ${response.status}: ${errorText(text)}`;
            if (limited) heldUntil = Math.max(heldUntil, Date.now() + wait!);
            if (limited && request.waitOutLimit === false) {
                return unavailable(`Jev is rate-limited until ${clock(Date.now() + wait!)}`);
            }
            if (wait === undefined || (limited && ++waits > RATE_LIMIT_WAITS)) return unavailable(why);
            request.onEvent({at: now(), type: 'note', label: `${why} — asking again at ${clock(Date.now() + wait)}`});
            try {
                await sleep(wait, undefined, {signal: request.signal});
            } catch {
                return cancelled();
            }
            continue;
        }
        if (response.status === 401 || response.status === 403) {
            return unavailable(`TypeSafe refused the API key ${key.from} — set it again in Settings → Agents`);
        }
        if (response.status === 402) return unavailable(`TypeSafe would not take the question: ${errorText(text)}`);
        if (!response.ok) return fail(`Jev could not take the question (${response.status}): ${errorText(text)}`);

        let reply: { model?: unknown; answers?: Record<string, unknown>; usage?: Record<string, unknown> };
        try {
            reply = JSON.parse(text) as typeof reply;
        } catch {
            return fail(`Jev's answer is not JSON: ${truncate(text, 500)}`);
        }
        const answer = jevChoice(request.question, reply.answers?.[QUESTION]);
        if (!answer) return fail(`Jev answered in a shape Patchbay does not know: ${truncate(text, 2_000)}`);

        const by = typeof reply.model === 'string' ? reply.model : request.model;
        if (by !== request.model) answeredAs.set(request.model, by);
        versionsSeen.add(by);
        request.onEvent({
            at: now(),
            type: 'note',
            label: `${by} answered in ${Date.now() - started} ms`,
            detail: `input tokens: ${reply.usage?.input_tokens ?? '?'}, output: ${reply.usage?.output_tokens ?? '?'}`,
        });
        return {ok: true, answer};
    }
}

/** Jev's models, stored by their own names. It answers a choice and nothing else. */
export function jevBackend(host: AgentHost): AgentBackend {
    return {
        id: 'jev',
        owns: isJevModel,
        listModels: () => listJevModels(host),
        heldUntil: () => (heldUntil > Date.now() ? heldUntil : 0),
        status: () => jevStatus(host),
        run: async (request) => {
            const why = `${request.model} answers a Categorizer's question and nothing else, so it cannot take this step.`;
            request.onEvent({at: now(), type: 'error', label: why});
            return {ok: false, error: why, unavailable: why};
        },
        decide: (request) => decide(host, request),
    };
}
