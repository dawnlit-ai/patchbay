/** How long a model list is reused: an agent can update itself, or its account change, while the app runs. */
const TTL_MS = 10 * 60_000;

/**
 * The last list asked of an agent, reused while it is fresh and asked for under
 * the same key — its binary, or its API key. A failure is not kept: once the
 * agent is installed, signed in or reachable, the next ask should find out.
 */
export function listCache<T>(): {
    get(key: string, ask: () => Promise<T>): Promise<T>;
    /** A list just had another way, kept as if asked. */
    set(key: string, list: T): void;
} {
    let held: { key: string; at: number; list: Promise<T> } | null = null;
    return {
        get(key, ask) {
            if (held && held.key === key && Date.now() - held.at < TTL_MS) return held.list;
            const asked = {key, at: Date.now(), list: ask()};
            held = asked;
            asked.list.catch(() => {
                if (held === asked) held = null;
            });
            return asked.list;
        },
        set(key, list) {
            held = {key, at: Date.now(), list: Promise.resolve(list)};
        },
    };
}
