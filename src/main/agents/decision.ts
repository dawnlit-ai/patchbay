/**
 * Decisions in the shape Jev words them — the model behind TypeSafe AI's System
 * One API, which answers a typed question with a probability for each answer
 * instead of text. A step that only has to pick one of a few named answers asks
 * its question as Jev takes one and reads the answer as Jev gives one, so a model
 * that answers in this shape itself can take the step without the step changing.
 *
 * Jev itself is sent the question as it stands, and its answer checked by
 * `jevChoice`. An LLM agent is asked it in its prompt (`choicePrompt`), held to
 * `choiceSchema`, and what it writes is turned into Jev's answer by `readChoice`.
 */

/** A question with one of several named answers: Jev's `choice`. */
export interface ChoiceQuestion {
    type: 'choice';
    /** The question itself. */
    instructions: string;
    /** Each answer's name, and what counts as it. Jev takes 1 to 255. */
    criteria: Record<string, string>;
}

/** Jev's answer to a `choice`, as its API sends it back. */
export interface ChoiceAnswer {
    type: 'choice';
    /** The name with the highest probability. */
    choice: string;
    /**
     * How sure the model is, from 0 to 1. An LLM is not asked for it apart from
     * the probabilities, so for one it is the chosen name's.
     */
    confidence: number;
    /** Each name's probability of being the answer, together about 1. */
    probabilities: Record<string, number>;
    /** Why, in a sentence. Jev gives none; an LLM is asked for one. */
    reason?: string;
}

/** The question as an LLM's prompt puts it, ahead of whatever it is about. */
export function choicePrompt(question: ChoiceQuestion): string[] {
    return [
        question.instructions,
        '',
        'Answers:',
        ...Object.entries(question.criteria).map(([name, criterion]) => `- "${name}": ${criterion}`),
        '',
        'Say in one sentence why, then give every answer the probability, from 0 to 1, that it is the right',
        'one. The probabilities add up to 1, and the answer given the most is the one taken.',
    ];
}

/** What an LLM is held to when asked the question: a reason, then one probability per answer. */
export function choiceSchema(question: ChoiceQuestion): Record<string, unknown> {
    const names = Object.keys(question.criteria);
    return {
        type: 'object',
        properties: {
            reason: {type: 'string'},
            probabilities: {
                type: 'object',
                properties: Object.fromEntries(names.map((name) => [name, {type: 'number', minimum: 0, maximum: 1}])),
                required: names,
                additionalProperties: false,
            },
        },
        required: ['reason', 'probabilities'],
        additionalProperties: false,
    };
}

const twoPlaces = (n: number): number => Math.round(n * 100) / 100;

const isShare = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * Jev's own answer to the question, checked against what was asked: its choice
 * one of the names, and a probability for each. Null when it is not such an
 * answer, rather than a branch taken on a shape this was not written for.
 */
export function jevChoice(question: ChoiceQuestion, sent: unknown): ChoiceAnswer | null {
    if (typeof sent !== 'object' || sent === null) return null;
    const {type, choice, confidence, probabilities} = sent as Record<string, unknown>;
    const names = Object.keys(question.criteria);
    if (type !== 'choice' || typeof choice !== 'string' || !names.includes(choice) || !isShare(confidence)) return null;
    if (typeof probabilities !== 'object' || probabilities === null) return null;
    const given = probabilities as Record<string, unknown>;
    if (!names.every((name) => isShare(given[name]))) return null;
    return {
        type: 'choice',
        choice,
        confidence,
        probabilities: Object.fromEntries(names.map((name) => [name, given[name] as number])),
    };
}

/**
 * What an LLM wrote against `choiceSchema`, as Jev's answer: the probabilities
 * scaled to add up to 1, since a model's own seldom do, and rounded to two places
 * as Jev's are. A tie goes to `prefer` when it is one of the names tied, and
 * otherwise to the first listed. Null when no answer was given any probability.
 */
export function readChoice(question: ChoiceQuestion, written: unknown, prefer?: string): ChoiceAnswer | null {
    if (typeof written !== 'object' || written === null) return null;
    const {reason, probabilities} = written as { reason?: unknown; probabilities?: unknown };
    if (typeof probabilities !== 'object' || probabilities === null) return null;

    const names = Object.keys(question.criteria);
    const given = names.map((name) => {
        const p = (probabilities as Record<string, unknown>)[name];
        return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : 0;
    });
    const total = given.reduce((sum, p) => sum + p, 0);
    if (total === 0) return null;
    const shares = given.map((p) => p / total);

    const top = Math.max(...shares);
    const choice = prefer !== undefined && shares[names.indexOf(prefer)] === top
        ? prefer
        : names[shares.indexOf(top)]!;
    const why = typeof reason === 'string' ? reason.trim() : '';
    return {
        type: 'choice',
        choice,
        confidence: twoPlaces(top),
        probabilities: Object.fromEntries(names.map((name, i) => [name, twoPlaces(shares[i]!)])),
        ...(why ? {reason: why} : {}),
    };
}
