import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIndexFile, runScratchDir, runsDir } from '../paths';
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

/** Ids come from the renderer: refuse anything that could climb out of runsDir. */
const isRunId = (id: string): boolean => /^[a-zA-Z0-9-]+$/.test(id);

export function getRun(id: string): Run | null {
    if (!isRunId(id)) return null;
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

/** One run gone: its trace, its saved files and its line in the index. The caller makes sure it is not under way. */
export function removeRun(id: string): void {
    if (!isRunId(id)) throw new Error(`No run with id "${id}".`);
    rmSync(runFile(id), { force: true });
    rmSync(runScratchDir(id), { recursive: true, force: true });
    const file = runIndexFile();
    if (!existsSync(file)) return;
    const kept = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line && parseSummary(line)?.id !== id);
    // Rewritten whole, so written aside and swapped in: a crash leaves the old index, not half of one.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, kept.map((line) => line + '\n').join(''), 'utf8');
    renameSync(tmp, file);
}
