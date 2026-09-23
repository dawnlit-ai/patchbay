import { randomUUID } from 'node:crypto';
import { watermarkFile } from '../paths';
import { readJson, writeJson } from '../store/jsonFile';
import { getFlow, listFlows } from '../store/flowStore';
import { getSettings } from '../store/settingsStore';
import { findTriggers, type Flow, type FlowNode, triggerConfig, type TriggerConfig } from '@shared/flow';
import type { EmailEnvelope, Run } from '@shared/trace';
import { CONCURRENT_RUNS_RANGE, type EngineStatus } from '@shared/settings';
import * as outlook from '../outlook/bridge';
import { executeRun } from './engine';
import { log } from '../log';

/**
 * Turns "an email arrived" into "a run happened". The bridge offers no push
 * notification, so arrival means polling and remembering the message ids already
 * seen. Several runs execute at once, up to the cap in Settings, but never two of
 * one flow: a flow's directory is the working directory of every run of it, and
 * its mail is handled in the order it arrived.
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

/** A run under way: what stops it, and the flow whose turn it holds. */
interface ActiveRun {
    controller: AbortController;
    flowId: string;
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

/** A run that has an id but no trace yet, and what it is waiting for. */
export interface QueuedRun {
    runId: string;
    flowId: string;
    flowName: string;
    trigger: 'poll' | 'manual';
    email: EmailEnvelope;
    /** 1 is next, among those whose flow is free. */
    position: number;
    waitingFor: string;
}

/**
 * What asking to cancel did: stopped a run under way, took one out of the queue
 * before it started, or found neither — most likely because it already finished.
 */
export type CancelOutcome = 'stopping' | 'dequeued' | 'unknown';

export class Watcher {
    private timer: NodeJS.Timeout | null = null;
    private queue: QueueItem[] = [];
    private polling = false;
    private active = new Map<string, ActiveRun>();
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
            queuedRunIds: this.queue.map((item) => item.runId),
        };
    }

    /**
     * What is waiting, in queue order, and why none of it is under way yet. A run
     * has an id from the moment it is queued but no trace until it starts, and
     * whoever holds the id is owed an answer in between.
     */
    queued(): QueuedRun[] {
        const busy = new Set(this.active.values().map((run) => run.flowId));
        return this.queue.map((item, index) => {
            const behindItsFlow =
                busy.has(item.flow.id) || this.queue.slice(0, index).some((ahead) => ahead.flow.id === item.flow.id);
            return {
                runId: item.runId,
                flowId: item.flow.id,
                flowName: item.flow.name,
                trigger: item.trigger,
                email: item.email,
                position: index + 1,
                waitingFor: behindItsFlow
                    ? 'another run of this flow to finish'
                    : `a free slot: ${this.active.size} of ${this.limit()} runs are under way`,
            };
        });
    }

    /**
     * Stop a run under way, or take one out of the queue before it starts. The
     * second matters as much as the first: a run's id is handed out when it is
     * queued, so it can be cancelled before there is anything to abort.
     */
    cancel(runId: string): CancelOutcome {
        const active = this.active.get(runId);
        if (active) {
            active.controller.abort();
            return 'stopping';
        }
        const index = this.queue.findIndex((item) => item.runId === runId);
        const item = this.queue[index];
        if (!item) return 'unknown';
        this.queue.splice(index, 1);
        // As with Stop: a polled email was marked seen when it was queued, so this
        // one is never picked up again. A test run is only undone.
        const subject = `"${item.email.subject || '(no subject)'}"`;
        const detail = `${item.flow.name} · from ${item.email.senderEmail} · received ${item.email.receivedTime}`;
        if (item.trigger === 'poll') log.warn('watcher', `Cancelled before it started, not run: ${subject}`, { detail });
        else log.info('run', `Cancelled before it started: ${subject} (test)`, { detail });
        this.onStatus();
        return 'dequeued';
    }

    /**
     * Whether a run of this flow is under way. Its directory is the working
     * directory of that run, so whoever wants to move one asks first.
     */
    isFlowRunning(flowId: string): boolean {
        return this.active.values().some((run) => run.flowId === flowId);
    }

    /**
     * Clear the way for a flow to be deleted. Refused while a run of it is under
     * way, since its directory is that run's working directory; runs of it still
     * queued are cancelled, since each would start on a flow that is gone.
     * Returns how many were.
     */
    clearForRemoval(flowId: string): number {
        if (this.isFlowRunning(flowId)) {
            throw new Error(
                'A run of this flow is in progress. Its folder is the directory that run works in, so the flow cannot be deleted until the run finishes or is cancelled.',
            );
        }
        const queued = this.queue.filter((item) => item.flow.id === flowId);
        for (const item of queued) this.cancel(item.runId);
        return queued.length;
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
        this.pump();
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
            this.pump();
        } finally {
            this.polling = false;
        }
    }

    // ── Execution ──────────────────────────────────────────────────────────

    /**
     * How many runs may be under way at once. A run spends most of its life
     * waiting on Claude, so several flows overlap comfortably; the cap is what
     * keeps a morning's backlog from starting an agent per email.
     */
    private limit(): number {
        const { min, max } = CONCURRENT_RUNS_RANGE;
        const wanted = Math.trunc(getSettings().maxConcurrentRuns);
        return Number.isFinite(wanted) ? Math.min(max, Math.max(min, wanted)) : min;
    }

    /**
     * Start whatever the cap allows. Queue order is kept per flow rather than
     * across the whole queue: an item whose flow is already running is passed
     * over rather than holding up the ones behind it, which is the point of the
     * cap — otherwise one slow flow would still be every other flow's queue.
     */
    private pump(): void {
        let started = false;
        while (this.active.size < this.limit()) {
            const busy = new Set(this.active.values().map((run) => run.flowId));
            const next = this.queue.findIndex((item) => !busy.has(item.flow.id));
            // Everything left belongs to a flow that is running; its turn comes
            // when that run finishes and pumps again.
            if (next === -1) break;

            const item = this.queue[next];
            if (!item) break;
            this.queue.splice(next, 1);

            const controller = new AbortController();
            // Registered here rather than inside `execute`, so the next turn of
            // this loop counts the run and the cap holds.
            this.active.set(item.runId, { controller, flowId: item.flow.id });
            void this.execute(item, controller);
            started = true;
        }
        if (started) this.onStatus();
    }

    /** One run, start to finish. Never throws: the caller is nobody. */
    private async execute(item: QueueItem, controller: AbortController): Promise<void> {
        // The id came with the item, so `cancel` can find the controller from the
        // moment the run starts — and whoever queued it already has it.
        const runId = item.runId;
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
                // A path that ran off an unconnected port still completes, and says
                // so in `error`; that sentence is worth keeping here too.
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
            // A turn is free now — this flow's next email, or whatever the cap was
            // holding back.
            this.pump();
        }
    }
}
