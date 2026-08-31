import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Everything the app owns lives under one workspace directory, because the
 * Agent SDK needs a real `cwd` with a `.claude/skills` tree beneath it — the
 * skill library is a directory of files, not a database table.
 */
let root: string | null = null;

export function workspaceRoot(): string {
    if (!root) {
        root = join(app.getPath('userData'), 'workspace');
        mkdirSync(root, { recursive: true });
    }
    return root;
}

function ensure(...segments: string[]): string {
    const dir = join(workspaceRoot(), ...segments);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Where SKILL.md folders live. The Agent SDK discovers them from here. */
export const skillsDir = (): string => ensure('.claude', 'skills');
export const flowsDir = (): string => ensure('flows');
export const runsDir = (): string => ensure('runs');
/** Per-run scratch space — saved attachments, files a skill writes. */
export const runScratchDir = (runId: string): string => ensure('runs', runId + '.files');
export const settingsFile = (): string => join(workspaceRoot(), 'settings.json');
export const watermarkFile = (): string => join(workspaceRoot(), 'watermarks.json');
export const runIndexFile = (): string => join(runsDir(), 'index.jsonl');
