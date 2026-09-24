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
import { join, resolve } from 'node:path';
import { flowSkillsDir, flowSkillsDirAt, globalPluginDir, globalSkillsDir } from '../paths';
import { getSettings, saveSettings } from './settingsStore';
import { GLOBAL_SKILL_PLUGIN, type SkillDetail, type SkillScope, type SkillSummary } from '@shared/settings';

/**
 * Two libraries of `<name>/SKILL.md` folders: **global**, shared by every flow and
 * kept in plugin layout so runs can load it from outside their cwd; and **flow**,
 * under one flow's directory and travelling with it. `flowId` is read only for
 * the `flow` scope, and the two may hold the same name without shadowing.
 *
 * The global library can instead be linked to a folder of the user's own, which
 * is then read and written in place.
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

/** The folder the global library is linked to, or '' while it keeps its own. */
export function linkedGlobalFolder(): string {
    return getSettings().globalSkillsPath;
}

function globalLibrary(): string {
    const linked = linkedGlobalFolder();
    if (linked) return linked;
    ensureManifest(globalPluginDir());
    return globalSkillsDir();
}

function libraryDir(scope: SkillScope, flowId: string): string {
    if (scope === 'flow') return flowSkillsDir(flowId);
    const dir = globalLibrary();
    // Writing would recreate the folder — on the wrong drive, if it was a removable one.
    if (!existsSync(dir)) {
        throw new Error(`The global library is linked to ${dir}, which is not there. Restore it, or unlink.`);
    }
    return dir;
}

/** `libraryDir` without creating anything, so reading a deleted flow's skills doesn't recreate its folder. */
function libraryAt(scope: SkillScope, flowId: string): string {
    return scope === 'global' ? globalLibrary() : flowSkillsDirAt(flowId);
}

/**
 * Point the global library at a folder of `<name>/SKILL.md` folders, or back at
 * its own with ''. Its own skills stay in the workspace meanwhile.
 */
export function linkGlobalLibrary(dir: string): SkillSummary[] {
    const target = dir ? resolve(dir) : '';
    if (target) {
        if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`No such folder: ${target}`);
        if (existsSync(join(target, 'SKILL.md'))) {
            throw new Error(`${target} is a skill itself. Link the folder it sits in.`);
        }
    }
    saveSettings({ ...getSettings(), globalSkillsPath: target });
    return listSkills('global', '');
}

/**
 * The plugin a run loads its ticked global skills from. A linked folder is not
 * in plugin layout, so those skills are copied into a temporary one, which also
 * keeps an edit made mid-run out of it. `dispose` removes the copy.
 */
export function globalPluginFor(names: string[]): { path: string; dispose(): void } {
    const linked = linkedGlobalFolder();
    if (!linked) {
        ensureManifest(globalPluginDir());
        return {
            path: globalPluginDir(), dispose: () => {
            }
        };
    }
    const root = mkdtempSync(join(tmpdir(), 'patchbay-skills-'));
    ensureManifest(root);
    for (const name of names) {
        const source = join(linked, name);
        if (!isValidSkillName(name) || !existsSync(join(source, 'SKILL.md'))) continue;
        // Dereferenced, so a link inside a skill is copied as content, not as a way back into the folder.
        cpSync(source, join(root, 'skills', name), { recursive: true, dereference: true });
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
    return join(libraryAt(scope, flowId), name, 'SKILL.md');
}

function summarize(scope: SkillScope, name: string, content: string, file: string): SkillSummary {
    const stat = statSync(file);
    return {
        name,
        scope,
        description: parseFrontmatter(content).description ?? '',
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
    };
}

export function listSkills(scope: SkillScope, flowId: string): SkillSummary[] {
    const dir = libraryAt(scope, flowId);
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

/** Both libraries at once — what the Skills tab and a Processor's list show. */
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
    mkdirSync(join(libraryDir(scope, flowId), name), { recursive: true });
    const file = skillFile(scope, flowId, name);
    writeFileSync(file, content, 'utf8');
    return summarize(scope, name, content, file);
}

export function removeSkill(scope: SkillScope, flowId: string, name: string): void {
    if (!isValidSkillName(name)) return;
    removeTree(join(libraryDir(scope, flowId), name));
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
    const source = join(libraryDir(from, flowId), name);
    if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`There is no skill "${name}" to move.`);

    const target = join(libraryDir(to, flowId), name);
    removeTree(target);
    try {
        renameSync(source, target);
    } catch (e) {
        // A linked global folder can be on another drive, which a rename cannot cross.
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
    const target = libraryDir(scope, flowId);
    const imported: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (only && !only.includes(entry.name)) continue;
        const source = join(dir, entry.name);
        if (!existsSync(join(source, 'SKILL.md'))) continue;
        if (!isValidSkillName(entry.name)) continue;
        cpSync(source, join(target, entry.name), { recursive: true });
        imported.push(entry.name);
    }
    return imported;
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
    // A linked folder is the user's own: seeding would write into it.
    if (linkedGlobalFolder()) return [];
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
