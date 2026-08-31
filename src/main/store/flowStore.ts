import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { flowsDir } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { emptyFlow, type Flow } from '@shared/flow';

const filePath = (id: string): string => join(flowsDir(), `${id}.json`);

export function listFlows(): Flow[] {
    const dir = flowsDir();
    const flows = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<Flow | null>(join(dir, f), null))
        .filter((f): f is Flow => f !== null);

    // A fresh install has nowhere to start, so hand back one flow with a trigger
    // already on the canvas rather than an empty list and an empty grid.
    if (flows.length === 0) {
        const seeded = emptyFlow(randomUUID(), 'My first flow');
        writeJson(filePath(seeded.id), seeded);
        return [seeded];
    }
    return flows.sort((a, b) => a.name.localeCompare(b.name));
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

export function removeFlow(id: string): void {
    const path = filePath(id);
    if (existsSync(path)) unlinkSync(path);
}
