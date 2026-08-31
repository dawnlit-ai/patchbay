import { app } from 'electron';
import { mkdirSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Everything the app owns lives under one workspace directory, because the
 * Agent SDK needs a real `cwd` with a `.claude/skills` tree beneath it — the
 * skill library is a directory of files, not a database table.
 */
let root: string | null = null;

/**
 * userData is derived from the app's productName, so renaming the product moves
 * it and would strand every flow, skill and run behind the old name. Each former
 * name stays listed here and its workspace is copied forward once.
 */
const FORMER_PRODUCT_NAMES = ['Email Flow Studio'];

function adoptLegacyWorkspace(target: string): void {
  for (const name of FORMER_PRODUCT_NAMES) {
    const legacy = join(app.getPath('appData'), name, 'workspace');
    if (!existsSync(legacy)) continue;
    // Copied rather than moved: if anything about this goes wrong, the original
    // is still sitting there under the old name.
    cpSync(legacy, target, { recursive: true });
    console.log(`Adopted workspace from "${name}": ${legacy} → ${target}`);
    return;
  }
}

export function workspaceRoot(): string {
  if (!root) {
    const next = join(app.getPath('userData'), 'workspace');
    if (!existsSync(next)) adoptLegacyWorkspace(next);
    root = next;
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
export const settingsFile = (): string => join(ensure('.'), 'settings.json');
export const watermarkFile = (): string => join(ensure('.'), 'watermarks.json');
export const runIndexFile = (): string => join(runsDir(), 'index.jsonl');
