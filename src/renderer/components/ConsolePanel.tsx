import type { JSX } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { LOG_LEVELS, type LogEntry, type LogLevel, type LogSource } from '@shared/log';

/**
 * The console. Where the runs panel answers "why did this email go there", this
 * answers the questions no run can: whether the poller looked, what it saw, which
 * Outlook call was slow, and what an agent did. Newest at the bottom, and it
 * follows new lines unless you have scrolled up to read.
 */

const SOURCES: LogSource[] = ['app', 'watcher', 'run', 'outlook', 'agent'];

/** The quietest level each choice shows. */
const LEVEL_CHOICES: { level: LogLevel; label: string }[] = [
    { level: 'debug', label: 'Everything' },
    { level: 'info', label: 'Info and up' },
    { level: 'warn', label: 'Warnings and errors' },
    { level: 'error', label: 'Errors only' },
];

/**
 * What the console is filtered to. Held by the app rather than the panel, so a
 * trip to a run's trace and back finds the console as it was left.
 */
export interface ConsoleView {
    minLevel: LogLevel;
    source: LogSource | '';
    filter: string;
}

export const DEFAULT_CONSOLE_VIEW: ConsoleView = { minLevel: 'info', source: '', filter: '' };

/** Within this many pixels of the end counts as reading the newest lines. */
const STICK_PX = 24;

const time = (iso: string): string => new Date(iso).toLocaleTimeString();

function LogRow({ entry, onOpenRun }: { entry: LogEntry; onOpenRun(runId: string): void }): JSX.Element {
    const [open, setOpen] = useState(false);
    const expandable = Boolean(entry.detail);
    return (
        <div className={`log-row level-${entry.level}`}>
            <div className={`head${expandable ? ' expandable' : ''}`} onClick={() => expandable && setOpen(!open)}>
                <span className="at">{time(entry.at)}</span>
                <span className="level">{entry.level}</span>
                <span className="source">{entry.source}</span>
                <span className="message">
                    {expandable && <span className="dim">{open ? '▾ ' : '▸ '}</span>}
                    {entry.message}
                </span>
                {entry.runId && (
                    <button
                        className="ghost"
                        title="Show this run's trace"
                        onClick={(e) => {
                            e.stopPropagation();
                            onOpenRun(entry.runId as string);
                        }}
                    >
                        Trace →
                    </button>
                )}
            </div>
            {open && entry.detail && <pre>{entry.detail}</pre>}
        </div>
    );
}

interface Props {
    entries: LogEntry[];
    view: ConsoleView;

    onView(view: ConsoleView): void;

    onClear(): void;

    onReveal(): void;

    onOpenRun(runId: string): void;
}

export function ConsolePanel({ entries, view, onView, onClear, onReveal, onOpenRun }: Props): JSX.Element {
    const { minLevel, source, filter } = view;
    const scroller = useRef<HTMLDivElement>(null);
    /** Read on scroll rather than on render: by render time the new line has moved the end. */
    const following = useRef(true);

    const floor = LOG_LEVELS.indexOf(minLevel);
    const needle = filter.trim().toLowerCase();
    const shown = entries.filter(
        (e) =>
            LOG_LEVELS.indexOf(e.level) >= floor &&
            (!source || e.source === source) &&
            (!needle || e.message.toLowerCase().includes(needle)),
    );

    // Keyed on the newest line rather than the count: once the buffer is full, a
    // new line arrives as an old one leaves and the count stands still. Before
    // paint, so a new line never flashes a frame above the fold first.
    const newest = shown.at(-1)?.seq;
    useLayoutEffect(() => {
        const el = scroller.current;
        if (el && following.current) el.scrollTop = el.scrollHeight;
    }, [newest, minLevel, source, needle]);

    return (
        <div className="console">
            <div className="panel-head">
                <select
                    className="compact"
                    value={minLevel}
                    onChange={(e) => onView({ ...view, minLevel: e.target.value as LogLevel })}
                >
                    {LEVEL_CHOICES.map((c) => (
                        <option key={c.level} value={c.level}>
                            {c.label}
                        </option>
                    ))}
                </select>
                <select
                    className="compact"
                    value={source}
                    onChange={(e) => onView({ ...view, source: e.target.value as LogSource | '' })}
                >
                    <option value="">All sources</option>
                    {SOURCES.map((s) => (
                        <option key={s} value={s}>
                            {s}
                        </option>
                    ))}
                </select>
                <input
                    className="compact"
                    placeholder="Filter"
                    value={filter}
                    onChange={(e) => onView({ ...view, filter: e.target.value })}
                />
                <span className="spacer"/>
                <button className="ghost" onClick={onReveal} title="Open the folder of daily log files">
                    Folder
                </button>
                <button className="ghost" onClick={onClear} title="Clear the window; the log files keep every line">
                    Clear
                </button>
            </div>
            <div
                className="console-lines"
                ref={scroller}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
                }}
            >
                {shown.length === 0 && (
                    <div className="empty">
                        {entries.length === 0 ? 'Nothing logged yet.' : 'Nothing logged matches these filters.'}
                    </div>
                )}
                {shown.map((entry) => (
                    <LogRow key={entry.seq} entry={entry} onOpenRun={onOpenRun}/>
                ))}
            </div>
        </div>
    );
}
