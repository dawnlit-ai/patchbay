import { appendFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry, LogLevel, LogSource } from '@shared/log';
import { logsDir } from './paths';

/**
 * The app's console. Every entry goes three places: a bounded buffer the window
 * reads when it opens, a push to any window already open, and one JSONL file per
 * day in the workspace — the file survives a restart, and it is the one to attach
 * to a bug report.
 */

/** A working day of polling, give or take, without holding every day of it. */
const BUFFER_LIMIT = 2_000;

/** Days of files kept. Older ones go on the first write after launch. */
const KEEP_DAYS = 14;

const buffer: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();
let seq = 0;
let pruned = false;

/** The local date, so a day's file holds the day the person at the window had. */
function dayStamp(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function prune(dir: string): void {
    const cutoff = dayStamp(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    for (const name of readdirSync(dir)) {
        const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
        if (day && day < cutoff) rmSync(join(dir, name), { force: true });
    }
}

function write(entry: LogEntry): void {
    // Logging is never worth failing the thing being logged: a disk that refuses
    // the line still leaves it in the window.
    try {
        const dir = logsDir();
        if (!pruned) {
            pruned = true;
            prune(dir);
        }
        appendFileSync(join(dir, `${dayStamp(new Date(entry.at))}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
    } catch {
        // Nowhere left to say so.
    }
}

interface Extra {
    detail?: string;
    runId?: string;
}

function record(level: LogLevel, source: LogSource, message: string, extra: Extra = {}): void {
    const entry: LogEntry = { seq: ++seq, at: new Date().toISOString(), level, source, message, ...extra };
    buffer.push(entry);
    if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
    write(entry);
    for (const listener of listeners) listener(entry);
}

export const log = {
    /** Routine and frequent — a poll that found nothing, an Outlook call that worked. */
    debug: (source: LogSource, message: string, extra?: Extra): void => record('debug', source, message, extra),
    info: (source: LogSource, message: string, extra?: Extra): void => record('info', source, message, extra),
    warn: (source: LogSource, message: string, extra?: Extra): void => record('warn', source, message, extra),
    error: (source: LogSource, message: string, extra?: Extra): void => record('error', source, message, extra),
};

/** What the buffer holds, oldest first. */
export function logEntries(): LogEntry[] {
    return [...buffer];
}

/** Empties the buffer the window reads. The day's file keeps every line. */
export function clearLog(): void {
    buffer.length = 0;
}

/** Called with every entry as it is recorded. Returns its own unsubscribe. */
export function onLogged(listener: (entry: LogEntry) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
