import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { flowSkillsDir, flowSkillsDirAt, globalPluginDir, globalSkillsDir } from '../paths';
import { getSettings } from './settingsStore';
import { GLOBAL_SKILL_PLUGIN, type SkillDetail, type SkillScope, type SkillSummary } from '@shared/settings';

/**
 * Two libraries of `<name>/SKILL.md` folders: **global**, shared by every flow and
 * kept in plugin layout so runs can load it from outside their cwd; and **flow**,
 * under one flow's directory and travelling with it. `flowId` is read only for
 * the `flow` scope, and the two may hold the same name without shadowing.
 */

/** Skill names become directory names and Agent SDK allowlist entries. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSkillName(name: string): boolean {
    return NAME_RE.test(name) && name.length <= 64;
}

/** Writes the plugin manifest the SDK needs beside the global `skills` folder, if it is missing. */
function ensureGlobalPlugin(): string {
    const manifest = join(globalPluginDir(), '.claude-plugin', 'plugin.json');
    if (!existsSync(manifest)) {
        mkdirSync(join(globalPluginDir(), '.claude-plugin'), { recursive: true });
        const content = {
            name: GLOBAL_SKILL_PLUGIN,
            description: 'Skills shared by every flow in this Patchbay workspace.',
        };
        writeFileSync(manifest, JSON.stringify(content, null, 2), 'utf8');
    }
    return globalSkillsDir();
}

function libraryDir(scope: SkillScope, flowId: string): string {
    return scope === 'global' ? ensureGlobalPlugin() : flowSkillsDir(flowId);
}

/** `libraryDir` without creating anything, so reading a deleted flow's skills doesn't recreate its folder. */
function libraryAt(scope: SkillScope, flowId: string): string {
    return scope === 'global' ? ensureGlobalPlugin() : flowSkillsDirAt(flowId);
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
    rmSync(join(libraryDir(scope, flowId), name), { recursive: true, force: true });
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
    rmSync(target, { recursive: true, force: true });
    renameSync(source, target);

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
