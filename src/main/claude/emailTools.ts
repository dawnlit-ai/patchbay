import { z } from 'zod';
import { createSdkMcpServer, type SdkMcpToolDefinition, tool } from '@anthropic-ai/claude-agent-sdk';
import type { EmailEnvelope, TraceEvent } from '@shared/trace';
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

const now = (): string => new Date().toISOString();

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
            'Read the full body of the email this run is about, plus its sender, subject and attachment names. Call this before deciding anything — the preview in the prompt is truncated.',
            { maxChars: z.number().int().min(500).max(200_000).optional() },
            async ({ maxChars }) => {
                const result = await outlook.readBody(email.ref, maxChars ?? 50_000);
                log('read_email', `${result.bodyLength} characters, ${result.attachmentCount} attachment(s)`);
                return ok(
                    [
                        `From: ${result.senderName} <${result.senderEmail}>`,
                        `Subject: ${result.subject}`,
                        `Received: ${result.receivedTime}`,
                        `Attachments: ${result.attachmentNames.join(', ') || '(none)'}`,
                        result.truncated ? `(body truncated at ${maxChars ?? 50_000} characters)` : '',
                        '',
                        result.body,
                    ]
                        .filter(Boolean)
                        .join('\n'),
                );
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
                'Leave a reply to this email in Outlook as an UNSENT draft, for a person to review and send. This never sends. Write real HTML for the body.',
                {
                    htmlBody: z.string().min(1),
                    replyAll: z.boolean().optional(),
                },
                async ({ htmlBody, replyAll }) => {
                    const result = await outlook.draftReply(email.ref, htmlBody, replyAll === true);
                    ctx.actions.push(`drafted a reply to ${result.repliedToSender}`);
                    log(`draft_reply → ${result.to}`, htmlBody);
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
