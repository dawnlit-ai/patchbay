import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import type { Flow } from '@shared/flow';
import { findTriggers } from '@shared/flow';
import type { EmailEnvelope } from '@shared/trace';
import { triggerLabel, useRecentMail } from '../recentMail';
import { Modal } from './Modal';

/**
 * Push one real email through the flow on demand — wire it up, run a message you
 * already understand, read the trace, adjust. Ignores the watermark, so the same
 * email can be run repeatedly. A flow with several triggers is tested one trigger
 * at a time: the chosen one supplies the mailbox to list and starts the run.
 */

const DAYS = 7;
const LIMIT = 25;

interface Props {
    flow: Flow;

    onClose(): void;

    onRun(nodeId: string, email: EmailEnvelope): void;
}

export function TestRunDialog({ flow, onClose, onRun }: Props): JSX.Element {
    const triggers = useMemo(() => findTriggers(flow), [flow]);
    // The choice is held rather than derived: a save landing behind the dialog
    // rebuilds the flow object, and that must not reset which trigger is picked.
    const [triggerId, setTriggerId] = useState(triggers[0]?.id ?? '');
    const [selected, setSelected] = useState<string | null>(null);

    const trigger = triggers.find((t) => t.id === triggerId);
    const { emails, loading, blocked, error } = useRecentMail(trigger, DAYS, LIMIT);

    const chosen = emails.find((e) => e.ref.entryId === selected);

    return (
        <Modal
            wide
            onClose={onClose}
            title={
                <>
                    Test run — pick an email
                    <span className="spacer"/>
                    <span className="badge">{flow.name}</span>
                </>
            }
            footer={
                <>
                    <button onClick={onClose}>Cancel</button>
                    <button
                        className="primary"
                        disabled={!chosen}
                        onClick={() => {
                            if (chosen) onRun(triggerId, chosen);
                        }}
                    >
                        Run this email
                    </button>
                </>
            }
        >
            {triggers.length > 1 && (
                <label className="field">
                    <span>Start from</span>
                    <select
                        value={triggerId}
                        onChange={(e) => {
                            setTriggerId(e.target.value);
                            setSelected(null);
                        }}
                    >
                        {triggers.map((t) => (
                            <option key={t.id} value={t.id}>
                                {triggerLabel(t)}
                            </option>
                        ))}
                    </select>
                </label>
            )}
            {loading && <div className="empty">Reading the mailbox…</div>}
            {(blocked ?? error) && <div className="err-banner">{blocked ?? error}</div>}
            {!loading && !blocked && !error && emails.length === 0 && (
                <div className="empty">Nothing in that folder from the last {DAYS} days.</div>
            )}
            {emails.map((email) => (
                <div
                    key={email.ref.entryId}
                    className={`list-row${selected === email.ref.entryId ? ' active' : ''}`}
                    onClick={() => setSelected(email.ref.entryId)}
                >
                    <div className="grow">
                        <strong>{email.subject || '(no subject)'}</strong>
                        <div className="desc">
                            {email.senderEmail} · {email.receivedTime}
                            {email.attachmentNames.length > 0 && ` · ${email.attachmentNames.length} file(s)`}
                        </div>
                    </div>
                </div>
            ))}
        </Modal>
    );
}
