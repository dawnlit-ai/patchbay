import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { EmailMode } from '@shared/flow';
import type { EmailEnvelope } from '@shared/trace';
import { repliesFile } from '../paths';

/**
 * Every email a Create email node drafted in the open workspace, a reply or a
 * new one, one JSON line each.
 * Outlook has no mark a program can put on a draft on both platforms, so this is
 * how the app knows a draft is its own: by the id Outlook gave it. It is also how
 * a second run over the same email knows a reply is already drafted.
 */

/** The email a reply answers, as a later run finds it again: its entry id changes when it is filed. */
export interface RepliedEmail {
    senderEmail: string;
    receivedTime: string;
    subject: string;
}

export interface ReplyRecord {
    /** When it was drafted. */
    at: string;
    /** A reply to the email, or a new email of its own. Left out, as the nightly wrote them: a reply. */
    mode?: EmailMode;
    runId: string;
    flowId: string;
    nodeId: string;
    /** The mailbox the draft sits in. */
    account: string;
    /** Outlook's id for the draft; '' when Outlook could not tell it apart from another draft made in the same moment. */
    draftEntryId: string;
    to: string;
    subject: string;
    template: string;
    section: string;
    email: RepliedEmail;
}

export const repliedEmail = (email: EmailEnvelope): RepliedEmail => ({
    senderEmail: email.senderEmail,
    receivedTime: email.receivedTime,
    subject: email.subject,
});

const sameEmail = (a: RepliedEmail, b: RepliedEmail): boolean =>
    a.senderEmail.toLowerCase() === b.senderEmail.toLowerCase() &&
    a.receivedTime === b.receivedTime &&
    a.subject === b.subject;

/** A torn final line (power loss mid-append) costs that record, not the list. */
function parseRecord(line: string): ReplyRecord | null {
    try {
        return JSON.parse(line) as ReplyRecord;
    } catch {
        return null;
    }
}

export function listReplies(): ReplyRecord[] {
    const file = repliesFile();
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(parseRecord)
        .filter((record) => record !== null);
}

/**
 * The reply this flow already drafted to `email`, the newest if several, by
 * whichever of its nodes: an email gets one reply from a flow, however many ways
 * its routes lead to one.
 */
export function findReply(flowId: string, email: RepliedEmail): ReplyRecord | undefined {
    return listReplies().findLast(
        (record) => record.flowId === flowId && record.mode !== 'new' && sameEmail(record.email, email),
    );
}

/**
 * The new email this node already drafted about `email`, if any. A new email is
 * one per node, not per flow: a flow may tell the office and the trucker each.
 */
export function findNewEmail(flowId: string, nodeId: string, email: RepliedEmail): ReplyRecord | undefined {
    return listReplies().findLast(
        (record) =>
            record.flowId === flowId && record.nodeId === nodeId && record.mode === 'new' && sameEmail(record.email, email),
    );
}

export function recordReply(record: ReplyRecord): void {
    appendFileSync(repliesFile(), JSON.stringify(record) + '\n', 'utf8');
}
