import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { Flow } from '@shared/flow';
import { findTriggers, triggerConfig } from '@shared/flow';
import type { EmailEnvelope } from '@shared/trace';

/**
 * Push one real email through the flow on demand — wire it up, run a message you
 * already understand, read the trace, adjust. Ignores the watermark, so the same
 * email can be run repeatedly. A flow with several triggers is tested one trigger
 * at a time: the chosen one supplies the mailbox to list and starts the run.
 */

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
    const [emails, setEmails] = useState<EmailEnvelope[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);

    const trigger = triggers.find((t) => t.id === triggerId);
    const config = triggerConfig(trigger);

    useEffect(() => {
        setEmails([]);
        setSelected(null);
        setError(null);
        if (!trigger) {
            setError('This flow has no trigger yet — drag an Outlook Trigger onto the canvas.');
            setLoading(false);
            return;
        }
        if (!config?.account) {
            setError(`Choose a mailbox on “${trigger.name}” first.`);
            setLoading(false);
            return;
        }
        setLoading(true);
        let cancelled = false;
        window.api.outlook
            .recent(config.account, config.folder, 25)
            .then((list) => {
                if (!cancelled) setEmails(list);
            })
            .catch((e: Error) => {
                if (!cancelled) setError(e.message);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // Keyed on the mailbox rather than the node: an edit elsewhere in the flow
        // hands back a new trigger object, and that is no reason to re-read Outlook.
    }, [triggerId, config?.account, config?.folder]);

    const chosen = emails.find((e) => e.ref.entryId === selected);

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <header>
                    Test run — pick an email
                    <span className="spacer"/>
                    <span className="badge">{flow.name}</span>
                </header>
                <div className="content">
                    {triggers.length > 1 && (
                        <label className="field">
                            <span>Start from</span>
                            <select value={triggerId} onChange={(e) => setTriggerId(e.target.value)}>
                                {triggers.map((t) => {
                                    const c = triggerConfig(t);
                                    const where = c?.account
                                        ? `${c.account}${c.folder ? ` \\ ${c.folder}` : ''}`
                                        : 'no mailbox';
                                    return (
                                        <option key={t.id} value={t.id}>
                                            {t.name} — {where}
                                        </option>
                                    );
                                })}
                            </select>
                        </label>
                    )}
                    {loading && <div className="empty">Reading the mailbox…</div>}
                    {error && <div className="err-banner">{error}</div>}
                    {!loading && !error && emails.length === 0 && (
                        <div className="empty">Nothing in that folder from the last 7 days.</div>
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
                </div>
                <footer>
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
                </footer>
            </div>
        </div>
    );
}
