import type {
    EmailBodyResult,
    InboxEmail,
    InboxFolderInfo,
    MoveEmailsResult,
    ReplyEmailParams,
    ReplyEmailResult,
    SavedAttachment,
    SelectedEmail,
} from '@dawnlit/outlook-bridge';
import { folderLabel, type MailScope, readsFolder, soleFolder } from '@shared/flow';
import type { EmailEnvelope, EmailRef } from '@shared/trace';
import type { InboxFolderOption, OutlookDrag } from '@shared/ipc';
import { log } from '../log';

/**
 * A thin seam over @dawnlit/outlook-bridge, which drives Outlook over COM (each
 * call spawns PowerShell). Imported lazily so the app still starts without Outlook.
 */

type BridgeModule = typeof import('@dawnlit/outlook-bridge');

let mod: BridgeModule | null = null;

async function bridge(): Promise<BridgeModule> {
    mod ??= await import('@dawnlit/outlook-bridge');
    return mod;
}

/**
 * Outlook's COM automation is single-threaded, and a concurrent call just burns
 * its timeout waiting, so every call queues here.
 */
let chain: Promise<unknown> = Promise.resolve();

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Queues a call and times it into the console, reporting queue wait separately from the call itself. */
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

/**
 * The Inbox and every folder below it, depth-first. As deep as the bridge goes,
 * since a trigger can watch a folder at any depth.
 */
export async function listFolders(account: string): Promise<InboxFolderOption[]> {
    const b = await bridge();
    const folders: InboxFolderInfo[] = await serialize(`List folders in ${account}`, () =>
        b.listInboxFolders(account, { maxDepth: 10 }),
    );
    const options: InboxFolderOption[] = [{ folderPath: '', relativePath: '', name: 'Inbox', depth: 0, itemCount: 0 }];
    for (const f of folders) {
        options.push({
            folderPath: f.folderPath,
            relativePath: underInbox(f.folderPath) ?? f.name,
            name: f.name,
            depth: f.depth,
            itemCount: f.itemCount,
        });
    }
    return options;
}

/**
 * A full Outlook path (`\\team@example.com\Inbox\Clients`) relative to the
 * Inbox, as a trigger stores it: '' for the Inbox, null outside it.
 */
function underInbox(folderPath: string): string | null {
    const lower = folderPath.toLowerCase();
    const at = lower.indexOf('\\inbox\\');
    if (at >= 0) return folderPath.slice(at + '\\inbox\\'.length);
    return lower.endsWith('\\inbox') ? '' : null;
}

/** What an envelope is built from — a folder listing's row, a tree search's match, or Outlook's selection. */
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
 * A trigger's mail, newest first. One folder is read on its own; more than one
 * is a search of the Inbox tree kept to those folders, and those envelopes carry
 * no preview.
 */
export async function readScope(scope: MailScope, lookbackDays: number, limit: number): Promise<EmailEnvelope[]> {
    const { account } = scope;
    const sole = soleFolder(scope);
    if (sole !== null) return readInbox(account, sole, lookbackDays, limit);
    if (scope.folders.length === 0) throw new Error(`No folder of ${account} is ticked, so there is nothing to read.`);

    // The bridge knows a folder by its name or its full path, not its path under
    // the Inbox, so the search is narrowed by name and made exact below.
    const names = [...new Set(scope.folders.map((f) => f.slice(f.lastIndexOf('\\') + 1) || 'Inbox'))];
    const b = await bridge();
    const matches = await serialize(`Read ${account} ${folderLabel(scope)}`, () =>
        b.searchInboxByFilter(account, { daysBack: lookbackDays, includeBody: false, includeFolders: names }),
    );
    return matches
        .filter((m) => {
            const at = underInbox(m.folderPath);
            return at !== null && readsFolder(scope, at);
        })
        .toSorted((x, y) => y.receivedTime.localeCompare(x.receivedTime))
        .slice(0, limit)
        .map((m) => toEnvelope(account, { ...m, bodyPreview: '' }));
}

/** Letters and digits only, lower-cased: what survives of a subject in a file name or a column of text. */
const squash = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Whether a drop is the email selected in Outlook, by its `.msg` name (the subject,
 * sanitised and sometimes cut short) or the subject in the drag's text.
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

/** The mailbox a full Outlook path starts with (`\\team@example.com\Inbox` → `team@example.com`), or ''. */
const mailboxOf = (folderPath: string): string => /^\\\\([^\\]+)/.exec(folderPath)?.[1] ?? '';

/**
 * The email dragged out of Outlook onto a trigger. A drag carries no id, so this
 * takes Outlook's current selection, checked against the drag's own file name and
 * text.
 */
export async function readDragged(account: string, drag: OutlookDrag): Promise<EmailEnvelope> {
    const messages = drag.fileNames.filter((name) => /\.msg$/i.test(name));
    if (messages.length > 1) {
        throw new Error(`That was ${messages.length} emails. Drag one at a time — each one is a run of its own.`);
    }

    const selected = await readSelection();
    if (!dropNames(selected.subject, drag, messages[0])) {
        const subject = selected.subject || '(no subject)';
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
    return inMailbox(account, selected);
}

/**
 * The email selected in Outlook, taken without a drag — on a Mac, where Outlook's
 * drag never reaches the page, the only way to hand a trigger one email.
 */
export async function readSelected(account: string): Promise<EmailEnvelope> {
    return inMailbox(account, await readSelection());
}

async function readSelection(): Promise<SelectedEmail> {
    const b = await bridge();
    return serialize('Read the email selected in Outlook', () => b.readSelectedEmail());
}

/**
 * The selected email as a run's envelope. Any folder will do, but only in the
 * trigger's mailbox: a run replies from, and files into, the mailbox its email sits in.
 */
async function inMailbox(account: string, selected: SelectedEmail): Promise<EmailEnvelope> {
    const bodyPreview = selected.body.slice(0, 600);
    if (mailboxOf(selected.folderPath).toLowerCase() === account.toLowerCase()) {
        return toEnvelope(account, { ...selected, bodyPreview });
    }

    // A profile can open a mailbox under a display name rather than its address,
    // so a path naming another mailbox is checked by a search before it is refused.
    const b = await bridge();
    const found = await serialize(`Find the selected email in ${account}`, () =>
        b.locateEmail({
            subject: selected.subject,
            sender: selected.senderEmail,
            receivedTime: selected.receivedTime,
            emailAccount: account,
        }),
    );
    if (!found) {
        const subject = selected.subject || '(no subject)';
        const where = selected.folderPath.replace(/^\\+/, '');
        throw new Error(
            `"${subject}" from ${selected.senderEmail} ${where ? `is in ${where}, not` : "isn't in"} ${account} — the mailbox this trigger watches.`,
        );
    }
    return toEnvelope(account, { ...found, bodyPreview });
}

/**
 * The email an earlier run handled, as a new run's envelope. Its id is tried first;
 * filing the email since rewrites that id, so failing that it is found again by
 * subject, sender and received time in the same mailbox. The body is left to be
 * read afresh, like any other envelope's.
 */
export async function refind(email: EmailEnvelope): Promise<EmailEnvelope> {
    const { ref } = email;
    try {
        await readBody(ref, 1);
        return toEnvelope(ref.account, { ...email, ...ref });
    } catch {
        // Moved, deleted, or Outlook not answering: the search below says which.
    }

    const b = await bridge();
    const found = await serialize(`Find "${email.subject}" again in ${ref.account}`, () =>
        b.locateEmail({
            subject: email.subject,
            sender: email.senderEmail,
            receivedTime: email.receivedTime,
            emailAccount: ref.account,
            folderPath: ref.folderPath,
        }),
    );
    if (!found) {
        throw new Error(
            `"${email.subject || '(no subject)'}" from ${email.senderEmail} is no longer in ${ref.account}'s Inbox or its folders.`,
        );
    }
    return toEnvelope(ref.account, { ...found, bodyPreview: email.bodyPreview });
}

/** The sender's own text, plus the quoted thread below it with `includeQuoted`, each held to `maxChars`. */
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
