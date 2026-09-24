import { type Flow, type FlowNode, outputPorts } from '@shared/flow';
import { type EmailEnvelope, now, type Pass, type Run, type TraceEvent } from '@shared/trace';
import { executeNode } from './nodes';
import { runScratchDir } from '../paths';
import { indexRun, saveRun } from '../store/traceStore';

/** Walks one email through one flow: each node picks one output port, and the engine follows its one edge. */

/** A run that visits more nodes than this is looping; stop and say so. */
const MAX_PASSES = 64;

export interface RunRequest {
    /** Minted by the caller, so a run is cancellable before its first pass lands. */
    runId: string;
    flow: Flow;
    /** The trigger this run starts from — a flow may have several. */
    startNodeId: string;
    email: EmailEnvelope;
    trigger: 'poll' | 'manual';
    signal: AbortSignal;

    /** Called after every pass, and once at the start, so the UI can follow live. */
    onUpdate(run: Run): void;
}

export async function executeRun(request: RunRequest): Promise<Run> {
    const { runId, flow, startNodeId, email, trigger, signal } = request;
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
    };

    const publish = (): void => {
        saveRun(run);
        request.onUpdate(run);
    };

    const finish = (status: Run['status'], error?: string): Run => {
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
        try {
            const outcome = await executeNode({
                flowId: flow.id,
                node,
                email,
                scratchDir,
                signal,
                // Collected, not published: publishing per event would redraw the UI
                // hundreds of times for one agent run. The pass boundary is enough.
                onEvent: (event) => events.push(event),
            });

            pass = record({
                status: outcome.error ? 'error' : 'ok',
                outPort: outcome.outPort,
                summary: outcome.summary,
                error: outcome.error,
            });
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

        run.passes.push(pass);
        run.path.push(node.id);
        publish();

        if (pass.error && pass.outPort === null) {
            return finish('failed', pass.error);
        }
        if (pass.outPort === null) {
            // A terminal node, or a node that deliberately ended the path.
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
