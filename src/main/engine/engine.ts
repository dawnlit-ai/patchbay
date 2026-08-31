import { randomUUID } from 'node:crypto';
import { findTrigger, type Flow, type FlowNode, outputPorts } from '@shared/flow';
import type { EmailEnvelope, Pass, Run, TraceEvent } from '@shared/trace';
import { executeNode } from './nodes';
import { runScratchDir } from '../paths';
import { indexRun, saveRun } from '../store/traceStore';

/**
 * Walks one email through one flow.
 *
 * The walk is deliberately linear: a node returns the single port it leaves by,
 * and the engine follows the one edge attached to that port. No fan-out, no
 * merge nodes, no partial state — which is what makes the path a list of node
 * ids that the canvas can highlight and a person can read.
 */

/** A run that visits more nodes than this is looping; stop and say so. */
const MAX_PASSES = 64;

export interface RunHooks {
    /** Called after every pass, and once at the start, so the UI can follow live. */
    onUpdate(run: Run): void;
}

export async function executeRun(
    flow: Flow,
    email: EmailEnvelope,
    trigger: 'poll' | 'manual',
    signal: AbortSignal,
    hooks: RunHooks,
): Promise<Run> {
    const runId = randomUUID();
    const run: Run = {
        id: runId,
        flowId: flow.id,
        flowName: flow.name,
        startedAt: new Date().toISOString(),
        status: 'running',
        trigger,
        email,
        path: [],
        edgePath: [],
        passes: [],
        totalCostUsd: 0,
    };

    const publish = (): void => {
        saveRun(run);
        hooks.onUpdate(run);
    };

    const finish = (status: Run['status'], error?: string): Run => {
        run.status = status;
        run.endedAt = new Date().toISOString();
        if (error) run.error = error;
        saveRun(run);
        indexRun(run);
        hooks.onUpdate(run);
        return run;
    };

    const start = findTrigger(flow);
    if (!start) return finish('failed', 'This flow has no trigger node to start from.');

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
        const startedAt = new Date().toISOString();
        seq += 1;

        let pass: Pass;
        try {
            const outcome = await executeNode({
                node,
                email,
                scratchDir,
                signal,
                onEvent: (event) => {
                    events.push(event);
                    // Publishing per event would redraw the UI hundreds of times for one
                    // agent run; the pass boundary is frequent enough to follow live.
                },
            });

            pass = {
                seq,
                nodeId: node.id,
                nodeKind: node.kind,
                nodeName: node.name,
                startedAt,
                endedAt: new Date().toISOString(),
                status: outcome.error ? 'error' : 'ok',
                outPort: outcome.outPort,
                summary: outcome.summary,
                events,
                cost: outcome.cost,
                error: outcome.error,
            };
            if (outcome.disposition) run.disposition = outcome.disposition;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            pass = {
                seq,
                nodeId: node.id,
                nodeKind: node.kind,
                nodeName: node.name,
                startedAt,
                endedAt: new Date().toISOString(),
                status: 'error',
                outPort: null,
                summary: `${node.name} threw: ${message}`,
                events,
                error: message,
            };
        }

        run.passes.push(pass);
        run.path.push(node.id);
        run.totalCostUsd += pass.cost?.usd ?? 0;
        publish();

        if (pass.error && pass.outPort === null) {
            return finish('failed', pass.error);
        }
        if (pass.outPort === null) {
            // A terminal node, or a node that deliberately ended the path.
            return finish('completed');
        }

        // A port that no longer exists means the node's config changed under an old
        // edge — worth saying out loud rather than silently ending the run.
        const ports = outputPorts(node).map((p) => p.id);
        if (!ports.includes(pass.outPort)) {
            return finish(
                'failed',
                `${node.name} chose port "${pass.outPort}", which it no longer has. Re-check the node's configuration.`,
            );
        }

        const edge = flow.edges.find((e) => e.source === node.id && e.sourceHandle === pass.outPort);
        if (!edge) {
            const label = outputPorts(node).find((p) => p.id === pass.outPort)?.label ?? pass.outPort;
            run.disposition ??= 'unhandled';
            return finish('completed', `Path ends at ${node.name}: "${label}" is not connected to anything.`);
        }

        run.edgePath.push(edge.id);
        current = flow.nodes.find((n) => n.id === edge.target);
        if (!current) return finish('failed', `Edge ${edge.id} points at a node that no longer exists.`);
    }

    return finish('completed');
}
