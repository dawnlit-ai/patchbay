import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { createSdkMcpServer, type SdkMcpToolDefinition, tool } from '@anthropic-ai/claude-agent-sdk';
import { type EmailEnvelope, emailHeader, now, type TraceEvent } from '@shared/trace';
import type { ProcessorConfig } from '@shared/flow';
import * as outlook from '../outlook/bridge';
import { saveWorkbookAsCsv, WORKBOOK_EXTENSIONS } from './workbook';

/**
 * A step's mailbox tools, bound to this run's one email: none takes an
 * entryId, so a skill cannot reach another message. Anything beyond reading is
 * opt-in per node, and nothing sends mail.
 */

export const EMAIL_SERVER_NAME = 'email';

/** The switches that decide which tools are built. A Processor's config is one. */
export type EmailCapabilities = Pick<
    ProcessorConfig,
    'readEmail' | 'allowSaveAttachments' | 'allowDraftReply' | 'allowMoveEmail'
>;

export interface EmailToolContext {
    email: EmailEnvelope;
    /** Where saved attachments and skill output go for this run. */
    scratchDir: string;
    config: EmailCapabilities;
    /** Side effects worth surfacing in the run summary, in the order they happened. */
    actions: string[];

    onEvent(event: TraceEvent): void;
}

function ok(text: string) {
    return {content: [{type: 'text' as const, text}]};
}

function fail(text: string) {
    return {content: [{type: 'text' as const, text}], isError: true};
}

/**
 * An attachment's name as a path Claude can pass on. Senders' no-break and
 * zero-width spaces survive in Outlook's names, but a path typed back into
 * Read or another tool comes back with a plain space, and the file isn't found.
 */
function typeable(name: string): string {
    return name.normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
}

/** Renames a saved file to its typeable name, numbering it past one already there. */
async function renameTypeable(path: string): Promise<string> {
    const name = basename(path);
    const wanted = typeable(name);
    if (!wanted || wanted === name) return path;
    const ext = extname(wanted);
    const stem = wanted.slice(0, wanted.length - ext.length);
    for (let n = 1; ; n++) {
        const target = join(dirname(path), n === 1 ? wanted : `${stem} (${n})${ext}`);
        if (existsSync(target)) continue;
        await rename(path, target);
        return target;
    }
}

/** A saved attachment's lines in save_attachment's result: a workbook's with the CSVs Read can open. */
async function withCsv(path: string): Promise<string[]> {
    if (!WORKBOOK_EXTENSIONS.includes(extname(path).toLowerCase())) return [path];
    try {
        const {sheets, hidden} = await saveWorkbookAsCsv(path);
        const left = hidden.length > 0 ? [`  hidden, so left out: ${hidden.map((h) => `"${h}"`).join(', ')}`] : [];
        if (sheets.length === 0) return [`${path} — a workbook with no visible sheet to read`, ...left];
        return [
            `${path} — a workbook, which Read cannot open; read ${sheets.length === 1 ? 'it as' : 'its sheets as'}:`,
            ...sheets.map(({
                               sheet,
                               path: csv,
                               rows
                           }) => `  ${csv} (sheet "${sheet}", ${rows} row${rows === 1 ? '' : 's'})`),
            ...left,
        ];
    } catch (e) {
        return [`${path} — a workbook, but no CSV of it could be made: ${e instanceof Error ? e.message : String(e)}`];
    }
}

export function createEmailToolServer(ctx: EmailToolContext) {
    const {email, config} = ctx;

    const log = (label: string, detail?: string): void => {
        ctx.onEvent({at: now(), type: 'outlook', label, detail});
    };

    const readEmail = tool(
        'read_email',
        'Read the email this run is about: its sender, subject, attachment names and the sender\'s own text, with the quoted thread below it left off unless `includeQuoted` asks for it — so a figure from an earlier message is never mistaken for this sender\'s. Also gives the email\'s Outlook reference, for a record that should link back to it. Call this before deciding anything — the preview in the prompt is truncated.',
        {
            maxChars: z.number().int().min(500).max(200_000).optional(),
            includeQuoted: z.boolean().optional(),
        },
        async ({maxChars, includeQuoted}) => {
            const limit = maxChars ?? 50_000;
            const withQuoted = includeQuoted === true;
            const result = await outlook.readBody(email.ref, limit, withQuoted);
            log(
                'read_email',
                `${result.bodyLength} characters${withQuoted ? ` + ${result.quotedLength} quoted` : ''}, ${result.attachmentCount} attachment(s)`,
            );
            const lines = [
                ...emailHeader(result, email.ref.account),
                `Outlook reference: mailbox ${email.ref.account}, folder ${email.ref.folderPath}, entryId ${email.ref.entryId}, storeId ${email.ref.storeId}`,
            ];
            if (result.truncated) lines.push(`(body truncated at ${limit} characters)`);
            lines.push('', result.body);
            if (withQuoted) {
                const cut = result.quotedLength > result.quotedOriginal.length
                    ? ` (first ${result.quotedOriginal.length} of ${result.quotedLength} characters)`
                    : '';
                lines.push(
                    '',
                    `--- Quoted thread${cut} ---`,
                    result.quotedOriginal || '(no quoted thread found below the reply)',
                );
            }
            return ok(lines.join('\n'));
        },
        {annotations: {readOnlyHint: true}},
    );

    // Each tool has its own schema type, so the array is annotated rather than
    // inferred from its first element.
    const tools: SdkMcpToolDefinition<any>[] = [
        // Left out for a node that works from earlier nodes' data alone.
        ...(config.readEmail ? [readEmail] : []),

        tool(
            'record_note',
            'Record a note in this email\'s run trace. Use it to state what you concluded and why, so the decision is readable later without re-running anything.',
            {note: z.string().min(1)},
            async ({note}) => {
                ctx.onEvent({at: now(), type: 'note', label: note.slice(0, 160), detail: note});
                return ok('Noted.');
            },
            {annotations: {readOnlyHint: true}},
        ),

        // The one way a node without file-system access writes anything, so the
        // name is held to a bare file name: no path can lead out of the run folder.
        tool(
            'save_file',
            'Save a text file into this run\'s folder — a report, or anything else worth keeping beside the run — and return its path. Give a bare file name such as "fix-report.md"; saving it again replaces it.',
            {fileName: z.string().min(1).max(120), content: z.string()},
            async ({fileName, content}) => {
                const name = fileName.trim();
                if (!/^[^\\/:*?"<>|\0]+$/.test(name) || name.startsWith('.')) {
                    return fail(`"${fileName}" is not a bare file name. Give one such as "fix-report.md".`);
                }
                await mkdir(ctx.scratchDir, {recursive: true});
                const path = join(ctx.scratchDir, name);
                await writeFile(path, content, 'utf8');
                ctx.actions.push(`saved ${name}`);
                ctx.onEvent({at: now(), type: 'note', label: `Saved ${name}`, detail: `${path}\n\n${content}`});
                return ok(`Saved: ${path}`);
            },
        ),
    ];

    if (config.readEmail && config.allowSaveAttachments) {
        tools.push(
            tool(
                'save_attachment',
                'Save one or more of this email\'s attachments into the run folder and return their paths, so they can be read with the Read tool. A workbook (.xlsx, .xlsm), which Read cannot open, is saved as CSV beside it too, one file per sheet: each cell as the sheet shows it (51%, $1,349.00, dates as YYYY-MM-DD), with line N holding row N and every column in its place, so a figure can be traced to its cell.',
                {fileNames: z.array(z.string().min(1)).min(1)},
                async ({fileNames}) => {
                    const saved = await outlook.saveAttachments(email.ref, fileNames, ctx.scratchDir);
                    if (saved.length === 0) {
                        return fail(
                            `Saved nothing. This email's attachments are: ${email.attachmentNames.join(', ') || '(none)'}`,
                        );
                    }
                    const lines: string[] = [];
                    for (const {path} of saved) lines.push(...(await withCsv(await renameTypeable(path))));
                    ctx.actions.push(`saved ${saved.length} attachment(s)`);
                    log('save_attachment', lines.join('\n'));
                    return ok(`Saved:\n${lines.join('\n')}`);
                },
            ),
        );
    }

    if (config.allowDraftReply) {
        tools.push(
            tool(
                'draft_reply',
                'Leave a reply to this email in Outlook as an UNSENT draft, for a person to review and send. This never sends. Either write the body as real HTML in `htmlBody`, or reply with a template email saved in this mailbox: `templateSubject` names it, `templateSection` keeps one of its [[SECTION]] variants, `templatePlaceholders` fills its {{PLACEHOLDERS}} with HTML, and `signatureName` puts that Outlook signature in its {{SIGNATURE}} (or below the text when it has none). A template the call cannot fill completely fails rather than drafting a half-filled reply.',
                {
                    htmlBody: z.string().min(1).optional(),
                    templateSubject: z.string().min(1).optional(),
                    templateFolder: z.string().min(1).optional(),
                    templateSection: z.string().min(1).optional(),
                    // Not z.record: its `propertyNames` keyword makes the SDK list none of
                    // this server's tools, read_email included, while calling it connected.
                    templatePlaceholders: z.object({}).catchall(z.string()).optional(),
                    signatureName: z.string().min(1).optional(),
                    replyAll: z.boolean().optional(),
                },
                async ({replyAll, ...content}) => {
                    if (!content.htmlBody && !content.templateSubject) {
                        return fail('Give the reply a body: `htmlBody`, or a `templateSubject` to reply with.');
                    }
                    const result = await outlook.draftReply(email.ref, {...content, replyAll: replyAll === true});
                    const from = content.templateSubject
                        ? ` from template ${content.templateSubject}${content.templateSection ? ` [${content.templateSection}]` : ''}`
                        : '';
                    ctx.actions.push(`drafted a reply to ${result.repliedToSender}${from}`);
                    log(
                        `draft_reply → ${result.to}${from}`,
                        content.htmlBody ?? JSON.stringify(content.templatePlaceholders ?? {}, null, 2),
                    );
                    return ok(
                        `Draft saved (not sent). To: ${result.to}; subject: ${result.subject}; original sender: ${result.repliedToSender}`,
                    );
                },
            ),
        );
    }

    if (config.allowMoveEmail) {
        tools.push(
            tool(
                'move_email',
                'File this email into an Inbox subfolder, creating the folder if it does not exist. Give a path relative to the Inbox, e.g. "Processed/Invoices".',
                {folderPath: z.string().min(1)},
                async ({folderPath}) => {
                    const result = await outlook.moveEmail(email.ref, folderPath);
                    if (result.moved === 0) {
                        return fail(`Outlook refused the move: ${result.failed.map((f) => f.error).join('; ')}`);
                    }
                    ctx.actions.push(`moved to ${result.folderPath}`);
                    log(`move_email → ${result.folderPath}`);
                    return ok(`Moved to ${result.folderPath}${result.folderCreated ? ' (folder created)' : ''}`);
                },
            ),
        );
    }

    return createSdkMcpServer({
        name: EMAIL_SERVER_NAME,
        version: '1.0.0',
        instructions:
            'These tools act on exactly one email — the one this run is about. None of them can reach another message, and none of them sends mail.',
        tools,
    });
}

/**
 * The email tools a step can call again without doing anything twice: they read,
 * or write only into the run's own folder. Drafting and moving are not among them.
 */
export const REPEATABLE_EMAIL_TOOLS = ['read_email', 'record_note', 'save_file', 'save_attachment'].map(
    (n) => `mcp__${EMAIL_SERVER_NAME}__${n}`,
);

/** The allowlist entries matching the tools built above, for `dontAsk` mode. */
export function emailToolNames(config: EmailCapabilities): string[] {
    const names = ['record_note', 'save_file'];
    if (config.readEmail) names.push('read_email');
    if (config.readEmail && config.allowSaveAttachments) names.push('save_attachment');
    if (config.allowDraftReply) names.push('draft_reply');
    if (config.allowMoveEmail) names.push('move_email');
    return names.map((n) => `mcp__${EMAIL_SERVER_NAME}__${n}`);
}
