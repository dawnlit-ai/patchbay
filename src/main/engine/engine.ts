import { EMAIL_SLOT, type Flow, type FlowNode, outputPorts, requires } from '@shared/flow';
import { type EmailEnvelope, now, type Pass, type PassUnderWay, type Run, type TraceEvent } from '@shared/trace';
import { errorMessage } from '@shared/util';
import { executeNode } from './nodes';
import { carryOver, type Rewound } from './rewind';
import { runScratchDir } from '../paths';
import { workspaceSchemas } from '../store/schemaStore';
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
    /** Whether the AI monitor is brought in: the run carries it from the start, and it reviews the run once it ends. */
    monitor?: boolean;
    /**
     * An earlier run wound back to one of its passes, which this run continues:
     * it starts with the passes before that one and the slots they filled, and
     * at that pass's node rather than at `startNodeId`.
     */
    continuing?: Rewound;
    signal: AbortSignal;

    /** Called at the start and end of every pass, and a few times a second while a node works, so the UI can follow live. */
    onUpdate(run: Run): void;
}

export async function executeRun(request: RunRequest): Promise<Run> {
    const {runId, flow, startNodeId, email, trigger, signal, continuing} = request;
    const scratchDir = runScratchDir(runId);
    let carried: Pick<Rewound, 'passes' | 'data'> = {passes: [], data: {}};
    let carryFailed: string | undefined;
    if (continuing) {
        try {
            carried = carryOver(continuing, scratchDir);
        } catch (e) {
            carryFailed = `Could not bring over the files of run ${continuing.runId}: ${errorMessage(e)}`;
        }
    }
    const run: Run = {
        id: runId,
        flowId: flow.id,
        flowName: flow.name,
        startedAt: now(),
        status: 'running',
        trigger,
        email,
        path: continuing ? [...continuing.path] : [],
        edgePath: continuing ? [...continuing.edgePath] : [],
        passes: carried.passes,
        data: carried.data,
        ...(request.monitor ? {monitor: {state: 'watching', findings: [], events: []}} : {}),
        ...(continuing
            ? {
                continuedFrom: {
                    runId: continuing.runId,
                    seq: continuing.seq,
                    nodeId: continuing.nodeId,
                    nodeName: continuing.nodeName,
                },
            }
            : {}),
    };
    const {data} = run;

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

    if (carryFailed) return finish('failed', carryFailed);
    const start = flow.nodes.find((n) => n.id === (continuing?.nodeId ?? startNodeId));
    if (!start) {
        return finish(
            'failed',
            continuing
                ? `${continuing.nodeName}, the node this run was to continue from, is no longer in the flow.`
                : 'The trigger this run started from is no longer in the flow.',
        );
    }

    publish();

    // Read once, as the run starts, so a schema edited while it is under way does not change it halfway.
    const schemas = workspaceSchemas();
    let current: FlowNode | undefined = start;
    // A continued run numbers its own passes on from those it carries, as the run it continues did.
    const carriedCount = run.passes.length;
    let seq = carriedCount;

    while (current) {
        if (signal.aborted) return finish('failed', 'Cancelled.');
        if (seq - carriedCount >= MAX_PASSES) {
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
                runId,
                flowId: flow.id,
                node,
                schemas,
                email,
                trigger,
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
            const message = errorMessage(e);
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
