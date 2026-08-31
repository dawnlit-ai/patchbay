import { randomUUID } from 'node:crypto';
import { watermarkFile } from '../paths';
import { readJson, writeJson } from '../store/jsonFile';
import { getFlow, listFlows } from '../store/flowStore';
import { getSettings } from '../store/settingsStore';
import { findTrigger, type Flow } from '@shared/flow';
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
    /** False until the first poll has established a baseline for this flow. */
    primed: boolean;
}

type Watermarks = Record<string, Watermark>;

const SEEN_LIMIT = 500;

interface QueueItem {
    flow: Flow;
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
    private lastPollPerFlow = new Map<string, number>();

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
        // A fixed tick; each flow's own pollSeconds decides whether its turn has come.
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
        const watching = this.watchedFlows().map((flow) => {
            const trigger = findTrigger(flow);
            const config = trigger?.config.kind === 'trigger.outlook' ? trigger.config : undefined;
            return {
                flowId: flow.id,
                flowName: flow.name,
                account: config?.account ?? '',
                folder: config?.folder ?? '',
            };
        });
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

    /** Run a flow against a chosen email now, bypassing the watermark entirely. */
    enqueueManual(flowId: string, email: EmailEnvelope): void {
        const flow = getFlow(flowId);
        if (!flow) throw new Error(`No flow ${flowId}`);
        this.queue.push({ flow, email, trigger: 'manual' });
        void this.drain();
    }

    private watchedFlows(): Flow[] {
        return listFlows().filter((flow) => {
            const trigger = findTrigger(flow);
            return trigger?.config.kind === 'trigger.outlook' && trigger.config.account.trim() !== '';
        });
    }

    private async poll(): Promise<void> {
        if (this.polling) return;
        this.polling = true;
        try {
            const marks = readJson<Watermarks>(watermarkFile(), {});
            let changed = false;

            for (const flow of this.watchedFlows()) {
                const trigger = findTrigger(flow);
                if (trigger?.config.kind !== 'trigger.outlook') continue;
                const config = trigger.config;

                const due = (this.lastPollPerFlow.get(flow.id) ?? 0) + config.pollSeconds * 1000;
                if (Date.now() < due) continue;
                this.lastPollPerFlow.set(flow.id, Date.now());

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
                    this.lastError = `${flow.name}: ${e instanceof Error ? e.message : String(e)}`;
                    continue;
                }

                const mark: Watermark = marks[flow.id] ?? { seen: [], primed: false };
                const seen = new Set(mark.seen);

                // The first poll establishes a baseline; without it, switching a flow
                // on would fire a run for every email already in the folder.
                if (!mark.primed && !config.processBacklogOnStart) {
                    mark.seen = emails.map((e) => e.ref.entryId).slice(-SEEN_LIMIT);
                    mark.primed = true;
                    marks[flow.id] = mark;
                    changed = true;
                    continue;
                }

                // Oldest first, so a backlog is processed in the order it arrived.
                const fresh = emails.filter((e) => !seen.has(e.ref.entryId)).toReversed();
                for (const email of fresh) {
                    mark.seen.push(email.ref.entryId);
                    this.queue.push({ flow, email, trigger: 'poll' });
                }
                if (fresh.length > 0) {
                    mark.seen = mark.seen.slice(-SEEN_LIMIT);
                    changed = true;
                }
                mark.primed = true;
                marks[flow.id] = mark;
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
                // Minted here, not inside the run, so `cancel` can find the controller
                // from the moment the run starts.
                const runId = randomUUID();
                const controller = new AbortController();
                this.active.set(runId, controller);
                this.onStatus();
                try {
                    await executeRun({
                        runId,
                        flow: item.flow,
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
