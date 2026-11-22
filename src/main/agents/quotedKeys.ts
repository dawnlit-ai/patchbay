/** A key written with quotes kept inside it, double as `"B/L NO."` or single as `'B/L NO.'`. */
const QUOTED_KEY = /^(["'])(.+)\1$/s;

/**
 * The value with each key the model wrapped in a pair of quotes out of them, and
 * the keys it did that to. Gemini 4 through agy does it to keys with a space or a
 * stop in them, mostly in double quotes and now and then in single, where a schema
 * leaves an object's keys open — a Shipment's
 * `hbl_data` in its own result, or the `hbl_data` it hands an MCP tool — and what
 * reads the object looks each field up by its name. A key already there without
 * quotes keeps its place, and the quoted one stays beside it.
 */
export function unquoteKeys(input: unknown): { value: unknown; unquoted: string[] } {
    const unquoted: string[] = [];
    const walk = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(walk);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(
            Object.entries(value).map(([key, inner]) => {
                const bare = QUOTED_KEY.exec(key)?.[2];
                if (bare === undefined || Object.hasOwn(value, bare)) return [key, walk(inner)];
                unquoted.push(bare);
                return [bare, walk(inner)];
            }),
        );
    };
    return {value: walk(input), unquoted};
}
