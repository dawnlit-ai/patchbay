import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runIndexFile, runsDir } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { type Run, type RunSummary, toSummary } from '@shared/trace';

/**
 * One JSON file per run, plus a JSONL index for the list view. Files rather than
 * a database because a run should stay openable, diffable and pasteable into a
 * bug report months later; the index only spares the list from parsing them all.
 */

const runFile = (id: string): string => join(runsDir(), `${id}.json`);

export function saveRun(run: Run): void {
    writeJson(runFile(run.id), run);
}

/** Called once when the run reaches a terminal state, to add one index line. */
export function indexRun(run: Run): void {
    appendFileSync(runIndexFile(), JSON.stringify(toSummary(run)) + '\n', 'utf8');
}

export function getRun(id: string): Run | null {
    // Ids come from the renderer: refuse anything that could climb out of runsDir.
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
    return readJson<Run | null>(runFile(id), null);
}

export function listRuns(limit: number): RunSummary[] {
    const file = runIndexFile();
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const out: RunSummary[] = [];
    // Walk backwards: the newest runs are the ones anyone wants to see.
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
            out.push(JSON.parse(lines[i] as string) as RunSummary);
        } catch {
            // A torn final line (power loss mid-append) costs one row, not the list.
        }
    }
    return out;
}

export function clearRuns(): void {
    rmSync(runsDir(), { recursive: true, force: true });
    mkdirSync(runsDir(), { recursive: true });
}
