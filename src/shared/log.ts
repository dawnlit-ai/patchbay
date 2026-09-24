/** The console: what the app did outside any one run (polls, Outlook calls, the agent server). */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Lowest first, so an index comparison is a severity comparison. */
export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Which part of the app said it. */
export type LogSource = 'app' | 'watcher' | 'run' | 'outlook' | 'agent';

export const LOG_SOURCES: LogSource[] = ['app', 'watcher', 'run', 'outlook', 'agent'];

export interface LogEntry {
    /** Rises for the life of the process, so a list and a push can be merged. */
    seq: number;
    at: string;
    level: LogLevel;
    source: LogSource;
    message: string;
    /** Long-form payload, shown when the entry is expanded. */
    detail?: string;
    /** The run this entry is about, so the console can open its trace. */
    runId?: string;
}
