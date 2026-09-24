import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runIndexFile, runsDir } from '../paths';
import { readJson, writeJson } from './jsonFile';
import { type Run, type RunSummary, toSummary } from '@shared/trace';

/** One JSON file per run, readable and pasteable into a bug report, plus a JSONL index for the list. */

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

/** A torn final line (power loss mid-append) costs one row, not the list. */
function parseSummary(line: string): RunSummary | null {
    try {
        return JSON.parse(line) as RunSummary;
    } catch {
        return null;
    }
}

export function listRuns(limit: number): RunSummary[] {
    const file = runIndexFile();
    if (!existsSync(file)) return [];
    // Newest first, and lazy: the walk ends as soon as `limit` rows have parsed.
    return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .toReversed()
        .values()
        .map(parseSummary)
        .filter((run) => run !== null)
        .take(limit)
        .toArray();
}

export function clearRuns(): void {
    rmSync(runsDir(), { recursive: true, force: true });
    mkdirSync(runsDir(), { recursive: true });
}
