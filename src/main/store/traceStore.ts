import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorLogFile, runIndexFile, runScratchDir, runsDir } from '../paths';
import { appendJsonLine, parseJsonLine, readJson, readJsonLines, writeJson } from './jsonFile';
import { type MonitorNote, type Run, type RunSummary, toSummary } from '@shared/trace';

/** One JSON file per run, readable and pasteable into a bug report, plus a JSONL index for the list. */

const runFile = (id: string): string => join(runsDir(), `${id}.json`);

export function saveRun(run: Run): void {
    writeJson(runFile(run.id), run);
}

/** Called once when the run reaches a terminal state, to add one index line. */
export function indexRun(run: Run): void {
    appendJsonLine(runIndexFile(), toSummary(run));
}

/**
 * A JSONL file rewritten with each line as `edit` returns it, or without it for
 * null. Written aside and swapped in: a crash leaves the old file, not half of one.
 */
function editLines(file: string, edit: (line: string) => string | null): void {
    if (!existsSync(file)) return;
    const kept = indexLines(file).flatMap((line) => edit(line) ?? []);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, kept.map((line) => line + '\n').join(''), 'utf8');
    renameSync(tmp, file);
}

/**
 * A run indexed when it ended has changed since: its monitor has written its
 * review. Its line is rewritten in place, so the list shows what the review found.
 */
export function reindexRun(run: Run): void {
    const line = JSON.stringify(toSummary(run));
    editLines(runIndexFile(), (old) => (parseJsonLine<RunSummary>(old)?.id === run.id ? line : old));
}

/** One review in the monitor's log, which holds every monitored run's suggestions in one file, newest last. */
export function recordReview(note: MonitorNote): void {
    appendJsonLine(monitorLogFile(), note);
}

/** The monitor's reviews, newest first, of one flow or of all. */
export function listReviews(limit: number, flowId?: string): MonitorNote[] {
    return readJsonLines<MonitorNote>(monitorLogFile())
        .toReversed()
        .filter((note) => !flowId || note.flowId === flowId)
        .slice(0, limit);
}

/** Ids come from the renderer: refuse anything that could climb out of runsDir. */
const isRunId = (id: string): boolean => /^[a-zA-Z0-9-]+$/.test(id);

export function getRun(id: string): Run | null {
    if (!isRunId(id)) return null;
    return readJson<Run | null>(runFile(id), null);
}

const indexLines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(Boolean);

export function listRuns(limit: number): RunSummary[] {
    const file = runIndexFile();
    if (!existsSync(file)) return [];
    // Newest first, and lazy: the walk ends as soon as `limit` rows have parsed.
    return indexLines(file)
        .toReversed()
        .values()
        .map((line) => parseJsonLine<RunSummary>(line))
        .filter((run) => run !== null)
        .take(limit)
        .toArray();
}

export function clearRuns(): void {
    rmSync(runsDir(), {recursive: true, force: true});
    mkdirSync(runsDir(), {recursive: true});
}

/**
 * One run gone: its trace, its saved files, its line in the index, and its review
 * in the monitor's log, which quotes its email. The caller makes sure it is not under way.
 */
export function removeRun(id: string): void {
    if (!isRunId(id)) throw new Error(`No run with id "${id}".`);
    rmSync(runFile(id), {force: true});
    rmSync(runScratchDir(id), {recursive: true, force: true});
    editLines(runIndexFile(), (line) => (parseJsonLine<RunSummary>(line)?.id === id ? null : line));
    editLines(monitorLogFile(), (line) => (parseJsonLine<MonitorNote>(line)?.runId === id ? null : line));
}
