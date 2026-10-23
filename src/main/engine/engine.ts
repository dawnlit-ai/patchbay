import { EMAIL_SLOT, type Flow, type FlowNode, outputPorts, requires } from '@shared/flow';
import { type EmailEnvelope, now, type Pass, type PassUnderWay, type Run, type TraceEvent } from '@shared/trace';
import { executeNode } from './nodes';
import { runScratchDir } from '../paths';
import { indexRun, saveRun } from '../store/traceStore';

/** Walks one email through one flow: each node picks one output port, and the engine follows its one edge. */

/** A run that visits more nodes than this is looping; stop and say so. */
const MAX_PASSES = 64;

/** How often a node at work is sent to the window, and written to disk, as its events and text come in. */
const SEND_MS = 200;
const SAVE_MS = 1_000;

/** Calls `fn` once, `ms` after the first ask since it last ran, however often it is asked meanwhile. */
function throttled(ms: number, fn: () => void): { ask(): void; cancel(): void } {
    let timer: NodeJS.Timeout | null = null;
    return {
        ask: () => {
            timer ??= setTimeout(() => {
                timer = null;
                fn();
            }, ms);
        },
        cancel: () => {
            if (timer) clearTimeout(timer);
            timer = null;
        },
    };
}

export interface RunRequest {
    /** Minted by the caller, so a run is cancellable before its first pass lands. */
    runId: string;
    flow: Flow;
    /** The trigger this run starts from — a flow may have several. */
    startNodeId: string;
    email: EmailEnvelope;
    trigger: 'poll' | 'manual';
    signal: AbortSignal;

    /** Called at the start and end of every pass, and a few times a second while a node works, so the UI can follow live. */
    onUpdate(run: Run): void;
}

export async function executeRun(request: RunRequest): Promise<Run> {
    const {runId, flow, startNodeId, email, trigger, signal} = request;
    const run: Run = {
        id: runId,
        flowId: flow.id,
        flowName: flow.name,
        startedAt: now(),
        status: 'running',
        trigger,
        email,
        path: [],
        edgePath: [],
        passes: [],
        data: {},
    };
    const data: Record<string, unknown> = run.data!;

    // Per event would be hundreds of redraws and writes for one agent streaming its
    // reply; these catch up a few times a second, and the pass boundary at once.
    const send = throttled(SEND_MS, () => request.onUpdate(run));
    const save = throttled(SAVE_MS, () => saveRun(run));

    const publish = (): void => {
        send.cancel();
        save.cancel();
        saveRun(run);
        request.onUpdate(run);
    };

    const finish = (status: Run['status'], error?: string): Run => {
        send.cancel();
        save.cancel();
        delete run.current;
        run.status = status;
        run.endedAt = now();
        if (error) run.error = error;
        saveRun(run);
        indexRun(run);
        request.onUpdate(run);
        return run;
    };

    const start = flow.nodes.find((n) => n.id === startNodeId);
    if (!start) return finish('failed', 'The trigger this run started from is no longer in the flow.');

    publish();

    const scratchDir = runScratchDir(runId);
    let current: FlowNode | undefined = start;
    let seq = 0;

    while (current) {
        if (signal.aborted) return finish('failed', 'Cancelled.');
        if (seq >= MAX_PASSES) {
            return finish('failed', `Stopped after ${MAX_PASSES} passes — the flow loops back on itself.`);
        }

        const node: FlowNode = current;
        const events: TraceEvent[] = [];
        const startedAt = now();
        seq += 1;

        /** The half of a pass that is the same however the node ended. */
        const record = (outcome: Pick<Pass, 'status' | 'outPort' | 'summary' | 'error'>): Pass => ({
            seq,
            nodeId: node.id,
            nodeKind: node.kind,
            nodeName: node.name,
            startedAt,
            endedAt: now(),
            events,
            ...outcome,
        });

        let pass: Pass;
        // The canvas refuses to watch a flow that would get here, but a test run
        // of one being drawn still can.
        const unfilled = requires(node).filter((name) => name !== EMAIL_SLOT.name && !(name in data));
        if (unfilled.length > 0) {
            const message = `${node.name} reads ${unfilled.map((n) => `"${n}"`).join(', ')}, which no node on this path filled.`;
            run.passes.push(record({status: 'error', outPort: null, summary: message, error: message}));
            run.path.push(node.id);
            return finish('failed', message);
        }
        const underWay: PassUnderWay = {
            seq,
            nodeId: node.id,
            nodeKind: node.kind,
            nodeName: node.name,
            startedAt,
            events,
        };
        run.current = underWay;
        publish();
        try {
            const outcome = await executeNode({
                flowId: flow.id,
                node,
                schemas: flow.schemas,
                email,
                data,
                scratchDir,
                signal,
                onEvent: (event) => {
                    events.push(event);
                    save.ask();
                    send.ask();
                },
                // Asks for no write: the whole block lands in `events` a moment later.
                onLive: (text) => {
                    underWay.live = text ?? undefined;
                    send.ask();
                },
            });

            pass = record({
                status: outcome.error ? 'error' : 'ok',
                outPort: outcome.outPort,
                summary: outcome.summary,
                error: outcome.error,
            });
            if (outcome.provided) {
                pass.provided = outcome.provided;
                Object.assign(data, outcome.provided);
            }
            if (outcome.disposition) run.disposition = outcome.disposition;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            pass = record({
                status: 'error',
                outPort: null,
                summary: `${node.name} threw: ${message}`,
                error: message,
            });
        }

        delete run.current;
        run.passes.push(pass);
        run.path.push(node.id);
        publish();

        if (pass.error && pass.outPort === null) {
            return finish('failed', pass.error);
        }
        if (pass.outPort === null) {
            // A terminal node.
            return finish('completed');
        }

        // A port that no longer exists means the config changed under an old edge —
        // worth saying out loud rather than silently ending the run.
        const ports = outputPorts(node);
        if (!ports.some((p) => p.id === pass.outPort)) {
            return finish(
                'failed',
                `${node.name} chose port "${pass.outPort}", which it no longer has. Re-check the node's configuration.`,
            );
        }

        const edge = flow.edges.find((e) => e.source === node.id && e.sourceHandle === pass.outPort);
        if (!edge) {
            const label = ports.find((p) => p.id === pass.outPort)?.label ?? pass.outPort;
            run.disposition ??= 'unhandled';
            return finish('completed', `Path ends at ${node.name}: "${label}" is not connected to anything.`);
        }

        run.edgePath.push(edge.id);
        current = flow.nodes.find((n) => n.id === edge.target);
        if (!current) return finish('failed', `Edge ${edge.id} points at a node that no longer exists.`);
    }

    return finish('completed');
}
