import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Read-or-default and write-atomically, and the same for files of one JSON
 * record per line. Every store goes through these, so a crash mid-write cannot
 * leave a truncated file behind.
 */

export function readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
        return fallback;
    }
}

export function writeJson(path: string, value: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, path);
}

/** One line of a JSONL file. A torn final line (power loss mid-append) costs that record, not the file. */
export function parseJsonLine<T>(line: string): T | null {
    try {
        return JSON.parse(line) as T;
    } catch {
        return null;
    }
}

/** The lines of a JSONL file that are whole, oldest first; none when there is no file. */
export function readJsonLines<T>(path: string): T[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => parseJsonLine<T>(line))
        .filter((record) => record !== null);
}

export function appendJsonLine(path: string, value: unknown): void {
    appendFileSync(path, JSON.stringify(value) + '\n', 'utf8');
}
