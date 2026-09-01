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
            this.onStatus();
            return this.status();
        }
        this.lastError = undefined;
        // A fixed tick; each trigger's own pollSeconds decides when its turn comes.
        this.timer = setInterval(() => void this.poll(), 15_000);
        void this.poll();
        this.onStatus();
        return this.status();
    }

    stop(): EngineStatus {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
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
                    this.lastError = `${flow.name} / ${node.name}: ${e instanceof Error ? e.message : String(e)}`;
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
                    continue;
                }

                // Oldest first, so a backlog is processed in the order it arrived.
                const fresh = emails.filter((e) => !seen.has(e.ref.entryId)).toReversed();
                for (const email of fresh) {
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
                try {
                    await executeRun({
                        runId,
                        flow: item.flow,
                        startNodeId: item.startNodeId,
                        email: item.email,
                        trigger: item.trigger,
                        signal: controller.signal,
                        onUpdate: (run) => this.onRun(run),
                    });
                } catch (e) {
                    this.lastError = e instanceof Error ? e.message : String(e);
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
