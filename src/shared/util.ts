/** Small helpers both processes use. */

export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a thrown value says, as a line a person can read. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Phrases as a sentence joins them: A, A and B, A, B and C. */
export const together = (phrases: string[]): string =>
    phrases.length < 2 ? (phrases[0] ?? '') : `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;
