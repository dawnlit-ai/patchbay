import { sendsFile } from '../paths';
import { appendJsonLine, readJsonLines } from './jsonFile';
import type { RepliedEmail } from './replyStore';

/**
 * Every draft a Send node sent in the open workspace, one JSON line each. A run
 * only ever hands a Send the drafts it made itself, so a draft is never offered
 * twice; this is the record that says so if one ever were, and what a person
 * reads to learn what went out, and when.
 */

export interface SendRecord {
    /** When Outlook sent it. */
    at: string;
    runId: string;
    flowId: string;
    nodeId: string;
    /** The mailbox it was sent from. */
    account: string;
    /** Outlook's id for the draft, as the Create email that made it was given. */
    draftEntryId: string;
    /** The slot that named it to the Send. */
    slot: string;
    to: string;
    /** The email whose run sent it. */
    email: RepliedEmail;
}

/** The send of the draft `draftEntryId` in `account`, if a Send already sent it. */
export function findSend(account: string, draftEntryId: string): SendRecord | undefined {
    return readJsonLines<SendRecord>(sendsFile()).find(
        (record) => record.draftEntryId === draftEntryId && record.account.toLowerCase() === account.toLowerCase(),
    );
}

export function recordSend(record: SendRecord): void {
    appendJsonLine(sendsFile(), record);
}
