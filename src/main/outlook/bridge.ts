import type {
    EmailBodyResult,
    InboxEmail,
    InboxFolderInfo,
    MoveEmailsResult,
    ReplyEmailParams,
    ReplyEmailResult,
    SavedAttachment,
} from '@dawnlit/outlook-bridge';
import type { MailScope } from '@shared/flow';
import type { EmailEnvelope, EmailRef } from '@shared/trace';
import type { InboxFolderOption, OutlookDrag } from '@shared/ipc';
import { log } from '../log';

/**
 * A thin seam over @dawnlit/outlook-bridge, which drives the real Outlook client
 * over COM: every call spawns PowerShell and can take seconds. Imported lazily,
 * so a machine without Outlook still opens a window — the failure belongs on the
 * node that needed a mailbox, not on startup.
 */

type BridgeModule = typeof import('@dawnlit/outlook-bridge');

let mod: BridgeModule | null = null;

async function bridge(): Promise<BridgeModule> {
    mod ??= await import('@dawnlit/outlook-bridge');
    return mod;
}

/**
 * Outlook's COM automation is single-threaded: a second script blocks until the
 * first finishes, and against a slow call simply burns its timeout waiting. The
 * poller, the folder lookup and a skill's `read_email` all want the mailbox, so
 * every call queues here and they take turns.
 */
let chain: Promise<unknown> = Promise.resolve();

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * Every call is timed into the console, and the wait in the queue is reported
 * apart from the call itself: a call that was slow because another was slow is
 * the queue doing its job, not Outlook struggling.
 */
function serialize<T>(label: string, work: () => Promise<T>): Promise<T> {
    const queuedAt = Date.now();
    const timed = async (): Promise<T> => {
        const startedAt = Date.now();
        const waited = startedAt - queuedAt;
        const took = (): string =>
            `${seconds(Date.now() - startedAt)}${waited >= 1000 ? `, after ${seconds(waited)} queued` : ''}`;
        try {
            const result = await work();
            log.debug('outlook', `${label} (${took()})`);
            return result;
        } catch (e) {
            log.warn('outlook', `${label} failed (${took()}): ${e instanceof Error ? e.message : String(e)}`);
            throw e;
        }
    };
    // Each link swallows its predecessor's rejection, so one failed call does not
    // poison the queue behind it.
    const next = chain.then(timed, timed);
    chain = next.catch(() => undefined);
    return next;
}

export async function getAccounts(): Promise<string[]> {
    return serialize('List accounts', async () => (await bridge()).getOutlookAccounts());
}

export async function listFolders(account: string): Promise<InboxFolderOption[]> {
    const b = await bridge();
    const folders: InboxFolderInfo[] = await serialize(`List folders in ${account}`, () =>
        b.listInboxFolders(account),
    );
    const options: InboxFolderOption[] = [
        { folderPath: '', relativePath: '', name: 'Inbox (all)', depth: 0, itemCount: 0 },
    ];
    for (const f of folders) {
        options.push({
            folderPath: f.folderPath,
            relativePath: underInbox(f.folderPath) ?? f.name,
            name: `${'— '.repeat(Math.max(0, f.depth - 1))}${f.name}`,
            depth: f.depth,
            itemCount: f.itemCount,
        });
    }
    return options;
}

/**
 * A folder as a trigger stores it: its path relative to the Inbox — what
 * readInboxEmails takes as `folder` — and '' for the Inbox itself. Outlook
 * reports full paths (`\\team@example.com\Inbox\Mobile, AL`); null for one
 * outside the Inbox.
 */
function underInbox(folderPath: string): string | null {
    const lower = folderPath.toLowerCase();
    const at = lower.indexOf('\\inbox\\');
    if (at >= 0) return folderPath.slice(at + '\\inbox\\'.length);
    return lower.endsWith('\\inbox') ? '' : null;
}

/** What an envelope is built from — a folder listing's row, or a tree search's match. */
type ListedEmail = Pick<
    InboxEmail,
    | 'entryId'
    | 'storeId'
    | 'folderPath'
    | 'subject'
    | 'senderName'
    | 'senderEmail'
    | 'receivedTime'
    | 'bodyPreview'
    | 'attachmentNames'
>;

function toEnvelope(account: string, e: ListedEmail): EmailEnvelope {
    const ref: EmailRef = {
        entryId: e.entryId,
        storeId: e.storeId,
        account,
        folderPath: e.folderPath,
    };
    return {
        ref,
        subject: e.subject,
        senderName: e.senderName,
        senderEmail: e.senderEmail,
        receivedTime: e.receivedTime,
        bodyPreview: e.bodyPreview,
        attachmentNames: e.attachmentNames,
    };
}

export async function readInbox(
    account: string,
    folder: string,
    lookbackDays: number,
    limit: number,
): Promise<EmailEnvelope[]> {
    const b = await bridge();
    const emails = await serialize(`Read ${account}${folder ? `\\${folder}` : ' Inbox'}`, () =>
        b.readInboxEmails(account, { folder: folder || undefined, daysBack: lookbackDays, limit }),
    );
    return emails.map((e) => toEnvelope(account, e));
}

/**
 * A trigger's mail, newest first. Reading below a folder walks the whole Inbox
 * tree — where the bridge's search starts — and keeps what sits under `folder`.
 * That walk leaves bodies behind, so these envelopes carry no preview: a poll
 * only needs to know what arrived, and every node that wants a body reads it.
 */
export async function readScope(scope: MailScope, lookbackDays: number, limit: number): Promise<EmailEnvelope[]> {
    const { account, folder } = scope;
    if (!scope.includeSubfolders) return readInbox(account, folder, lookbackDays, limit);
    const b = await bridge();
    const matches = await serialize(`Read ${account}${folder ? `\\${folder}` : ' Inbox'} and below`, () =>
        b.searchInboxByFilter(account, {
            daysBack: lookbackDays,
            excludeFolders: scope.excludeFolders.map((f) => f.trim()).filter(Boolean),
            includeBody: false,
        }),
    );
    const root = folder.trim().toLowerCase();
    return matches
        .filter((m) => {
            const at = underInbox(m.folderPath)?.toLowerCase();
            return at !== undefined && (root === '' || at === root || at.startsWith(`${root}\\`));
        })
        .toSorted((x, y) => y.receivedTime.localeCompare(x.receivedTime))
        .slice(0, limit)
        .map((m) => toEnvelope(account, { ...m, bodyPreview: '' }));
}

/** Letters and digits only, lower-cased: what survives of a subject in a file name or a column of text. */
const squash = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Whether a drop is the email selected in Outlook. Outlook names its `.msg`
 * after the subject — less the characters a file name can't hold, and sometimes
 * shortened — and puts the subject in the text it offers alongside.
 */
function dropNames(subject: string, drag: OutlookDrag, message: string | undefined): boolean {
    const wanted = squash(subject);
    if (message) {
        // A dragged .msg with no subject to compare is still an email out of Outlook.
        if (!wanted) return true;
        const stem = squash(message.replace(/\.msg$/i, ''));
        if (stem.length >= Math.min(wanted.length, 8) && wanted.startsWith(stem)) return true;
    }
    return wanted !== '' && squash(drag.text).includes(wanted);
}

/**
 * The email dragged out of Outlook onto a trigger, found in that trigger's
 * mailbox. A drag carries no id, but Outlook selects an email as the drag
 * starts, so the selection is the dragged email — once the drag's own evidence
 * agrees, which is what stops a file dragged from anywhere else from running
 * whatever Outlook happens to have selected. The mailbox matters as much: a run
 * replies from, and files into, the mailbox its email sits in.
 */
export async function readDragged(account: string, drag: OutlookDrag): Promise<EmailEnvelope> {
    const messages = drag.fileNames.filter((name) => /\.msg$/i.test(name));
    if (messages.length > 1) {
        throw new Error(`That was ${messages.length} emails. Drag one at a time — each one is a run of its own.`);
    }

    const b = await bridge();
    const selected = await serialize('Read the email selected in Outlook', () => b.readSelectedEmail());
    const subject = selected.subject || '(no subject)';

    if (!dropNames(selected.subject, drag, messages[0])) {
        log.warn('outlook', `A drop on a trigger did not match the email selected in Outlook, "${subject}"`, {
            detail: [
                `formats: ${drag.types.join(', ') || '(none)'}`,
                `files: ${drag.fileNames.join(', ') || '(none)'}`,
                `text: ${drag.text.slice(0, 500) || '(none)'}`,
            ].join('\n'),
        });
        throw new Error(
            `That drop doesn't match the email selected in Outlook ("${subject}"). Drag a single email out of Outlook's message list.`,
        );
    }

    const found = await serialize(`Find the dragged email in ${account}`, () =>
        b.locateEmail({
            subject: selected.subject,
            sender: selected.senderEmail,
            receivedTime: selected.receivedTime,
            emailAccount: account,
        }),
    );
    if (!found) {
        throw new Error(
            `"${subject}" from ${selected.senderEmail} isn't in ${account}'s Inbox or the folders under it — the mailbox this trigger watches.`,
        );
    }
    return toEnvelope(account, { ...found, bodyPreview: selected.body.slice(0, 600) });
}

/**
 * The sender's own text. With `includeQuoted` the thread below it comes back
 * too, held to the same cap — what a reply was answering is often the only
 * place the facts it answers live.
 */
export async function readBody(ref: EmailRef, maxChars: number, includeQuoted = false): Promise<EmailBodyResult> {
    const b = await bridge();
    return serialize(`Read a body in ${ref.account}`, () =>
        b.readEmailBody(ref, { maxChars, includeQuoted, maxQuotedChars: maxChars }),
    );
}

export async function saveAttachments(
    ref: EmailRef,
    names: string[],
    destDir: string,
): Promise<SavedAttachment[]> {
    const b = await bridge();
    return serialize(`Save ${names.length} attachment(s)`, () =>
        b.saveEmailAttachments(ref, names, { destDir }),
    );
}

export async function moveEmail(ref: EmailRef, folder: string): Promise<MoveEmailsResult> {
    const b = await bridge();
    return serialize(`Move an email to ${folder}`, () =>
        b.moveOutlookEmails(ref.account, [ref.entryId], folder, { createIfMissing: true }),
    );
}

/**
 * What a reply says: a body written for it, or a template email saved in the
 * mailbox. Where it goes and whether it is sent are not the caller's to choose.
 */
export type DraftContent = Omit<
    ReplyEmailParams,
    'emailAccount' | 'entryId' | 'storeId' | 'sendImmediately' | 'openDraftWindow'
>;

/**
 * Always a draft: `sendImmediately` is hard-wired false, and no code path sets it
 * true. A flow can propose a reply; a person sends it.
 */
export async function draftReply(ref: EmailRef, content: DraftContent): Promise<ReplyEmailResult> {
    const b = await bridge();
    return serialize(`Draft a reply in ${ref.account}`, () =>
        b.replyOutlookEmail({
            ...content,
            emailAccount: ref.account,
            entryId: ref.entryId,
            storeId: ref.storeId,
            sendImmediately: false,
            openDraftWindow: false,
        }),
    );
}
