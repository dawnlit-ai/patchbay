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
import { flowSkillsDir, globalPluginDir, globalSkillsDir } from '../paths';
import { getSettings } from './settingsStore';
import { GLOBAL_SKILL_PLUGIN, type SkillDetail, type SkillScope, type SkillSummary, } from '@shared/settings';

/**
 * Skills live in one of two libraries, both directories of `<name>/SKILL.md`
 * files. Files rather than rows, so a skill edited here, in an editor, or synced
 * from another project all agree.
 *
 * - **global** — shared by every flow in the install, kept in the plugin layout
 *   because that is what lets a run load skills from outside its own working
 *   directory.
 * - **flow** — one flow's own, under that flow's directory, which is the working
 *   directory its nodes run in. Deleted, exported and imported with the flow.
 *
 * Every call names the scope it means; `flowId` is read only when that scope is
 * `flow`, and the two libraries may hold the same name without either shadowing
 * the other.
 */

/** Skill names become directory names and Agent SDK allowlist entries. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSkillName(name: string): boolean {
    return NAME_RE.test(name) && name.length <= 64;
}

/**
 * What makes the global directory a plugin the SDK will load: a manifest beside
 * the `skills` folder. Written on the way past rather than at startup, so it is
 * there however the folder was first reached.
 */
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

interface Frontmatter {
    name?: string;
    description?: string;
}

/**
 * Pull `name` and `description` out of the leading `---` block — enough to list
 * and match a skill without a YAML parser for two scalar fields. Everything else
 * survives on disk, because the file is only ever written back whole.
 */
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
    return join(libraryDir(scope, flowId), name, 'SKILL.md');
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
    const dir = libraryDir(scope, flowId);
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
 * Take a skill out of one library and put it in the other, folder and all — what
 * dragging a row onto the other tab does. Overwrites a skill of the same name
 * there; from here the two are just directories, so the asking is the caller's.
 * The `global:` prefix on a tick moves with it, which the renderer repairs in the
 * flow on screen.
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

/**
 * Copy `<dir>/<skill>/SKILL.md` trees into one library, overwriting a skill of
 * the same name, so re-importing picks up upstream edits.
 */
export function importSkillsFrom(scope: SkillScope, flowId: string, dir: string): string[] {
    if (!existsSync(dir)) throw new Error(`No such folder: ${dir}`);
    const target = libraryDir(scope, flowId);
    const imported: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
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
 * Fill the global library on first run, and only on first run. Flow libraries
 * start bare on purpose: everything a new flow needs is already on the global
 * shelf, and what goes in its own is whatever that flow alone should carry.
 *
 * Candidates in order: the folder named in Settings, then a `skills` directory
 * beside the app, and failing both the starter skill — so a Processor always has
 * something to tick. These are the app's own copies, editable without touching
 * whatever they came from. Returns the names imported.
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
