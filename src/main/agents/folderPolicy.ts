import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/**
 * Holds a Claude run's own file tools to its folders: each call to one is let
 * through when every path it names lies in a folder it may use that way, and
 * refused, with the reason, when one does not. A call to any other tool is left
 * to the run's permissions. Claude Code's own path rules are not used, since a
 * folder this check leaves out has to stay out even where the run's working
 * directory holds it, which a rule cannot say once another rule lets a folder in.
 */

/** Claude Code's tools that reach files, and whether each only reads. */
const FILE_TOOLS: Record<string, 'read' | 'write'> = {
    Read: 'read',
    Glob: 'read',
    Grep: 'read',
    LS: 'read',
    NotebookRead: 'read',
    Write: 'write',
    Edit: 'write',
    MultiEdit: 'write',
    NotebookEdit: 'write',
};

/** The tools whose `path` is a folder they search, the working directory when it is left out. */
const SEARCHES = new Set(['Glob', 'Grep', 'LS']);

export interface FolderPolicy {
    /** Folders the run may read in: those it may write in are among them. */
    read: string[];
    write: string[];
}

/**
 * A path as it really is: the deepest part of it that exists with every link
 * followed, and the rest after it. The system's own answer comes first, as it
 * also spells out a Windows short name — the temp folder's `USERNA~1` — the way
 * Claude Code may name the same file in full.
 */
function real(path: string): string {
    let head = resolve(path);
    const rest: string[] = [];
    while (!existsSync(head)) {
        const up = dirname(head);
        if (up === head) return resolve(path);
        rest.unshift(basename(head));
        head = up;
    }
    for (const resolveLinks of [realpathSync.native, realpathSync]) {
        try {
            return join(resolveLinks(head), ...rest);
        } catch {
            // The next way, or the path as given.
        }
    }
    return resolve(path);
}

/** Whether `path` is `root` or lies under it. Letter case counts as the platform's paths count it. */
function inside(path: string, root: string): boolean {
    const r = relative(root, path);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** The part of a glob before its first wildcard, as a folder: what it can reach no further up than. */
function globBase(pattern: string): string {
    const parts = pattern.split(/[\\/]/);
    const fixed: string[] = [];
    for (const part of parts) {
        if (/[*?[\]{}]/.test(part)) break;
        fixed.push(part);
    }
    // A pattern with no wildcard names a file; its folder is what it reaches.
    if (fixed.length === parts.length) fixed.pop();
    return fixed.join('/') || '.';
}

/** Every path a call to a file tool names, absolute, against the folder the run works in. */
function namedPaths(tool: string, input: Record<string, unknown>, cwd: string): string[] {
    const text = (key: string): string | null => {
        const value = input[key];
        return typeof value === 'string' && value.trim() !== '' ? value : null;
    };
    const paths: string[] = [];
    for (const key of ['file_path', 'notebook_path']) {
        const value = text(key);
        if (value) paths.push(resolve(cwd, value));
    }
    const searched = text('path');
    const base = resolve(cwd, searched ?? '.');
    if (searched || SEARCHES.has(tool)) paths.push(base);
    // A glob can climb out of the folder it is searched from, or name another outright.
    const glob = tool === 'Glob' ? text('pattern') : tool === 'Grep' ? text('glob') : null;
    if (glob) paths.push(resolve(base, globBase(glob)));
    return paths;
}

/**
 * The allow rules that let Write and Edit into the write folders. The hook's
 * own "allow" does not: under `dontAsk`, an edit needs a rule. Claude Code spells
 * an absolute path `//c/Users/…` on Windows and `//Users/…` elsewhere and matches
 * it as a gitignore pattern, so each folder gets a rule as it is given and as it
 * really is, its wildcards taken literally. A file named by a Windows short name
 * (`USERNA~1`) matches no rule at all, so a run is to be told its write folders
 * by their full names, as the folder dialog gives them.
 */
export function writeRules(policy: FolderPolicy): string[] {
    const spelled = (dir: string): string => {
        const posix = process.platform === 'win32'
            ? `/${dir.replace(/^([A-Za-z]):/, (_, drive: string) => drive.toLowerCase()).split('\\').join('/')}`
            : dir;
        return `/${posix.replace(/\/+$/, '').replace(/[*?[\]\\]/g, (c) => `\\${c}`)}`;
    };
    const dirs = [...new Set(policy.write.flatMap((dir) => [resolve(dir), real(dir)]))];
    return [...new Set(dirs.map((dir) => `Edit(${spelled(dir)}/**)`))];
}

const decide = (permissionDecision: 'allow' | 'deny', permissionDecisionReason?: string): HookJSONOutput => ({
    hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason},
});

/**
 * The PreToolUse hook that holds a run to `policy`. `alsoRead` are folders it
 * reads whatever the policy says: the skills' plugins, which a skill's own files
 * are read from.
 */
export function folderHook(policy: FolderPolicy, alsoRead: string[]): HookCallback {
    const spell = (dirs: string[]): string[] => [...new Set(dirs.map(real))];
    const write = spell(policy.write);
    const read = spell([...policy.read, ...policy.write, ...alsoRead]);
    const shown = (dirs: string[]): string => (dirs.length > 0 ? dirs.join(', ') : 'none');
    const where = `It may read in ${shown(spell([...policy.read, ...policy.write]))}, and write in ${shown(write)}.`;

    return async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const need = FILE_TOOLS[input.tool_name];
        if (!need) return {};
        const args = typeof input.tool_input === 'object' && input.tool_input !== null
            ? (input.tool_input as Record<string, unknown>)
            : {};
        // Where Claude Code keeps a result too long to hand back whole, for the run to read.
        const own = join(dirname(input.transcript_path), input.session_id);
        for (const path of namedPaths(input.tool_name, args, input.cwd).map(real)) {
            if (need === 'write' && !write.some((root) => inside(path, root))) {
                return decide(
                    'deny',
                    read.some((root) => inside(path, root))
                        ? `${path} is in a folder this step may only read. ${where}`
                        : `${path} is outside this step's folders. ${where}`,
                );
            }
            if (need === 'read' && !read.some((root) => inside(path, root)) && !inside(path, real(own))) {
                return decide('deny', `${path} is outside this step's folders. ${where}`);
            }
        }
        return decide('allow');
    };
}
