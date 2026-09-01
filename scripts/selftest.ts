/**
 * End-to-end smoke test, run under Electron so the real paths, stores and
 * Outlook bridge are exercised rather than stubbed.
 *
 * Takes the most recent email in the first Outlook account, pushes it through a
 * throwaway trigger → categorizer → terminal flow, and prints the trace. It
 * classifies (one Claude call, a cent or two) and reads a body; it never writes
 * to the mailbox.
 *
 *   npm run selftest
 */
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Flow } from '../src/shared/flow';
import { defaultConfig } from '../src/shared/flow';
import { executeRun } from '../src/main/engine/engine';
import * as outlook from '../src/main/outlook/bridge';
import { workspaceRoot } from '../src/main/paths';

function buildFlow(account: string): Flow {
    const categorizer = defaultConfig('categorizer');
    if (categorizer.kind !== 'categorizer') throw new Error('unreachable');
    categorizer.categories = [
        {
            id: 'business',
            label: 'Business',
            description:
                'A message from a person or company about actual work: a request, a quote, a shipment, an invoice, a question that expects an answer.',
        },
        {
            id: 'bulk',
            label: 'Bulk',
            description:
                'Newsletters, marketing, automated notifications, receipts and anything else nobody is waiting on a reply to.',
        },
    ];

    const trigger = defaultConfig('trigger.outlook');
    if (trigger.kind !== 'trigger.outlook') throw new Error('unreachable');
    trigger.account = account;

    const doneTerminal = defaultConfig('terminal');
    const reviewTerminal = defaultConfig('terminal');
    if (reviewTerminal.kind === 'terminal') reviewTerminal.disposition = 'needs-review';

    return {
        id: 'selftest',
        name: 'Self test',
        updatedAt: new Date().toISOString(),
        nodes: [
            { id: 'trigger', kind: 'trigger.outlook', name: 'Inbox', position: { x: 0, y: 0 }, config: trigger },
            { id: 'cat', kind: 'categorizer', name: 'Sort', position: { x: 300, y: 0 }, config: categorizer },
            {
                id: 'end-ok',
                kind: 'terminal',
                name: 'Business done',
                position: { x: 620, y: -60 },
                config: doneTerminal
            },
            {
                id: 'end-bulk',
                kind: 'terminal',
                name: 'Bulk parked',
                position: { x: 620, y: 80 },
                config: reviewTerminal
            },
        ],
        edges: [
            { id: 'e1', source: 'trigger', sourceHandle: 'out', target: 'cat' },
            { id: 'e2', source: 'cat', sourceHandle: 'cat:business', target: 'end-ok' },
            { id: 'e3', source: 'cat', sourceHandle: 'cat:bulk', target: 'end-bulk' },
            // "unmatched" is deliberately left unconnected, so a run that lands there
            // proves the engine reports a dead end instead of stalling.
        ],
    };
}

async function main(): Promise<void> {
    console.log('workspace:', workspaceRoot());

    const accounts = await outlook.getAccounts();
    console.log('accounts:', accounts);
    const account = accounts[0];
    if (!account) throw new Error('No Outlook accounts found.');

    const emails = await outlook.readInbox(account, '', 7, 1);
    const email = emails[0];
    if (!email) throw new Error('No email in the last 7 days to test with.');
    console.log(`\nemail: "${email.subject}" from ${email.senderEmail}\n`);

    const run = await executeRun({
        runId: randomUUID(),
        flow: buildFlow(account),
        startNodeId: 'trigger',
        email,
        trigger: 'manual',
        signal: new AbortController().signal,
        onUpdate: () => {
        },
    });

    console.log('─'.repeat(70));
    console.log(`status      : ${run.status}`);
    console.log(`path        : ${run.path.join(' → ')}`);
    console.log(`edges taken : ${run.edgePath.join(', ') || '(none)'}`);
    console.log(`disposition : ${run.disposition ?? '(none)'}`);
    console.log(`cost        : $${run.totalCostUsd.toFixed(4)}`);
    if (run.error) console.log(`note        : ${run.error}`);
    console.log('─'.repeat(70));
    for (const pass of run.passes) {
        console.log(`#${pass.seq} ${pass.nodeName} [${pass.status}] → ${pass.outPort ?? 'end'}`);
        console.log(`    ${pass.summary}`);
        console.log(`    ${pass.events.length} event(s): ${pass.events.map((e) => e.type).join(', ') || '—'}`);
    }
    console.log('─'.repeat(70));

    const failed = run.status !== 'completed' || run.passes.some((p) => p.status === 'error');
    console.log(failed ? 'SELFTEST FAILED' : 'SELFTEST OK');
    app.exit(failed ? 1 : 0);
}

void app.whenReady().then(() =>
    main().catch((e: unknown) => {
        console.error('SELFTEST FAILED:', e instanceof Error ? e.stack : e);
        app.exit(1);
    }),
);
