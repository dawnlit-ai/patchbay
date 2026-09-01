import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { flowsDir, watermarkFile } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { emptyFlow, type Flow, parseFlow } from '@shared/flow';

const filePath = (id: string): string => join(flowsDir(), `${id}.json`);

export function listFlows(): Flow[] {
    const dir = flowsDir();
    const flows = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<Flow | null>(join(dir, f), null))
        .filter((f): f is Flow => f !== null);

    // A fresh install starts with a trigger already on the canvas, rather than an
    // empty list and an empty grid.
    if (flows.length === 0) {
        const seeded = emptyFlow(randomUUID(), 'My first flow');
        writeJson(filePath(seeded.id), seeded);
        return [seeded];
    }
    return flows.toSorted((a, b) => a.name.localeCompare(b.name));
}

export function getFlow(id: string): Flow | null {
    return readJson<Flow | null>(filePath(id), null);
}

export function saveFlow(flow: Flow): Flow {
    const next: Flow = { ...flow, updatedAt: new Date().toISOString() };
    writeJson(filePath(next.id), next);
    return next;
}

export function createFlow(name: string): Flow {
    return saveFlow(emptyFlow(randomUUID(), name));
}

/** Takes the flow file and the watcher's mark for it — both are keyed by id. */
export function removeFlow(id: string): void {
    const path = filePath(id);
    if (existsSync(path)) unlinkSync(path);
    // Nothing will read this flow's watermark again: ids are minted fresh, so no
    // later flow inherits it, and left behind it only grows the file.
    const marks = readJson<Record<string, unknown>>(watermarkFile(), {});
    if (id in marks) {
        delete marks[id];
        writeJson(watermarkFile(), marks);
    }
}

// ── Files outside the workspace ──────────────────────────────────────────

/**
 * Read a flow file the user picked. It lands as a new flow rather than replacing
 * one, so importing twice gives two copies and an import can never overwrite the
 * flow being edited. Everything in the file is run past `parseFlow` first.
 */
export function importFlowFile(path: string): Flow {
    const label = basename(path);
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        throw new Error(`${label} is not readable JSON.`);
    }
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { nodes?: unknown }).nodes)) {
        throw new Error(`${label} does not look like a Patchbay flow.`);
    }
    return saveFlow(parseFlow(raw, randomUUID(), label.replace(/\.json$/i, '') || 'Imported flow'));
}

/** Write a flow out in the app's own format, so the copy imports cleanly. */
export function exportFlowFile(flow: Flow, path: string): void {
    writeJson(path, flow);
}
