import { z } from 'zod';
import { createSdkMcpServer, type SdkMcpToolDefinition, tool } from '@anthropic-ai/claude-agent-sdk';
import { type EmailEnvelope, emailHeader, now, type TraceEvent } from '@shared/trace';
import type { ProcessorConfig } from '@shared/flow';
import * as outlook from '../outlook/bridge';

/**
 * The mailbox surface a Processor gets: an in-process MCP server whose tools are
 * bound to the one email this run is about. No tool here takes an entryId, so a
 * skill cannot wander into another message however it is prompted, and every
 * call lands in the pass trace. Anything beyond reading is opt-in per node, and
 * none of it sends mail.
 */

export const EMAIL_SERVER_NAME = 'email';

export interface EmailToolContext {
    email: EmailEnvelope;
    /** Where saved attachments and skill output go for this run. */
    scratchDir: string;
    config: ProcessorConfig;
    /** Side effects worth surfacing in the run summary, in the order they happened. */
    actions: string[];

    onEvent(event: TraceEvent): void;
}

function ok(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}

function fail(text: string) {
    return { content: [{ type: 'text' as const, text }], isError: true };
}

export function createEmailToolServer(ctx: EmailToolContext) {
    const { email, config } = ctx;

    const log = (label: string, detail?: string): void => {
        ctx.onEvent({ at: now(), type: 'outlook', label, detail });
    };

    // Each tool has its own schema type, so the array is annotated rather than
    // inferred from its first element.
    const tools: SdkMcpToolDefinition<any>[] = [
        tool(
            'read_email',
            'Read the email this run is about: its sender, subject, attachment names and the sender\'s own text, with the quoted thread below it left off unless `includeQuoted` asks for it — so a figure from an earlier message is never mistaken for this sender\'s. Also gives the email\'s Outlook reference, for a record that should link back to it. Call this before deciding anything — the preview in the prompt is truncated.',
            {
                maxChars: z.number().int().min(500).max(200_000).optional(),
                includeQuoted: z.boolean().optional(),
            },
            async ({ maxChars, includeQuoted }) => {
                const limit = maxChars ?? 50_000;
                const withQuoted = includeQuoted === true;
                const result = await outlook.readBody(email.ref, limit, withQuoted);
                log(
                    'read_email',
                    `${result.bodyLength} characters${withQuoted ? ` + ${result.quotedLength} quoted` : ''}, ${result.attachmentCount} attachment(s)`,
                );
                const lines = [
                    ...emailHeader(result),
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
            { annotations: { readOnlyHint: true } },
        ),

        tool(
            'record_note',
            'Record a note in this email\'s run trace. Use it to state what you concluded and why, so the decision is readable later without re-running anything.',
            { note: z.string().min(1) },
            async ({ note }) => {
                ctx.onEvent({ at: now(), type: 'note', label: note.slice(0, 160), detail: note });
                return ok('Noted.');
            },
            { annotations: { readOnlyHint: true } },
        ),
    ];

    if (config.allowSaveAttachments) {
        tools.push(
            tool(
                'save_attachment',
                'Save one or more of this email\'s attachments into the run folder and return their paths, so they can be read with the Read tool.',
                { fileNames: z.array(z.string().min(1)).min(1) },
                async ({ fileNames }) => {
                    const saved = await outlook.saveAttachments(email.ref, fileNames, ctx.scratchDir);
                    if (saved.length === 0) {
                        return fail(
                            `Saved nothing. This email's attachments are: ${email.attachmentNames.join(', ') || '(none)'}`,
                        );
                    }
                    const paths = saved.map((s) => s.path);
                    ctx.actions.push(`saved ${paths.length} attachment(s)`);
                    log('save_attachment', paths.join('\n'));
                    return ok(`Saved:\n${paths.join('\n')}`);
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
                    templatePlaceholders: z.record(z.string(), z.string()).optional(),
                    signatureName: z.string().min(1).optional(),
                    replyAll: z.boolean().optional(),
                },
                async ({ replyAll, ...content }) => {
                    if (!content.htmlBody && !content.templateSubject) {
                        return fail('Give the reply a body: `htmlBody`, or a `templateSubject` to reply with.');
                    }
                    const result = await outlook.draftReply(email.ref, { ...content, replyAll: replyAll === true });
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
                'File this email into an Inbox subfolder, creating the folder if it does not exist. Give a path relative to the Inbox, e.g. "Processed/Pre-Alerts".',
                { folderPath: z.string().min(1) },
                async ({ folderPath }) => {
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

/** The allowlist entries matching the tools built above, for `dontAsk` mode. */
export function emailToolNames(config: ProcessorConfig): string[] {
    const names = ['read_email', 'record_note'];
    if (config.allowSaveAttachments) names.push('save_attachment');
    if (config.allowDraftReply) names.push('draft_reply');
    if (config.allowMoveEmail) names.push('move_email');
    return names.map((n) => `mcp__${EMAIL_SERVER_NAME}__${n}`);
}
