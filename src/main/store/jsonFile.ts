import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Read-or-default and write-atomically. Every store in the app goes through
 * these two, so a crash mid-write can never leave a half-written flow or a
 * truncated settings file behind.
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
