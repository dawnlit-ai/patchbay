import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runIndexFile, runsDir } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { type Run, type RunSummary, toSummary } from '@shared/trace';

/**
 * Runs are stored one JSON file each, with a JSONL index for the list view.
 *
 * A database would be the reflex here, but the whole point of these records is
 * that they stay readable when something has gone wrong months later — a run is
 * a file you can open, diff, and paste into a bug report. The index exists only
 * so the runs list does not have to parse every run to draw a row.
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
    // Ids come from the renderer, so refuse anything that could climb out of the
    // runs directory rather than trusting the caller.
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
