import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { flowSkillsDir, flowSkillsDirAt, globalPluginDir, globalSkillsDir } from '../paths';
import { getSettings, saveSettings } from './settingsStore';
import {
    GLOBAL_SKILL_PLUGIN,
    type GlobalSkillFolder,
    type SkillDetail,
    type SkillScope,
    type SkillSummary,
} from '@shared/settings';

/**
 * Two libraries of `<name>/SKILL.md` folders: **global**, shared by every flow and
 * kept in plugin layout so runs can load it from outside their cwd; and **flow**,
 * under one flow's directory and travelling with it. `flowId` is read only for
 * the `flow` scope, and the two may hold the same name without shadowing.
 *
 * The global library reads the folders the user linked, read and written in place,
 * then its own in the workspace. The first folder to hold a name has the copy in
 * use; a write goes over that copy, else into the workspace's folder.
 */

/** Skill names become directory names and Agent SDK allowlist entries. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSkillName(name: string): boolean {
    return NAME_RE.test(name) && name.length <= 64;
}

/**
 * A recursive delete that removes a link rather than following it: under Electron,
 * `rmSync` deletes what a junction points at, and a linked folder is the user's own.
 */
function removeTree(path: string): void {
    let stat;
    try {
        stat = lstatSync(path);
    } catch {
        return;
    }
    if (stat.isDirectory()) {
        for (const entry of readdirSync(path)) removeTree(join(path, entry));
        rmdirSync(path);
    } else {
        unlinkSync(path);
    }
}

/** Writes the plugin manifest the SDK needs beside a `skills` folder, if it is missing. */
function ensureManifest(pluginDir: string): void {
    const manifest = join(pluginDir, '.claude-plugin', 'plugin.json');
    if (existsSync(manifest)) return;
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    const content = {
        name: GLOBAL_SKILL_PLUGIN,
        description: 'Skills shared by every flow in this Patchbay workspace.',
    };
    writeFileSync(manifest, JSON.stringify(content, null, 2), 'utf8');
}

/** The global library's folders, highest first: the linked ones, then the workspace's own. */
function globalFolders(): { path: string; workspace: boolean }[] {
    ensureManifest(globalPluginDir());
    return [
        ...getSettings().globalSkillFolders.map((path) => ({ path, workspace: false })),
        { path: globalSkillsDir(), workspace: true },
    ];
}

/** The folder holding the copy of a global skill in use: the first to have one. */
function globalHome(name: string): string | null {
    for (const { path } of globalFolders()) if (existsSync(join(path, name, 'SKILL.md'))) return path;
    return null;
}

/** Where a skill of this name is written: over the copy in use, else into the workspace. */
function writeDir(scope: SkillScope, flowId: string, name: string): string {
    if (scope === 'flow') return flowSkillsDir(flowId);
    return globalHome(name) ?? globalSkillsDir();
}

/** Where a skill is read from, without creating anything, so reading a deleted flow's skills doesn't recreate its folder. */
function readDir(scope: SkillScope, flowId: string, name: string): string {
    return scope === 'global' ? (globalHome(name) ?? globalSkillsDir()) : flowSkillsDirAt(flowId);
}

/** Every folder the global library reads, with what each holds — what Settings lists. */
export function globalShelf(): GlobalSkillFolder[] {
    const taken = new Set<string>();
    return globalFolders().map(({ path, workspace }) => {
        const missing = !existsSync(path);
        const skills = missing
            ? []
            : readLibrary('global', path).map((skill) => ({ ...skill, shadowed: taken.has(skill.name) }));
        for (const skill of skills) taken.add(skill.name);
        return { path, workspace, missing, skills };
    });
}

/**
 * Replace the folders linked into the global library, highest first. A folder
 * already linked may be missing, so an unplugged drive can still be moved down or
 * unlinked; one being linked has to be there.
 */
export function setGlobalFolders(paths: string[]): GlobalSkillFolder[] {
    const current = new Set(getSettings().globalSkillFolders);
    const own = resolve(globalSkillsDir());
    const seen = new Set<string>();
    const next = paths.map((path) => {
        const target = resolve(path);
        if (!current.has(target)) {
            if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`No such folder: ${target}`);
            if (existsSync(join(target, 'SKILL.md'))) {
                throw new Error(`${target} is a skill itself. Link the folder it sits in.`);
            }
        }
        if (target === own) throw new Error(`${target} is the workspace's own library, which is always read.`);
        if (seen.has(target)) throw new Error(`${target} is linked twice.`);
        seen.add(target);
        return target;
    });
    saveSettings({ ...getSettings(), globalSkillFolders: next });
    return globalShelf();
}

/** Where to show a folder the library reads. Anything else is refused, so a window cannot open arbitrary paths. */
export function globalFolderPath(path: string): string {
    const folder = globalFolders().find((f) => f.path === path);
    if (!folder) throw new Error(`${path} is not one of the global library's folders.`);
    return folder.path;
}

/**
 * The plugin a run loads its ticked global skills from. Only the workspace's own
 * folder is in plugin layout, so while any folder is linked the ticked skills are
 * copied into a temporary one, which also keeps an edit made mid-run out of it.
 * `dispose` removes the copy.
 */
export function globalPluginFor(names: string[]): { path: string; dispose(): void } {
    if (getSettings().globalSkillFolders.length === 0) {
        ensureManifest(globalPluginDir());
        return {
            path: globalPluginDir(), dispose: () => {
            }
        };
    }
    const root = mkdtempSync(join(tmpdir(), 'patchbay-skills-'));
    ensureManifest(root);
    for (const name of names) {
        const home = isValidSkillName(name) ? globalHome(name) : null;
        if (!home) continue;
        // Dereferenced, so a link inside a skill is copied as content, not as a way back into the folder.
        cpSync(join(home, name), join(root, 'skills', name), { recursive: true, dereference: true });
    }
    const dispose = (): void => {
        try {
            removeTree(root);
        } catch {
            // A copy left in the temp folder is harmless; failing a finished run over it is not.
        }
    };
    return { path: root, dispose };
}

interface Frontmatter {
    name?: string;
    description?: string;
}

/** Reads `name` and `description` from the frontmatter, without a YAML parser. */
export function parseFrontmatter(content: string): Frontmatter {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!match?.[1]) return {};
    const out: Frontmatter = {};
    for (const line of match[1].split(/\r?\n/)) {
        const kv = /^(name|description):\s*(.*)$/.exec(line);
        if (!kv?.[1]) continue;
        let value = (kv[2] ?? '').trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (kv[1] === 'name') out.name = value;
        else out.description = value;
    }
    return out;
}

function skillFile(scope: SkillScope, flowId: string, name: string): string {
    return join(readDir(scope, flowId, name), name, 'SKILL.md');
}

function summarize(scope: SkillScope, name: string, content: string, file: string): SkillSummary {
    const stat = statSync(file);
    return {
        name,
        scope,
        description: parseFrontmatter(content).description ?? '',
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        folder: dirname(dirname(file)),
    };
}

/** The skills in one folder, by name. */
function readLibrary(scope: SkillScope, dir: string): SkillSummary[] {
    if (!existsSync(dir)) return [];
    const out: SkillSummary[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(dir, entry.name, 'SKILL.md');
        if (!existsSync(file)) continue;
        out.push(summarize(scope, entry.name, readFileSync(file, 'utf8'), file));
    }
    return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** A library's skills. The global one gives each name once, the copy in use. */
export function listSkills(scope: SkillScope, flowId: string): SkillSummary[] {
    if (scope === 'flow') return readLibrary(scope, flowSkillsDirAt(flowId));
    return globalShelf()
        .flatMap((folder) => folder.skills.filter((skill) => !skill.shadowed))
        .map(({ shadowed: _, ...skill }) => skill)
        .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Both libraries at once — what the inspector's skill list shows. */
export function listAllSkills(flowId: string): SkillSummary[] {
    return [...listSkills('global', flowId), ...listSkills('flow', flowId)];
}

export function getSkill(scope: SkillScope, flowId: string, name: string): SkillDetail | null {
    if (!isValidSkillName(name)) return null;
    const file = skillFile(scope, flowId, name);
    if (!existsSync(file)) return null;
    const content = readFileSync(file, 'utf8');
    return { ...summarize(scope, name, content, file), content };
}

export function saveSkill(
    scope: SkillScope,
    flowId: string,
    name: string,
    content: string,
): SkillSummary {
    if (!isValidSkillName(name)) {
        throw new Error(
            `Invalid skill name "${name}". Use lowercase letters, digits and hyphens — the name becomes both a folder and a Claude skill identifier.`,
        );
    }
    mkdirSync(join(writeDir(scope, flowId, name), name), { recursive: true });
    const file = skillFile(scope, flowId, name);
    writeFileSync(file, content, 'utf8');
    return summarize(scope, name, content, file);
}

export function removeSkill(scope: SkillScope, flowId: string, name: string): void {
    if (!isValidSkillName(name)) return;
    // Only the copy in use: one of the same name in a folder further down takes over.
    removeTree(join(writeDir(scope, flowId, name), name));
}

/**
 * Move a skill folder to the other library, overwriting one of the same name
 * there; confirming that is the caller's job. Re-pointing ticks is too.
 */
export function moveSkill(
    from: SkillScope,
    to: SkillScope,
    flowId: string,
    name: string,
): SkillSummary {
    if (!isValidSkillName(name)) throw new Error(`Invalid skill name "${name}".`);
    if (from === to) throw new Error(`"${name}" is already in that library.`);
    const source = join(readDir(from, flowId, name), name);
    if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`There is no skill "${name}" to move.`);

    const target = join(writeDir(to, flowId, name), name);
    removeTree(target);
    try {
        renameSync(source, target);
    } catch (e) {
        // A global folder can be on another drive, which a rename cannot cross.
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        cpSync(source, target, { recursive: true });
        removeTree(source);
    }

    const file = join(target, 'SKILL.md');
    return summarize(to, name, readFileSync(file, 'utf8'), file);
}

/** Copy `<dir>/<skill>/SKILL.md` folders into a library, overwriting same-named skills. `only` limits it to those. */
export function importSkillsFrom(scope: SkillScope, flowId: string, dir: string, only?: string[]): string[] {
    if (!existsSync(dir)) throw new Error(`No such folder: ${dir}`);
    const imported: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (only && !only.includes(entry.name)) continue;
        const source = join(dir, entry.name);
        if (!existsSync(join(source, 'SKILL.md'))) continue;
        if (!isValidSkillName(entry.name)) continue;
        cpSync(source, join(writeDir(scope, flowId, entry.name), entry.name), { recursive: true });
        imported.push(entry.name);
    }
    return imported;
}

/**
 * Import skills from picked `.md` files, overwriting same-named skills. A `SKILL.md`
 * brings its whole folder, scripts and references included, named after that
 * folder; any other `.md` becomes a skill of that one file. Either falls back to
 * the frontmatter `name` when the folder or file name is not a valid skill name.
 */
export function importSkillFiles(
    scope: SkillScope,
    flowId: string,
    files: string[],
): { imported: string[]; skipped: string[] } {
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
        const content = readFileSync(file, 'utf8');
        const whole = basename(file) === 'SKILL.md';
        const own = whole ? basename(dirname(file)) : basename(file, extname(file)).toLowerCase();
        const name = isValidSkillName(own) ? own : parseFrontmatter(content).name;
        if (!name || !isValidSkillName(name)) {
            skipped.push(`${file} (no usable name: give it a lowercase-and-hyphens name in its frontmatter)`);
            continue;
        }
        if (!whole) {
            saveSkill(scope, flowId, name, content);
        } else {
            const source = resolve(dirname(file));
            const target = resolve(join(writeDir(scope, flowId, name), name));
            if (source === target) {
                skipped.push(`${name} (already in the library)`);
                continue;
            }
            cpSync(source, target, { recursive: true });
        }
        imported.push(name);
    }
    return { imported, skipped };
}

const STARTER_SKILL_NAME = 'summarize-and-file';

const STARTER_SKILL = `---
name: summarize-and-file
description: Read an email end to end and write a short structured summary of what it asks for, who it is from, and what a human would need to do next. Use as a starting point for your own skills.
---

# Summarize and file

You are handling exactly one email. The tools under \`mcp__email__\` are scoped to
that email — you cannot reach any other message.

## Steps

1. Call \`read_email\` to get the full body. The preview in the prompt is not enough.
2. If there are attachments and you are allowed to save them, call
   \`save_attachment\` for the ones that matter and read what you saved.
3. Write a summary covering:
   - **From** — who sent it, and which company they act for.
   - **Asks** — what they want, as a short list.
   - **Deadline** — any date or time pressure stated or implied.
   - **Next action** — the single thing a person should do next.
4. Call \`record_note\` with that summary so it lands in the run trace.

## Rules

- Never invent a fact that is not in the email or an attachment you read.
- If the email is unclear about what it wants, say so plainly in the summary
  rather than guessing.
- You do not send anything. Drafting a reply is only available when the node
  enables it, and even then a draft is left in Outlook for a human to send.
`;

/**
 * Fill an empty global library from the folder named in Settings, else a `skills`
 * directory beside the app, else the starter skill, so a Processor always has
 * something to tick. Returns the names imported.
 */
export function seedGlobalLibrary(): string[] {
    const existing = listSkills('global', '');
    // A library holding only the placeholder still counts as unseeded; otherwise
    // one launch before pointing at a real skills folder would lock it in forever.
    const onlyStarter = existing.length === 1 && existing[0]?.name === STARTER_SKILL_NAME;
    if (existing.length > 0 && !onlyStarter) return [];

    for (const dir of [getSettings().skillSeedPath, join(process.cwd(), 'skills')]) {
        if (!dir.trim() || !existsSync(dir)) continue;
        try {
            const imported = importSkillsFrom('global', '', dir);
            if (imported.length > 0) {
                // Real skills supersede the placeholder.
                if (onlyStarter && !imported.includes(STARTER_SKILL_NAME)) {
                    removeSkill('global', '', STARTER_SKILL_NAME);
                }
                return imported;
            }
        } catch {
            // An unreadable seed folder is not a reason to fail startup — the
            // starter skill below still gives a Processor something to select.
        }
    }

    if (onlyStarter) return [];
    saveSkill('global', '', STARTER_SKILL_NAME, STARTER_SKILL);
    return [STARTER_SKILL_NAME];
}
