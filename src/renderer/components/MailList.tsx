import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { findTriggers, type Flow } from '@shared/flow';
import { EMAIL_DRAG_TYPE, triggerLabel, useRecentMail } from '../recentMail';

/**
 * The mailbox, beside the canvas. Drag an email out of it onto a trigger and that
 * email runs through the flow from there, now — watching or not, and whether or
 * not the poller has already seen it — so a path can be tried against a message
 * you picked rather than whatever arrives next.
 */

const RANGES = [7, 30, 90] as const;

/** The newest this many; the filter narrows within them. */
const LIMIT = 50;

interface Props {
    flow: Flow;

    /** An email is in the air, so the canvas can show where it may land. */
    onDragging(active: boolean): void;
}

export function MailList({ flow, onDragging }: Props): JSX.Element {
    const triggers = useMemo(() => findTriggers(flow), [flow]);
    // Falls back to the first trigger rather than holding a stale id, so switching
    // flows or deleting the chosen trigger still leaves a mailbox on show.
    const [triggerId, setTriggerId] = useState<string | null>(null);
    const trigger = triggers.find((t) => t.id === triggerId) ?? triggers[0];
    const [days, setDays] = useState<number>(RANGES[0]);
    const [filter, setFilter] = useState('');
    const { emails, loading, blocked, error, reload } = useRecentMail(trigger, days, LIMIT);

    const needle = filter.trim().toLowerCase();
    const shown = needle
        ? emails.filter((e) =>
            [e.subject, e.senderName, e.senderEmail].some((s) => s.toLowerCase().includes(needle)),
        )
        : emails;

    return (
        <>
            <div className="section-title with-action">
                Test with an email
                <button
                    className="ghost"
                    title="Read the mailbox again"
                    disabled={loading || blocked !== null}
                    onClick={reload}
                >
                    {loading ? 'Reading…' : '↻ Refresh'}
                </button>
            </div>

            <div className="side-note gap-below">
                {blocked ?? 'Drag one onto a trigger to run it through this flow.'}
            </div>
            {/* Offered even when the one on show has no mailbox: another trigger may. */}
            {triggers.length > 1 && (
                <select className="gap-below" value={trigger?.id} onChange={(e) => setTriggerId(e.target.value)}>
                    {triggers.map((t) => (
                        <option key={t.id} value={t.id}>
                            {triggerLabel(t)}
                        </option>
                    ))}
                </select>
            )}
            {!blocked && (
                <div className="row mail-tools gap-below">
                    <input
                        placeholder="Filter…"
                        title="Filter by subject or sender"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                    />
                    <select
                        className="fixed"
                        title="How far back to look"
                        value={days}
                        onChange={(e) => setDays(Number(e.target.value))}
                    >
                        {RANGES.map((d) => (
                            <option key={d} value={d}>
                                {d} days
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {error && <div className="err-banner">{error}</div>}
            {loading && emails.length === 0 && <div className="empty">Reading the mailbox…</div>}
            {!blocked && !loading && !error && emails.length === 0 && (
                <div className="empty">Nothing in that folder from the last {days} days.</div>
            )}
            {emails.length > 0 && shown.length === 0 && (
                <div className="empty">Nothing here matches “{filter.trim()}”.</div>
            )}

            {shown.map((email) => (
                <div
                    key={email.ref.entryId}
                    className="mail-row"
                    draggable
                    title={`${email.senderName} <${email.senderEmail}>\n${email.bodyPreview}`}
                    onDragStart={(e) => {
                        e.dataTransfer.setData(EMAIL_DRAG_TYPE, JSON.stringify(email));
                        e.dataTransfer.effectAllowed = 'copy';
                        onDragging(true);
                    }}
                    onDragEnd={() => onDragging(false)}
                >
                    <div className="subject">{email.subject || '(no subject)'}</div>
                    <div className="meta">
                        <span className="from">{email.senderName || email.senderEmail}</span>
                        {email.attachmentNames.length > 0 && (
                            <span title={email.attachmentNames.join('\n')}>📎{email.attachmentNames.length}</span>
                        )}
                        <span>{email.receivedTime}</span>
                    </div>
                </div>
            ))}
        </>
    );
}
