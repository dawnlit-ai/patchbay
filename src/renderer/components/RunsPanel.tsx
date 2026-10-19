import type { JSX } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { LiveText, Pass, PassUnderWay, Run, RunSummary, TraceEvent } from '@shared/trace';
import { activity, liveLabel } from '../activity';
import { duration, time } from '../format';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Elapsed } from './Elapsed';

/**
 * The run log. The list is the audit trail; the detail is the "why" — each pass
 * in order, the port it left by, and the events behind that decision.
 */

function statusBadge(status: string): JSX.Element {
    const cls = status === 'completed' ? 'ok' : status === 'failed' ? 'err' : 'run';
    return <span className={`badge ${cls}`}>{status}</span>;
}

function EventRow({event}: { event: TraceEvent }): JSX.Element {
    const [open, setOpen] = useState(false);
    const expandable = Boolean(event.detail);
    return (
        <div className={`event ${event.type}`}>
            <div className="head" onClick={() => expandable && setOpen(!open)}>
                <span className="type">{event.type}</span>
                <span className="label">
                    {expandable && <span className="dim">{open ? '▾ ' : '▸ '}</span>}
                    {event.label}
                </span>
            </div>
            {open && event.detail && <pre>{event.detail}</pre>}
        </div>
    );
}

/** What the agent is writing now, kept scrolled to its newest line. */
function LiveRow({live}: { live: LiveText }): JSX.Element {
    const box = useRef<HTMLPreElement>(null);
    useLayoutEffect(() => {
        if (box.current) box.current.scrollTop = box.current.scrollHeight;
    }, [live.text]);
    return (
        <div className={`event ${live.type} live`}>
            <div className="head">
                <span className="type">{live.type}</span>
                <span className="label">{liveLabel(live)}</span>
            </div>
            {/* A thinking block can arrive with its text left out. */}
            {live.text && (
                <pre ref={box}>
                    {live.text}
                    <span className="caret"/>
                </pre>
            )}
        </div>
    );
}

/**
 * One node's pass, finished or under way. The one under way starts open, and
 * keeps its card when it finishes, so what was being watched stays in view.
 */
function PassCard({pass}: { pass: Pass | PassUnderWay }): JSX.Element {
    const done = 'status' in pass;
    const live = done ? undefined : pass.live;
    const [open, setOpen] = useState(!done);
    return (
        <div className={`pass${done ? '' : ' under-way'}`}>
            <div className="pass-head" onClick={() => setOpen(!open)}>
                <span className="idx">{pass.seq}</span>
                <span className="name">{pass.nodeName}</span>
                {done && pass.outPort && (
                    <>
                        <span className="arrow">→</span>
                        <span className="port">{pass.outPort.replace(/^cat:/, '')}</span>
                    </>
                )}
                <span className="spacer"/>
                {done ? (
                    <>
                        <span className="took">
                            {duration(new Date(pass.endedAt).getTime() - new Date(pass.startedAt).getTime())}
                        </span>
                        <span className={`badge ${pass.status === 'ok' ? 'ok' : 'err'}`}>{pass.status}</span>
                    </>
                ) : (
                    <span className="badge run">
                        working · <Elapsed from={pass.startedAt}/>
                    </span>
                )}
                <span className="count">
                    {open ? '▾' : '▸'} {pass.events.length}
                </span>
            </div>
            <div className="pass-summary">{done ? pass.summary : activity(pass)}</div>
            {open && (
                <div className="pass-events">
                    {pass.events.length === 0 && !live && (
                        <div className="empty">{done ? 'No events recorded for this pass.' : 'Nothing yet.'}</div>
                    )}
                    {pass.events.map((event, i) => (
                        <EventRow key={i} event={event}/>
                    ))}
                    {live && <LiveRow live={live}/>}
                </div>
            )}
        </div>
    );
}

interface Props {
    runs: RunSummary[];
    selected: Run | null;

    onSelect(id: string): void;

    onClear(): void;

    onReveal(): void;

    onCancel(runId: string): void;

    onRemove(runId: string): void;

    onRerun(runId: string): void;
}

export function RunsPanel({
                              runs,
                              selected,
                              onSelect,
                              onClear,
                              onReveal,
                              onCancel,
                              onRemove,
                              onRerun
                          }: Props): JSX.Element {
    const [menu, setMenu] = useState<{ run: RunSummary; x: number; y: number } | null>(null);

    /** Whether the detail is scrolled to its end, and so stays there as a run under way grows. */
    const detail = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    // Before the effect below, which it is for: a run just picked starts at its newest pass.
    useLayoutEffect(() => {
        following.current = true;
    }, [selected?.id]);
    useLayoutEffect(() => {
        const el = detail.current;
        if (el && following.current && selected?.status === 'running') el.scrollTop = el.scrollHeight;
    }, [selected]);

    /** A run under way can only be stopped; one that has ended can run again, or go. */
    const actions = (run: RunSummary): MenuItem[] =>
        run.status === 'running'
            ? [{label: 'Cancel run', danger: true, onSelect: () => onCancel(run.id)}]
            : [
                {label: 'Run this email again', onSelect: () => onRerun(run.id)},
                {label: 'Delete run', separator: true, danger: true, onSelect: () => onRemove(run.id)},
            ];

    return (
        <div className="runs">
            <div className="runs-list">
                <div className="panel-head">
                    <span className="spacer"/>
                    <button className="ghost" onClick={onReveal} title="Open the runs folder">
                        Folder
                    </button>
                    <button className="ghost" onClick={onClear}>
                        Clear
                    </button>
                </div>
                {runs.length === 0 && (
                    <div className="empty">
                        No runs yet. Start watching, or use “Test run” to push one email through the flow.
                    </div>
                )}
                {runs.map((run) => (
                    <div
                        key={run.id}
                        className={`run-row${selected?.id === run.id ? ' active' : ''}`}
                        onClick={() => onSelect(run.id)}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            setMenu({run, x: e.clientX, y: e.clientY});
                        }}
                    >
                        <div className="subject">{run.subject || '(no subject)'}</div>
                        <div className="meta">
                            <span>{time(run.startedAt)}</span>
                            <span>·</span>
                            <span>{run.senderEmail}</span>
                        </div>
                        <div className="meta">
                            {statusBadge(run.status)}
                            {run.disposition && <span className="badge">{run.disposition}</span>}
                            {run.trigger === 'manual' && <span className="badge">test</span>}
                            <span className="badge">{run.passCount} passes</span>
                            {run.status === 'running' && run.at && <span className="at">at {run.at}</span>}
                        </div>
                    </div>
                ))}
            </div>

            <div
                className="runs-detail"
                ref={detail}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
                }}
            >
                {!selected && <div className="empty">Select a run to see the path it took.</div>}
                {selected && (
                    <>
                        <div className="panel-head plain">
                            <strong>{selected.email.subject || '(no subject)'}</strong>
                            <span className="spacer"/>
                            {statusBadge(selected.status)}
                            {selected.status === 'running' ? (
                                <button className="danger" onClick={() => onCancel(selected.id)}>
                                    Cancel
                                </button>
                            ) : (
                                <button className="ghost" onClick={() => onRemove(selected.id)}
                                        title="Delete this run">
                                    Delete
                                </button>
                            )}
                        </div>

                        <div className="kv">
                            <b>From</b>
                            <span>
                                {selected.email.senderName} &lt;{selected.email.senderEmail}&gt;
                            </span>
                        </div>
                        <div className="kv">
                            <b>Received</b>
                            <span>{selected.email.receivedTime}</span>
                        </div>
                        <div className="kv">
                            <b>Flow</b>
                            <span>{selected.flowName}</span>
                        </div>
                        {selected.email.attachmentNames.length > 0 && (
                            <div className="kv">
                                <b>Files</b>
                                <span>{selected.email.attachmentNames.join(', ')}</span>
                            </div>
                        )}
                        {selected.error && <div className="err-banner">{selected.error}</div>}

                        <div className="section-title">Path</div>
                        {/* Keyed by seq, so the pass under way keeps its card once it finishes. */}
                        {[...selected.passes, ...(selected.current ? [selected.current] : [])].map((pass) => (
                            <PassCard key={pass.seq} pass={pass}/>
                        ))}
                    </>
                )}
            </div>

            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    label={menu.run.subject || '(no subject)'}
                    items={actions(menu.run)}
                    onClose={() => setMenu(null)}
                />
            )}
        </div>
    );
}
