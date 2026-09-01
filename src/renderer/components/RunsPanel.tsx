import type { JSX } from 'react';
import { useState } from 'react';
import type { Pass, Run, RunSummary, TraceEvent } from '@shared/trace';

/**
 * The run log. The list is the audit trail; the detail is the "why" — each pass
 * in order, the port it left by, and the events behind that decision.
 */

function statusBadge(status: string): JSX.Element {
    const cls = status === 'completed' ? 'ok' : status === 'failed' ? 'err' : 'run';
    return <span className={`badge ${cls}`}>{status}</span>;
}

const time = (iso: string): string => new Date(iso).toLocaleTimeString();

function EventRow({ event }: { event: TraceEvent }): JSX.Element {
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

function PassCard({ pass }: { pass: Pass }): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
        <div className="pass">
            <div className="pass-head" onClick={() => setOpen(!open)}>
                <span className="idx">{pass.seq}</span>
                <span className="name">{pass.nodeName}</span>
                {pass.outPort && (
                    <>
                        <span className="arrow">→</span>
                        <span className="port">{pass.outPort.replace(/^cat:/, '')}</span>
                    </>
                )}
                <span className="spacer"/>
                {pass.cost && pass.cost.usd > 0 && (
                    <span className="badge">
                        ${pass.cost.usd.toFixed(3)} · {pass.cost.turns} turns
                    </span>
                )}
                <span className={`badge ${pass.status === 'ok' ? 'ok' : 'err'}`}>{pass.status}</span>
                <span className="count">
                    {open ? '▾' : '▸'} {pass.events.length}
                </span>
            </div>
            <div className="pass-summary">{pass.summary}</div>
            {open && (
                <div className="pass-events">
                    {pass.events.length === 0 && <div className="empty">No events recorded for this pass.</div>}
                    {pass.events.map((event, i) => (
                        <EventRow key={i} event={event}/>
                    ))}
                </div>
            )}
        </div>
    );
}

interface Props {
    runs: RunSummary[];
    selected: Run | null;
    collapsed: boolean;

    onToggleCollapsed(): void;

    onSelect(id: string): void;

    onClear(): void;

    onReveal(): void;

    onCancel(runId: string): void;
}

export function RunsPanel({
                              runs,
                              selected,
                              collapsed,
                              onToggleCollapsed,
                              onSelect,
                              onClear,
                              onReveal,
                              onCancel,
                          }: Props): JSX.Element {
    if (collapsed) {
        return (
            <div className="runs collapsed">
                <div className="panel-head">
                    <strong>Runs</strong>
                    <span className="badge">{runs.length}</span>
                    <span className="spacer"/>
                    <button className="ghost" onClick={onToggleCollapsed}>
                        ▴ Show
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="runs">
            <div className="runs-list">
                <div className="panel-head">
                    <strong>Runs</strong>
                    <span className="spacer"/>
                    <button className="ghost" onClick={onReveal} title="Open the runs folder">
                        Folder
                    </button>
                    <button className="ghost" onClick={onClear}>
                        Clear
                    </button>
                    <button className="ghost" onClick={onToggleCollapsed}>
                        ▾
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
                        </div>
                    </div>
                ))}
            </div>

            <div className="runs-detail">
                {!selected && <div className="empty">Select a run to see the path it took.</div>}
                {selected && (
                    <>
                        <div className="panel-head plain">
                            <strong>{selected.email.subject || '(no subject)'}</strong>
                            <span className="spacer"/>
                            {statusBadge(selected.status)}
                            {selected.status === 'running' && (
                                <button className="danger" onClick={() => onCancel(selected.id)}>
                                    Cancel
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
                        <div className="kv">
                            <b>Cost</b>
                            <span>${selected.totalCostUsd.toFixed(4)}</span>
                        </div>
                        {selected.email.attachmentNames.length > 0 && (
                            <div className="kv">
                                <b>Files</b>
                                <span>{selected.email.attachmentNames.join(', ')}</span>
                            </div>
                        )}
                        {selected.error && <div className="err-banner">{selected.error}</div>}

                        <div className="section-title">Path</div>
                        {selected.passes.map((pass) => (
                            <PassCard key={pass.seq} pass={pass}/>
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}
