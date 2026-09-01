import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Everything the app owns lives under one workspace directory, and every flow
 * owns a directory inside it: the Agent SDK needs a real `cwd` with a
 * `.claude/skills` tree beneath it, and that cwd is the flow being run.
 */
let root: string | null = null;

export function workspaceRoot(): string {
    if (!root) {
        root = join(app.getPath('userData'), 'workspace');
        mkdirSync(root, { recursive: true });
    }
    return root;
}

function ensureAt(path: string): string {
    mkdirSync(path, { recursive: true });
    return path;
}

function ensure(...segments: string[]): string {
    return ensureAt(join(workspaceRoot(), ...segments));
}

/**
 * Flow and run ids reach these from the renderer and become path segments, so
 * anything that could climb out of the workspace is refused here rather than
 * further down, where the call is an `rm -r`.
 */
function safeId(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`"${id}" is not a usable id.`);
    return id;
}

/**
 * The global library is handed to Claude as a local plugin, which is what lets a
 * run load skills from outside its own working directory. That layout is the
 * plugin one — a manifest beside a `skills` folder — rather than `.claude/skills`.
 */
export const globalPluginDir = (): string => ensure('global');
export const globalSkillsDir = (): string => ensure('global', 'skills');

export const flowsDir = (): string => ensure('flows');
/**
 * A flow's own directory: its file, its skills, and the cwd every node of it runs
 * in. Created on the way out, because a cwd that does not exist is a run that
 * fails at the Agent SDK rather than at the call that forgot to make it.
 */
export const flowDir = (flowId: string): string => ensure('flows', safeId(flowId));
/** Where one flow's SKILL.md folders live. The Agent SDK discovers them from here. */
export const flowSkillsDir = (flowId: string): string =>
    ensureAt(join(flowDir(flowId), '.claude', 'skills'));
export const runsDir = (): string => ensure('runs');
/** Per-run scratch space — saved attachments, files a skill writes. */
export const runScratchDir = (runId: string): string => ensure('runs', runId + '.files');
export const settingsFile = (): string => join(workspaceRoot(), 'settings.json');
export const watermarkFile = (): string => join(workspaceRoot(), 'watermarks.json');
export const runIndexFile = (): string => join(runsDir(), 'index.jsonl');
