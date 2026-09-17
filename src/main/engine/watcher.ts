import { randomUUID } from 'node:crypto';
import { watermarkFile } from '../paths';
import { readJson, writeJson } from '../store/jsonFile';
import { getFlow, listFlows } from '../store/flowStore';
import { getSettings } from '../store/settingsStore';
import { findTriggers, type Flow, type FlowNode, triggerConfig, type TriggerConfig } from '@shared/flow';
import type { EmailEnvelope, Run } from '@shared/trace';
import type { EngineStatus } from '@shared/settings';
import * as outlook from '../outlook/bridge';
import { executeRun } from './engine';
import { log } from '../log';

/**
 * Turns "an email arrived" into "a run happened". The bridge offers no push
 * notification, so arrival means polling and remembering the message ids already
 * seen. Runs execute one at a time — an agent run takes minutes and drives the
 * same Outlook client the user is reading mail in.
 */

interface Watermark {
    /** Message ids already handled, newest last. Bounded so the file stays small. */
    seen: string[];
    /** False until the first poll has established a baseline for this trigger. */
    primed: boolean;
}

/** Keyed per trigger, not per flow: two triggers watch two folders separately. */
type Watermarks = Record<string, Watermark>;

const markKey = (flowId: string, nodeId: string): string => `${flowId}:${nodeId}`;

const SEEN_LIMIT = 500;

/** How a trigger is named in the console: which flow, which node. */
const where = (flow: Flow, node: FlowNode): string => `${flow.name} / ${node.name}`;

/** One trigger node, with the flow it belongs to and its config already narrowed. */
interface WatchedTrigger {
    flow: Flow;
    node: FlowNode;
    config: TriggerConfig;
}

interface QueueItem {
    /**
     * Minted here rather than at execution, so whoever queued the run has its id
     * before it starts — enough to cancel it, or to ask for its trace.
     */
    runId: string;
    flow: Flow;
    /** The trigger the email arrived at, and where its run starts. */
    startNodeId: string;
    email: EmailEnvelope;
    trigger: 'poll' | 'manual';
}

export class Watcher {
    private timer: NodeJS.Timeout | null = null;
    private queue: QueueItem[] = [];
    private draining = false;
    private polling = false;
    private active = new Map<string, AbortController>();
    private lastPollAt?: string;
    private lastError?: string;
    private lastPollPerTrigger = new Map<string, number>();

    // ── Lifecycle ──────────────────────────────────────────────────────────

    constructor(
        private readonly onRun: (run: Run) => void,
        private readonly onStatus: () => void,
    ) {
    }

    start(): EngineStatus {
        if (this.timer) return this.status();
        if (!getSettings().pollingEnabled) {
            this.lastError = 'Polling is switched off in Settings.';
            log.warn('watcher', `Not watching: ${this.lastError}`);
            this.onStatus();
            return this.status();
        }
        this.lastError = undefined;
        // A fixed tick; each trigger's own pollSeconds decides when its turn comes.
        this.timer = setInterval(() => void this.poll(), 15_000);
        const triggers = this.triggers();
        const idle = triggers.filter((t) => t.config.account.trim() === '');
        log.info('watcher', `Started watching ${triggers.length - idle.length} mailbox(es)`);
        for (const { flow, node } of idle) {
            log.warn('watcher', `${where(flow, node)} names no mailbox, so it is not polled`);
        }
        void this.poll();
        this.onStatus();
        return this.status();
    }

    stop(): EngineStatus {
        if (this.timer) {
            clearInterval(this.timer);
            log.info('watcher', 'Stopped watching');
        }
        this.timer = null;
        // A polled email was marked seen when it was queued, so one dropped here is
        // never picked up again. Worth a line each: only a test run brings it back.
        for (const item of this.queue) {
            log.warn('watcher', `Dropped from the queue, not run: "${item.email.subject}"`, {
                detail: `${item.flow.name} · from ${item.email.senderEmail} · received ${item.email.receivedTime}`,
            });
        }
        this.queue = [];
        this.onStatus();
        return this.status();
    }

    status(): EngineStatus {
        const watching = this.watchedTriggers().map(({ flow, node, config }) => ({
            flowId: flow.id,
            flowName: flow.name,
            nodeId: node.id,
            nodeName: node.name,
            account: config.account,
            folder: config.folder,
        }));
        return {
            running: this.timer !== null,
            watching,
            lastPollAt: this.lastPollAt,
            lastError: this.lastError,
            activeRunIds: [...this.active.keys()],
        };
    }

    cancel(runId: string): void {
        this.active.get(runId)?.abort();
    }

    // ── Polling ────────────────────────────────────────────────────────────

    /**
     * Run a flow against a chosen email now, bypassing the watermark entirely.
     * The trigger is named rather than looked up: which one a test starts from is
     * the user's choice once a flow has more than one. Returns the id the run
     * will have, which is what an agent asking for one needs to follow it.
     */
    enqueueManual(flowId: string, nodeId: string, email: EmailEnvelope): string {
        const flow = getFlow(flowId);
        if (!flow) throw new Error(`No flow ${flowId}`);
        const node = flow.nodes.find((n) => n.id === nodeId);
        if (!triggerConfig(node)) throw new Error(`No trigger ${nodeId} in ${flow.name}`);
        const runId = randomUUID();
        this.queue.push({ runId, flow, startNodeId: nodeId, email, trigger: 'manual' });
        void this.drain();
        return runId;
    }

    /** Every trigger in the library, whether or not it names a mailbox yet. */
    private triggers(): WatchedTrigger[] {
        return listFlows().flatMap((flow) =>
            findTriggers(flow).flatMap((node) => {
                const config = triggerConfig(node);
                return config ? [{ flow, node, config }] : [];
            }),
        );
    }

    /** Those a poll can actually read. A trigger with no account yet is left alone. */
    private watchedTriggers(): WatchedTrigger[] {
        return this.triggers().filter((t) => t.config.account.trim() !== '');
    }

    private async poll(): Promise<void> {
        if (this.polling) return;
        this.polling = true;
        try {
            const marks = readJson<Watermarks>(watermarkFile(), {});
            let changed = false;

            const triggers = this.triggers();

            // A trigger the user has since deleted leaves its mark behind; dropped
            // here so the file tracks the canvas rather than growing with every edit.
            const live = new Set(triggers.map((t) => markKey(t.flow.id, t.node.id)));
            for (const key of Object.keys(marks)) {
                if (live.has(key)) continue;
                delete marks[key];
                changed = true;
            }

            for (const { flow, node, config } of triggers) {
                if (config.account.trim() === '') continue;
                const key = markKey(flow.id, node.id);

                const due = (this.lastPollPerTrigger.get(key) ?? 0) + config.pollSeconds * 1000;
                if (Date.now() < due) continue;
                this.lastPollPerTrigger.set(key, Date.now());

                let emails: EmailEnvelope[];
                try {
                    emails = await outlook.readInbox(
                        config.account,
                        config.folder,
                        config.lookbackDays,
                        config.maxPerPoll,
                    );
                    this.lastError = undefined;
                } catch (e) {
                    this.lastError = `${where(flow, node)}: ${e instanceof Error ? e.message : String(e)}`;
                    log.error('watcher', `Poll failed at ${this.lastError}`);
                    continue;
                }

                const mark: Watermark = marks[key] ?? { seen: [], primed: false };
                const seen = new Set(mark.seen);

                // The first poll establishes a baseline; without it, switching a flow
                // on would fire a run for every email already in the folder.
                if (!mark.primed && !config.processBacklogOnStart) {
                    mark.seen = emails.map((e) => e.ref.entryId).slice(-SEEN_LIMIT);
                    mark.primed = true;
                    marks[key] = mark;
                    changed = true;
                    // The one poll that sees mail and starts nothing, on purpose — and
                    // the first place to look when an email already there never ran.
                    log.info(
                        'watcher',
                        `${where(flow, node)}: first look, so the ${emails.length} email(s) already there are marked seen and not run`,
                        { detail: emails.map((e) => `${e.receivedTime}  ${e.subject}`).join('\n') || undefined },
                    );
                    continue;
                }

                // Oldest first, so a backlog is processed in the order it arrived.
                const fresh = emails.filter((e) => !seen.has(e.ref.entryId)).toReversed();
                if (fresh.length === 0) {
                    log.debug('watcher', `${where(flow, node)}: nothing new in ${emails.length} email(s)`);
                } else if (fresh.length >= config.maxPerPoll) {
                    // A poll reads only the newest few. When every one of them is new,
                    // older mail may have arrived behind them, where no later poll looks.
                    log.warn(
                        'watcher',
                        `${where(flow, node)}: all ${fresh.length} email(s) read were new, so more may have arrived than one poll takes. Raise Max / poll, or poll more often.`,
                    );
                }
                for (const email of fresh) {
                    log.info('watcher', `${where(flow, node)}: new email "${email.subject}" from ${email.senderEmail}`);
                    mark.seen.push(email.ref.entryId);
                    this.queue.push({
                        runId: randomUUID(),
                        flow,
                        startNodeId: node.id,
                        email,
                        trigger: 'poll',
                    });
                }
                if (fresh.length > 0) {
                    mark.seen = mark.seen.slice(-SEEN_LIMIT);
                    changed = true;
                }
                mark.primed = true;
                marks[key] = mark;
            }

            // Persisted before the runs execute: a crash mid-run must not reprocess
            // the same email on the next launch.
            if (changed) writeJson(watermarkFile(), marks);
            this.lastPollAt = new Date().toISOString();
            this.onStatus();
            void this.drain();
        } finally {
            this.polling = false;
        }
    }

    // ── Execution ──────────────────────────────────────────────────────────

    private async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.queue.length > 0) {
                const item = this.queue.shift();
                if (!item) break;
                // The id came with the item, so `cancel` can find the controller from
                // the moment the run starts — and whoever queued it already has it.
                const runId = item.runId;
                const controller = new AbortController();
                this.active.set(runId, controller);
                this.onStatus();
                const subject = `"${item.email.subject || '(no subject)'}"`;
                const test = item.trigger === 'manual' ? ' (test)' : '';
                log.info('run', `Started ${subject} in ${item.flow.name}${test}`, { runId });
                try {
                    const run = await executeRun({
                        runId,
                        flow: item.flow,
                        startNodeId: item.startNodeId,
                        email: item.email,
                        trigger: item.trigger,
                        signal: controller.signal,
                        onUpdate: (update) => this.onRun(update),
                    });
                    const tally = `${run.passes.length} pass(es) · $${run.totalCostUsd.toFixed(3)}`;
                    if (run.status === 'failed') {
                        log.error('run', `Failed ${subject}: ${run.error ?? 'no reason recorded'}`, {
                            runId,
                            detail: tally,
                        });
                    } else {
                        // A path that ran off an unconnected port still completes, and
                        // says so in `error`; that sentence is worth keeping here too.
                        log.info('run', `Finished ${subject}: ${run.disposition ?? 'completed'} · ${tally}`, {
                            runId,
                            detail: run.error,
                        });
                    }
                } catch (e) {
                    this.lastError = e instanceof Error ? e.message : String(e);
                    log.error('run', `${subject} could not run: ${this.lastError}`, { runId });
                } finally {
                    this.active.delete(runId);
                    this.onStatus();
                }
            }
        } finally {
            this.draining = false;
        }
    }
}
