import { useCallback, useEffect, useState } from 'react';
import { type FlowNode, triggerConfig } from '@shared/flow';
import type { EmailEnvelope } from '@shared/trace';

/**
 * Recent mail in a trigger's mailbox, for picking a real message to test a flow
 * against — in the Test run dialog, and in the sidebar list an email is dragged
 * out of onto the canvas.
 */

/** Marks a drag as an email, and carries its envelope as JSON. */
export const EMAIL_DRAG_TYPE = 'application/patchbay-email';

/** How a trigger reads in a picker: its name, and the mailbox it watches. */
export function triggerLabel(node: FlowNode): string {
    const c = triggerConfig(node);
    const where = c?.account ? `${c.account}${c.folder ? ` \\ ${c.folder}` : ''}` : 'no mailbox';
    return `${node.name} — ${where}`;
}

export interface RecentMail {
    emails: EmailEnvelope[];
    loading: boolean;
    /** Why there is nothing to read yet: no trigger, or no mailbox chosen on it. */
    blocked: string | null;
    /** Outlook was asked and failed. */
    error: string | null;

    /** Read the mailbox again; mail keeps arriving while a list is open. */
    reload(): void;
}

export function useRecentMail(trigger: FlowNode | undefined, days: number, limit: number): RecentMail {
    const config = triggerConfig(trigger);
    const account = config?.account ?? '';
    const folder = config?.folder ?? '';
    const mailbox = JSON.stringify([account, folder]);
    const [attempt, setAttempt] = useState(0);
    const reload = useCallback(() => setAttempt((n) => n + 1), []);
    /** Names one read exactly; a read is still under way until a result carries it. */
    const read = JSON.stringify([account, folder, days, limit, attempt]);

    // Each result says which read and which mailbox it came from, so loading is
    // derived rather than set, and another mailbox's mail is never shown as this
    // one's while the new read runs. A refresh of the same mailbox keeps its list.
    const [result, setResult] = useState<{
        read: string;
        mailbox: string;
        emails: EmailEnvelope[];
        error: string | null;
    } | null>(null);

    // Keyed on the mailbox rather than the node: an edit elsewhere in the flow
    // hands back a new trigger object, and that is no reason to re-read Outlook.
    useEffect(() => {
        if (!account) return;
        let cancelled = false;
        window.api.outlook.recent(account, folder, days, limit).then(
            (emails) => {
                if (!cancelled) setResult({ read, mailbox, emails, error: null });
            },
            (e: Error) => {
                if (cancelled) return;
                setResult((prev) => ({
                    read,
                    mailbox,
                    emails: prev?.mailbox === mailbox ? prev.emails : [],
                    error: e.message,
                }));
            },
        );
        return () => {
            cancelled = true;
        };
    }, [read]);

    const blocked = !trigger
        ? 'This flow has no trigger yet — drag an Outlook Trigger onto the canvas.'
        : !account
            ? `Choose a mailbox on “${trigger.name}” first.`
            : null;

    return {
        emails: !blocked && result?.mailbox === mailbox ? result.emails : [],
        loading: !blocked && result?.read !== read,
        blocked,
        error: !blocked && result?.read === read ? result.error : null,
        reload,
    };
}
