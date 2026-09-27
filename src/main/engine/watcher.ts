import { randomUUID } from 'node:crypto';
import { watermarkFile } from '../paths';
import { readJson, writeJson } from '../store/jsonFile';
import { getFlow, listFlows } from '../store/flowStore';
import { getSettings } from '../store/settingsStore';
import { checkSlots, findTriggers, type Flow, type FlowNode, triggerConfig, type TriggerConfig } from '@shared/flow';
import type { EmailEnvelope, Run } from '@shared/trace';
import { CONCURRENT_RUNS_RANGE, type EngineStatus } from '@shared/settings';
import * as outlook from '../outlook/bridge';
import { executeRun } from './engine';
import { log } from '../log';

/**
 * Polls each trigger's mailbox (Outlook offers no push) and queues a run per new
 * email. Runs overlap up to the cap in Settings, but never two of one flow: they
 * share its directory as cwd, and its mail is handled in arrival order.
 */

interface Watermark {
    /** Emails already handled, by `mailKey`, newest last. Bounded so the file stays small. */
    seen: string[];
    /** False until the first poll has established a baseline for this trigger. */
    primed: boolean;
    /** What `seen` holds. Set by the poll that primes the mark. */
    keyedBy?: KeyedBy;
}

/**
 * How a trigger recognises an email it has seen. Outlook rewrites the entry id
 * when mail moves, so a trigger watching subfolders keys by sender, time and
 * subject instead.
 */
type KeyedBy = 'entryId' | 'message';

const keyedByFor = (config: TriggerConfig): KeyedBy => (config.includeSubfolders ? 'message' : 'entryId');

function mailKey(email: EmailEnvelope, keyedBy: KeyedBy): string {
    return keyedBy === 'entryId'
        ? email.ref.entryId
        : [email.senderEmail.toLowerCase(), email.receivedTime, email.subject].join('\n');
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

/** A flow's triggers, whether or not they name a mailbox yet. */
function triggersOf(flow: Flow): WatchedTrigger[] {
    return findTriggers(flow).flatMap((node) => {
        const config = triggerConfig(node);
        return config ? [{ flow, node, config }] : [];
    });
}

const namesMailbox = (t: WatchedTrigger): boolean => t.config.account.trim() !== '';

/** A run under way: what stops it, and the flow whose turn it holds. */
interface ActiveRun {
    controller: AbortController;
    flowId: string;
}

interface QueueItem {
    /** Minted at queue time, so the caller can cancel or look up the run before it starts. */
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

/** What cancelling did. `unknown` most likely means the run already finished. */
export type CancelOutcome = 'stopping' | 'dequeued' | 'unknown';

export class Watcher {
    /** Runs while any flow is switched on. */
    private timer: NodeJS.Timeout | null = null;
    /** Flows switched on. Not persisted: after a relaunch, nothing polls until asked to. */
    private flowIds = new Set<string>();
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

    /**
     * Switch one flow on. Refused while polling is off in Settings, for a flow
     * with no trigger that names a mailbox, and for one with a node that reads a
     * slot some path to it never fills.
     */
    start(flowId: string): EngineStatus {
        const flow = getFlow(flowId);
        if (!flow) throw new Error(`No flow ${flowId}`);
        if (this.flowIds.has(flowId)) return this.status();
        if (!getSettings().pollingEnabled) {
            log.warn('watcher', `Not watching ${flow.name}: polling is switched off in Settings`);
            throw new Error('Polling is switched off in Settings.');
        }
        const triggers = triggersOf(flow);
        const polled = triggers.filter(namesMailbox);
        if (polled.length === 0) {
            throw new Error(
                triggers.length === 0
                    ? `"${flow.name}" has no trigger, so there is nothing to watch.`
                    : `No trigger in "${flow.name}" names a mailbox yet.`,
            );
        }
        const unfilled = checkSlots(flow).issues.filter((issue) => issue.severity === 'error');
        if (unfilled.length > 0) {
            throw new Error(`Not watching "${flow.name}": ${unfilled.map((issue) => issue.message).join(' ')}`);
        }
        this.lastError = undefined;
        this.flowIds.add(flowId);
        // A fixed tick; each trigger's own pollSeconds decides when its turn comes.
        this.timer ??= setInterval(() => void this.poll(), 15_000);
        log.info('watcher', `Started watching ${flow.name}: ${polled.length} mailbox(es)`);
        for (const { node } of triggers.filter((t) => !namesMailbox(t))) {
            log.warn('watcher', `${where(flow, node)} names no mailbox, so it is not polled`);
        }
        void this.poll();
        this.onStatus();
        return this.status();
    }

    /** Switch one flow off. A run of it already under way is left to finish. */
    stop(flowId: string): EngineStatus {
        if (!this.flowIds.delete(flowId)) return this.status();
        log.info('watcher', `Stopped watching ${getFlow(flowId)?.name ?? flowId}`);
        this.dropQueued((item) => item.flow.id === flowId);
        this.stopTimerIfIdle();
        this.onStatus();
        return this.status();
    }

    /** Switch every flow off, as closing the last window does. */
    stopAll(): void {
        if (this.flowIds.size > 0) log.info('watcher', 'Stopped watching every flow');
        this.flowIds.clear();
        this.dropQueued(() => true);
        this.stopTimerIfIdle();
        this.onStatus();
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
            flowIds: [...this.flowIds],
            watching,
            lastPollAt: this.lastPollAt,
            lastError: this.lastError,
            activeRunIds: [...this.active.keys()],
            queuedRunIds: this.queue.map((item) => item.runId),
        };
    }

    /** Queued runs in order, and what each is waiting for. They have ids but no trace yet. */
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

    /** Abort a run under way, or remove one still queued. */
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
        // A polled email was marked seen when queued, so it won't come back: a warning, as in `dropQueued`.
        const subject = `"${item.email.subject || '(no subject)'}"`;
        const detail = `${item.flow.name} · from ${item.email.senderEmail} · received ${item.email.receivedTime}`;
        if (item.trigger === 'poll') log.warn('watcher', `Cancelled before it started, not run: ${subject}`, { detail });
        else log.info('run', `Cancelled before it started: ${subject} (test)`, { detail });
        this.onStatus();
        return 'dequeued';
    }

    /** Whether this run is under way or waiting its turn: its trace is still being written. */
    isRunPending(runId: string): boolean {
        return this.active.has(runId) || this.queue.some((item) => item.runId === runId);
    }

    /**
     * Whether a run of this flow is under way. Its directory is the working
     * directory of that run, so whoever wants to move one asks first.
     */
    isFlowRunning(flowId: string): boolean {
        return this.active.values().some((run) => run.flowId === flowId);
    }

    /**
     * Before a flow is deleted: throws while a run of it is under way, and cancels
     * its queued runs. Returns how many were cancelled.
     */
    clearForRemoval(flowId: string): number {
        if (this.isFlowRunning(flowId)) {
            throw new Error(
                'A run of this flow is in progress. Its folder is the directory that run works in, so the flow cannot be deleted until the run finishes or is cancelled.',
            );
        }
        if (this.flowIds.delete(flowId)) {
            this.stopTimerIfIdle();
            this.onStatus();
        }
        const queued = this.queue.filter((item) => item.flow.id === flowId);
        for (const item of queued) this.cancel(item.runId);
        return queued.length;
    }

    /**
     * Queue a run of a chosen email from a chosen trigger, bypassing the
     * watermark. Returns the id the run will have.
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

    private stopTimerIfIdle(): void {
        if (this.flowIds.size > 0 || !this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * A polled email was marked seen when it was queued, so one dropped here is
     * never picked up again. Worth a line each: only a test run brings it back.
     */
    private dropQueued(which: (item: QueueItem) => boolean): void {
        for (const item of this.queue.filter(which)) {
            log.warn('watcher', `Dropped from the queue, not run: "${item.email.subject}"`, {
                detail: `${item.flow.name} · from ${item.email.senderEmail} · received ${item.email.receivedTime}`,
            });
        }
        this.queue = this.queue.filter((item) => !which(item));
    }

    /** Every trigger in the library, whether or not it names a mailbox yet. */
    private triggers(): WatchedTrigger[] {
        return listFlows().flatMap(triggersOf);
    }

    /** Those a poll reads: in a flow switched on, and naming a mailbox. */
    private watchedTriggers(): WatchedTrigger[] {
        return this.triggers().filter((t) => this.flowIds.has(t.flow.id) && namesMailbox(t));
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

            for (const trigger of triggers) {
                const { flow, node, config } = trigger;
                if (!this.flowIds.has(flow.id) || !namesMailbox(trigger)) continue;
                const key = markKey(flow.id, node.id);

                const due = (this.lastPollPerTrigger.get(key) ?? 0) + config.pollSeconds * 1000;
                if (Date.now() < due) continue;
                this.lastPollPerTrigger.set(key, Date.now());

                let emails: EmailEnvelope[];
                try {
                    emails = await outlook.readScope(config, config.lookbackDays, config.maxPerPoll);
                    this.lastError = undefined;
                } catch (e) {
                    this.lastError = `${where(flow, node)}: ${e instanceof Error ? e.message : String(e)}`;
                    log.error('watcher', `Poll failed at ${this.lastError}`);
                    continue;
                }
                // Switched off while Outlook answered: left unmarked, for when it is back on.
                if (!this.flowIds.has(flow.id)) continue;

                const mark: Watermark = marks[key] ?? { seen: [], primed: false };
                const keyedBy = keyedByFor(config);
                const idOf = (email: EmailEnvelope): string => mailKey(email, keyedBy);
                const seen = new Set(mark.seen);
                // Switching a trigger between one folder and a whole tree changes what
                // its marks are keys of, so none of the old ones would match.
                const rekeyed = mark.primed && mark.keyedBy !== keyedBy;

                // The first poll (or one after re-keying) only records a baseline, so
                // switching a flow on doesn't run every email already there.
                if ((!mark.primed && !config.processBacklogOnStart) || rekeyed) {
                    mark.seen = emails.map(idOf).slice(-SEEN_LIMIT);
                    mark.primed = true;
                    mark.keyedBy = keyedBy;
                    marks[key] = mark;
                    changed = true;
                    // The one poll that sees mail and starts nothing, on purpose — and
                    // the first place to look when an email already there never ran.
                    const why = rekeyed
                        ? `now ${config.includeSubfolders ? 'watches the folders below too' : 'watches one folder'}`
                        : 'first look';
                    log.info(
                        'watcher',
                        `${where(flow, node)}: ${why}, so the ${emails.length} email(s) already there are marked seen and not run`,
                        { detail: emails.map((e) => `${e.receivedTime}  ${e.subject}`).join('\n') || undefined },
                    );
                    continue;
                }

                // Oldest first, so a backlog is processed in the order it arrived. Kept
                // to one run per key: a mailbox can hold two copies of one message.
                const fresh = emails
                    .filter((e) => {
                        const id = idOf(e);
                        if (seen.has(id)) return false;
                        seen.add(id);
                        return true;
                    })
                    .toReversed();
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
                    mark.seen.push(idOf(email));
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
                mark.keyedBy = keyedBy;
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

    /** How many runs may be under way at once: the Settings cap, clamped to its range. */
    private limit(): number {
        const { min, max } = CONCURRENT_RUNS_RANGE;
        const wanted = Math.trunc(getSettings().maxConcurrentRuns);
        return Number.isFinite(wanted) ? Math.min(max, Math.max(min, wanted)) : min;
    }

    /**
     * Start whatever the cap allows. Order is kept per flow: an item whose flow is
     * busy is skipped rather than holding up other flows behind it.
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
            const tally = `${run.passes.length} pass(es)`;
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
            this.pump();
        }
    }
}
