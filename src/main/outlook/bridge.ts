import type {
    EmailBodyResult,
    InboxEmail,
    InboxFolderInfo,
    MoveEmailsResult,
    ReplyEmailResult,
    SavedAttachment,
} from '@dawnlit/outlook-bridge';
import type { EmailEnvelope, EmailRef } from '@shared/trace';
import type { InboxFolderOption } from '@shared/ipc';

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

function serialize<T>(work: () => Promise<T>): Promise<T> {
    // Each link swallows its predecessor's rejection, so one failed call does not
    // poison the queue behind it.
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
}

export async function getAccounts(): Promise<string[]> {
    return serialize(async () => (await bridge()).getOutlookAccounts());
}

export async function listFolders(account: string): Promise<InboxFolderOption[]> {
    const b = await bridge();
    const folders: InboxFolderInfo[] = await serialize(() => b.listInboxFolders(account));
    const options: InboxFolderOption[] = [
        { folderPath: '', relativePath: '', name: 'Inbox (all)', depth: 0, itemCount: 0 },
    ];
    for (const f of folders) {
        // A trigger stores the path relative to the Inbox — what readInboxEmails
        // takes as its `folder` argument.
        const idx = f.folderPath.toLowerCase().lastIndexOf('\\inbox\\');
        const relative = idx >= 0 ? f.folderPath.slice(idx + '\\inbox\\'.length) : f.name;
        options.push({
            folderPath: f.folderPath,
            relativePath: relative,
            name: `${'— '.repeat(Math.max(0, f.depth - 1))}${f.name}`,
            depth: f.depth,
            itemCount: f.itemCount,
        });
    }
    return options;
}

function toEnvelope(account: string, e: InboxEmail): EmailEnvelope {
    const ref: EmailRef = {
        entryId: e.entryId,
        storeId: e.storeId,
        account,
        folderPath: e.folderPath ?? '',
    };
    return {
        ref,
        subject: e.subject,
        senderName: e.senderName,
        senderEmail: e.senderEmail,
        receivedTime: e.receivedTime,
        bodyPreview: e.bodyPreview,
        attachmentNames: e.attachmentNames ?? [],
    };
}

export async function readInbox(
    account: string,
    folder: string,
    lookbackDays: number,
    limit: number,
): Promise<EmailEnvelope[]> {
    const b = await bridge();
    const emails = await serialize(() =>
        b.readInboxEmails(account, lookbackDays, limit, folder || undefined),
    );
    return emails.map((e) => toEnvelope(account, e));
}

export async function readBody(ref: EmailRef, maxChars: number): Promise<EmailBodyResult> {
    const b = await bridge();
    return serialize(() => b.readEmailBody(ref.entryId, ref.storeId, maxChars, false));
}

export async function saveAttachments(
    ref: EmailRef,
    names: string[],
    destDir: string,
): Promise<SavedAttachment[]> {
    const b = await bridge();
    return serialize(() => b.saveEmailAttachments(ref.entryId, names, ref.storeId, destDir));
}

export async function moveEmail(ref: EmailRef, folder: string): Promise<MoveEmailsResult> {
    const b = await bridge();
    return serialize(() => b.moveOutlookEmails(ref.account, [ref.entryId], folder, true));
}

/**
 * Always a draft: `sendImmediately` is hard-wired false, and no code path sets it
 * true. A flow can propose a reply; a person sends it.
 */
export async function draftReply(
    ref: EmailRef,
    htmlBody: string,
    replyAll: boolean,
): Promise<ReplyEmailResult> {
    const b = await bridge();
    return serialize(() =>
        b.replyOutlookEmail({
            emailAccount: ref.account,
            entryId: ref.entryId,
            storeId: ref.storeId,
            htmlBody,
            replyAll,
            sendImmediately: false,
            openDraftWindow: false,
        }),
    );
}
