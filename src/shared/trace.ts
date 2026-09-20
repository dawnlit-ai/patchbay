/**
 * The run record: one Run per email, one Pass per node it visited, and inside a
 * pass the events explaining why it left by the port it did. Plain JSON on disk,
 * so a run is still readable in a text editor months later.
 */

import type { NodeKind } from './flow';

/** Enough of an Outlook message to find it again and to show it in a list. */
export interface EmailRef {
    entryId: string;
    storeId: string;
    account: string;
    folderPath: string;
}

export interface EmailEnvelope {
    ref: EmailRef;
    subject: string;
    senderName: string;
    senderEmail: string;
    receivedTime: string;
    bodyPreview: string;
    attachmentNames: string[];
    /** Filled in lazily, the first time a node asks for the full body. */
    body?: string;
}

/** The moment a record is stamped with. One spelling, everywhere it happens. */
export const now = (): string => new Date().toISOString();

/**
 * A long detail, cut down with a note of how much is not shown. A prompt or a
 * tool payload can run to megabytes, and neither the trace file nor the agent
 * reading it back wants the whole of one.
 */
export function truncate(value: string, max = 4_000): string {
    return value.length <= max ? value : `${value.slice(0, max)}\n… (${value.length - max} more characters)`;
}

/**
 * The lines that introduce an email wherever the app writes one out — the prompt
 * a node builds around it, and the result `read_email` hands back.
 */
export function emailHeader(email: {
    senderName: string;
    senderEmail: string;
    subject: string;
    receivedTime: string;
    attachmentNames: string[];
}): string[] {
    return [
        `From: ${email.senderName} <${email.senderEmail}>`,
        `Subject: ${email.subject}`,
        `Received: ${email.receivedTime}`,
        `Attachments: ${email.attachmentNames.join(', ') || '(none)'}`,
    ];
}

export type TraceEventType =
    | 'note'
    | 'prompt'
    | 'assistant'
    | 'thinking'
    | 'tool-call'
    | 'tool-result'
    | 'outlook'
    | 'error';

export interface TraceEvent {
    at: string;
    type: TraceEventType;
    label: string;
    /** Long-form payload, shown when the event is expanded. */
    detail?: string;
}

export interface PassCost {
    usd: number;
    turns: number;
    model: string;
    durationMs: number;
}

export type PassStatus = 'ok' | 'error';

export interface Pass {
    seq: number;
    nodeId: string;
    nodeKind: NodeKind;
    nodeName: string;
    startedAt: string;
    endedAt: string;
    status: PassStatus;
    /** The output port taken. This, across passes, is the path through the flow. */
    outPort: string | null;
    /** One line a human can scan: why this node did what it did. */
    summary: string;
    events: TraceEvent[];
    cost?: PassCost;
    error?: string;
}

export type RunStatus = 'running' | 'completed' | 'failed';

export interface Run {
    id: string;
    flowId: string;
    flowName: string;
    startedAt: string;
    endedAt?: string;
    status: RunStatus;
    /** How the run was started, so a manual test is never mistaken for a poll. */
    trigger: 'poll' | 'manual';
    email: EmailEnvelope;
    /** Node ids in visit order: the path this email took, as one line. */
    path: string[];
    /** Edge ids traversed, so the canvas can light the exact connections used. */
    edgePath: string[];
    passes: Pass[];
    totalCostUsd: number;
    /** Terminal disposition, when the run reached a terminal node. */
    disposition?: string;
    error?: string;
}

/** The one-line form kept in the run index, so the list loads without every pass. */
export interface RunSummary {
    id: string;
    flowId: string;
    flowName: string;
    startedAt: string;
    endedAt?: string;
    status: RunStatus;
    trigger: 'poll' | 'manual';
    subject: string;
    senderEmail: string;
    disposition?: string;
    totalCostUsd: number;
    passCount: number;
}

export function toSummary(run: Run): RunSummary {
    return {
        id: run.id,
        flowId: run.flowId,
        flowName: run.flowName,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        status: run.status,
        trigger: run.trigger,
        subject: run.email.subject,
        senderEmail: run.email.senderEmail,
        disposition: run.disposition,
        totalCostUsd: run.totalCostUsd,
        passCount: run.passes.length,
    };
}
