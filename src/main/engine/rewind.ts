import { cpSync, existsSync } from 'node:fs';
import type { ContinuedFrom, Pass, Run } from '@shared/trace';
import { runFilesDir } from '../paths';

/**
 * A finished run wound back to just before one of its passes: what a run that
 * continues it from there starts with. The passes before that one are kept as
 * they ran, with the slots they filled; from that pass's node on, the flow runs
 * again as it now is. The run wound back is left as it was.
 */
export interface Rewound extends ContinuedFrom {
    /** The passes before the one wound back to, as they ran. */
    passes: Pass[];
    path: string[];
    edgePath: string[];
    /** Every slot those passes filled. */
    data: Record<string, unknown>;
    /** The wound-back run's scratch space, which those slots may name files in. */
    filesDir: string;
}

/** `run` wound back to just before its pass `seq`. Throws when it has no such pass. */
export function rewind(run: Run, seq: number): Rewound {
    const index = run.passes.findIndex((pass) => pass.seq === seq);
    const pass = run.passes[index];
    if (!pass) {
        throw new Error(
            run.passes.length === 0
                ? `Run ${run.id} has no passes to continue from.`
                : `Run ${run.id} has no pass ${seq}: its passes are numbered 1 to ${run.passes.length}.`,
        );
    }
    // A path and its edges are written one a pass: the passes before this one,
    // and the edge each left by, which ends at this one.
    const passes = structuredClone(run.passes.slice(0, index));
    return {
        runId: run.id,
        seq,
        nodeId: pass.nodeId,
        nodeName: pass.nodeName,
        passes,
        path: run.path.slice(0, index),
        edgePath: run.edgePath.slice(0, index),
        data: Object.assign({}, ...passes.map((p) => p.provided ?? {})) as Record<string, unknown>,
        filesDir: runFilesDir(run.id),
    };
}

/**
 * The wound-back passes and slots, moved into the run continuing them: its
 * scratch space gets a copy of the old run's files, and every path into the old
 * one now names the copy. A processor's file tools reach only its own run's
 * folder, and the old run may be deleted while this one still needs its files.
 */
export function carryOver(rewound: Rewound, scratchDir: string): Pick<Rewound, 'passes' | 'data'> {
    const carried = {
        passes: rewound.passes.map((pass) => ({...pass, carried: true})),
        data: rewound.data,
    };
    if (!existsSync(rewound.filesDir)) return carried;
    cpSync(rewound.filesDir, scratchDir, {recursive: true});
    // Paths are rebased in the JSON as written, so a path escaped on the way in
    // (a Windows backslash) matches as it is stored.
    const inJson = (path: string): string => JSON.stringify(path).slice(1, -1);
    return JSON.parse(
        JSON.stringify(carried).replaceAll(inJson(rewound.filesDir), inJson(scratchDir)),
    ) as Pick<Rewound, 'passes' | 'data'>;
}
