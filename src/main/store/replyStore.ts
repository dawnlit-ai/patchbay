import type { EmailMode } from '@shared/flow';
import type { EmailEnvelope } from '@shared/trace';
import { repliesFile } from '../paths';
import { appendJsonLine, readJsonLines } from './jsonFile';

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
    /** A reply to the email, or a new email of its own. */
    mode: EmailMode;
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

/** The newest record that `matches`, if any. */
const findLast = (matches: (record: ReplyRecord) => boolean): ReplyRecord | undefined =>
    readJsonLines<ReplyRecord>(repliesFile()).findLast(matches);

/**
 * The reply this flow already drafted to `email`, the newest if several, by
 * whichever of its nodes: an email gets one reply from a flow, however many ways
 * its routes lead to one.
 */
export function findReply(flowId: string, email: RepliedEmail): ReplyRecord | undefined {
    return findLast((record) => record.flowId === flowId && record.mode === 'reply' && sameEmail(record.email, email));
}

/**
 * The new email this node already drafted about `email`, if any. A new email is
 * one per node, not per flow: a flow may tell the office and the trucker each.
 */
export function findNewEmail(flowId: string, nodeId: string, email: RepliedEmail): ReplyRecord | undefined {
    return findLast(
        (record) =>
            record.flowId === flowId && record.nodeId === nodeId && record.mode === 'new' && sameEmail(record.email, email),
    );
}

export function recordReply(record: ReplyRecord): void {
    appendJsonLine(repliesFile(), record);
}
