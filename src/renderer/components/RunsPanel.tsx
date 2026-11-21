import type { JSX } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import {
    type LiveText,
    type MonitorSeverity,
    type MonitorState,
    type MonitorSummary,
    monitorSummary,
    type Pass,
    type PassUnderWay,
    type Run,
    type RunSummary,
    type TraceEvent,
} from '@shared/trace';
import { activity, liveLabel } from '../activity';
import { duration, time } from '../format';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Elapsed } from './Elapsed';
import { Expandable } from './Expandable';
import { Pane } from './Pane';

/**
 * The run log. The list is the audit trail; the detail is the "why" — each pass
 * in order, the port it left by, and the events behind that decision.
 */

function statusBadge(status: string): JSX.Element {
    const cls = status === 'completed' ? 'ok' : status === 'failed' ? 'err' : 'run';
    return <span className={`badge ${cls}`}>{status}</span>;
}

/**
 * Where the monitor is with a run. A review recorded as under way with none
 * under way was cut off: Patchbay closed, or another workspace was opened.
 */
type MonitorStage = MonitorState | 'unfinished';

function monitorStage(state: MonitorState, runEnded: boolean, underReview: boolean): MonitorStage {
    // An ended run is handed to its review straight away.
    if (state === 'watching') return runEnded ? 'reviewing' : 'watching';
    if (state === 'reviewing') return underReview ? 'reviewing' : 'unfinished';
    return state;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The monitor in a word or two, for a run's row and the head of its review. */
function monitorBadge(stage: MonitorStage, monitor: MonitorSummary): JSX.Element {
    switch (stage) {
        case 'watching':
            return <span className="badge run">monitor watching</span>;
        case 'reviewing':
            return <span className="badge run">monitor reviewing</span>;
        case 'unfinished':
            return <span className="badge">review unfinished</span>;
        case 'failed':
            return <span className="badge err">review failed</span>;
        case 'skipped':
            return <span className="badge">not reviewed</span>;
        case 'done':
            if (monitor.verdict === 'problem') return <span className="badge err">monitor: problem</span>;
            return monitor.asks > 0 ? (
                <span className="badge warn">monitor: {plural(monitor.asks, 'suggestion')}</span>
            ) : (
                <span className="badge ok">monitor: fine</span>
            );
    }
}

const SEVERITY_BADGE: Record<MonitorSeverity, string> = {note: '', suggestion: 'warn', problem: 'err'};

/**
 * What the AI monitor made of a run: watching while it is under way, then its
 * review — a verdict, a summary, and findings that each name a node — and, folded,
 * what it was sent.
 */
function MonitorCard({run, underReview, onStop}: {
    run: Run;
    underReview: boolean;
    onStop(): void;
}): JSX.Element | null {
    const [open, setOpen] = useState(false);
    const monitor = run.monitor;
    if (!monitor) return null;
    const stage = monitorStage(monitor.state, run.status !== 'running', underReview);
    return (
        <>
            <div className="section-title">AI monitor</div>
            <div className="monitor">
                <div className="monitor-head">
                    {monitorBadge(stage, monitorSummary(monitor))}
                    {stage === 'reviewing' && monitor.startedAt && (
                        <span className="took">
                            <Elapsed from={monitor.startedAt}/>
                        </span>
                    )}
                    <span className="spacer"/>
                    {stage === 'reviewing' && (
                        <button className="ghost compact" onClick={onStop} title="Stop this review; the run is kept">
                            Stop review
                        </button>
                    )}
                </div>
                {stage === 'watching' && (
                    <div className="monitor-line">Watching this run. It reviews the whole run once it ends.</div>
                )}
                {stage === 'reviewing' && (
                    <div className="monitor-line">Reading the trace against the flow…</div>
                )}
                {stage === 'unfinished' && (
                    <div className="monitor-line">
                        The review was cut off before it finished: Patchbay closed, or another workspace was opened.
                    </div>
                )}
                {monitor.error && stage !== 'unfinished' && (
                    <div className={stage === 'failed' ? 'err-banner' : 'monitor-line'}>{monitor.error}</div>
                )}
                {monitor.summary && <div className="monitor-summary">{monitor.summary}</div>}
                {stage === 'done' && monitor.findings.length === 0 && (
                    <div className="monitor-line">Nothing in the flow it would change.</div>
                )}
                {monitor.findings.map((finding, i) => (
                    <div key={i} className={`finding ${finding.severity}`}>
                        <div className="finding-head">
                            <span className={`badge ${SEVERITY_BADGE[finding.severity]}`}>{finding.severity}</span>
                            <span className="name">{finding.nodeName ?? 'The flow as a whole'}</span>
                        </div>
                        {finding.observed && <div className="finding-saw">{finding.observed}</div>}
                        {finding.suggestion && (
                            <div className="finding-change">
                                <b>Change</b> {finding.suggestion}
                            </div>
                        )}
                    </div>
                ))}
                {monitor.events.length > 0 && (
                    <>
                        <button className="monitor-events-toggle" onClick={() => setOpen(!open)}>
                            {open ? '▾' : '▸'} What it was sent, and noted ({monitor.events.length})
                        </button>
                        {open && (
                            <div className="pass-events">
                                {monitor.events.map((event, i) => (
                                    <EventRow key={i} event={event}/>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>
        </>
    );
}

function EventRow({event}: { event: TraceEvent }): JSX.Element {
    return (
        <Expandable
            className={`event ${event.type}`}
            detail={event.detail}
            head={(marker) => (
                <>
                    <span className="type">{event.type}</span>
                    <span className="label">
                        {marker}
                        {event.label}
                    </span>
                </>
            )}
        />
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
 * `onMenu`, when given, is what right-clicking it offers.
 */
function PassCard({pass, onMenu}: {
    pass: Pass | PassUnderWay;
    onMenu?: (x: number, y: number) => void
}): JSX.Element {
    const done = 'status' in pass;
    const live = done ? undefined : pass.live;
    const carried = done && pass.carried === true;
    const [open, setOpen] = useState(!done);
    return (
        <div className={`pass${done ? '' : ' under-way'}${carried ? ' carried' : ''}`}>
            <div
                className="pass-head"
                onClick={() => setOpen(!open)}
                onContextMenu={
                    onMenu &&
                    ((e) => {
                        e.preventDefault();
                        onMenu(e.clientX, e.clientY);
                    })
                }
            >
                <span className="idx">{pass.seq}</span>
                <span className="name">{pass.nodeName}</span>
                {done && pass.outPort && (
                    <>
                        <span className="arrow">→</span>
                        <span className="port">{pass.outPort.replace(/^cat:/, '')}</span>
                    </>
                )}
                <span className="spacer"/>
                {carried && (
                    <span className="badge"
                          title="Carried over from the run this one continues, as it ran there: not run again">
                        carried
                    </span>
                )}
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
    /** Runs that have ended and that the AI monitor is reviewing now. */
    reviewing: string[];

    onSelect(id: string): void;

    onClear(): void;

    onReveal(): void;

    onCancel(runId: string): void;

    onRemove(runId: string): void;

    onRerun(runId: string): void;

    /** Wind a finished run back to just before its pass `seq`, and run on from that pass's node. */
    onContinue(runId: string, seq: number): void;
}

export function RunsPanel({
                              runs,
                              selected,
                              reviewing,
                              onSelect,
                              onClear,
                              onReveal,
                              onCancel,
                              onRemove,
                              onRerun,
                              onContinue,
                          }: Props): JSX.Element {
    const [menu, setMenu] = useState<{ run: RunSummary; x: number; y: number } | null>(null);
    /** A pass of the selected run, right-clicked, and where. */
    const [passMenu, setPassMenu] = useState<{ runId: string; pass: Pass; x: number; y: number } | null>(null);

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
                ...(reviewing.includes(run.id)
                    ? [{label: 'Stop the monitor’s review', onSelect: () => onCancel(run.id)}]
                    : []),
                {label: 'Run this email again', onSelect: () => onRerun(run.id)},
                {label: 'Delete run', separator: true, danger: true, onSelect: () => onRemove(run.id)},
            ];

    return (
        <div className="runs">
            <Pane className="runs-list" name="runs-list" edge="right" label="Resize the list of runs">
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
                            {run.continuedFrom && (
                                <span className="badge" title={`Continued from ${run.continuedFrom.nodeName}`}>
                                    continued
                                </span>
                            )}
                            <span className="badge">{run.passCount} passes</span>
                            {run.monitor &&
                                monitorBadge(
                                    monitorStage(run.monitor.state, run.status !== 'running', reviewing.includes(run.id)),
                                    run.monitor,
                                )}
                            {run.status === 'running' && run.at && <span className="at">at {run.at}</span>}
                        </div>
                    </div>
                ))}
            </Pane>

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
                        {selected.continuedFrom && (
                            <div className="kv">
                                <b>Continued</b>
                                <span>
                                    from {selected.continuedFrom.nodeName}, pass {selected.continuedFrom.seq} of{' '}
                                    <button
                                        className="link"
                                        onClick={() => selected.continuedFrom && onSelect(selected.continuedFrom.runId)}
                                    >
                                        an earlier run
                                    </button>
                                </span>
                            </div>
                        )}
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
                            <PassCard
                                key={pass.seq}
                                pass={pass}
                                onMenu={
                                    selected.status === 'running' || !('status' in pass)
                                        ? undefined
                                        : (x, y) => setPassMenu({runId: selected.id, pass, x, y})
                                }
                            />
                        ))}

                        <MonitorCard
                            key={selected.id}
                            run={selected}
                            underReview={reviewing.includes(selected.id)}
                            onStop={() => onCancel(selected.id)}
                        />
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
            {passMenu && (
                <ContextMenu
                    x={passMenu.x}
                    y={passMenu.y}
                    label={`${passMenu.pass.seq} · ${passMenu.pass.nodeName}`}
                    items={[
                        {
                            label: 'Continue the run from here',
                            onSelect: () => onContinue(passMenu.runId, passMenu.pass.seq),
                        },
                    ]}
                    onClose={() => setPassMenu(null)}
                />
            )}
        </div>
    );
}
