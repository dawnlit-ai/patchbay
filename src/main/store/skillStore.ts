import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { skillsDir } from '../paths';
import type { SkillDetail, SkillSummary } from '@shared/settings';

/**
 * The skill library is a directory of `<name>/SKILL.md` files — the layout the
 * Agent SDK discovers from `cwd/.claude/skills`. Files rather than rows, so a
 * skill edited here, in an editor, or synced from another project all agree.
 */

/** Skill names become directory names and Agent SDK allowlist entries. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSkillName(name: string): boolean {
    return NAME_RE.test(name) && name.length <= 64;
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

function skillFile(name: string): string {
    return join(skillsDir(), name, 'SKILL.md');
}

function summarize(name: string, content: string, file: string): SkillSummary {
    const stat = statSync(file);
    return {
        name,
        description: parseFrontmatter(content).description ?? '',
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
    };
}

export function listSkills(): SkillSummary[] {
    const dir = skillsDir();
    const out: SkillSummary[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(dir, entry.name, 'SKILL.md');
        if (!existsSync(file)) continue;
        out.push(summarize(entry.name, readFileSync(file, 'utf8'), file));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name: string): SkillDetail | null {
    if (!isValidSkillName(name)) return null;
    const file = skillFile(name);
    if (!existsSync(file)) return null;
    const content = readFileSync(file, 'utf8');
    return { ...summarize(name, content, file), content };
}

export function saveSkill(name: string, content: string): SkillSummary {
    if (!isValidSkillName(name)) {
        throw new Error(
            `Invalid skill name "${name}". Use lowercase letters, digits and hyphens — the name becomes both a folder and a Claude skill identifier.`,
        );
    }
    mkdirSync(join(skillsDir(), name), { recursive: true });
    writeFileSync(skillFile(name), content, 'utf8');
    return summarize(name, content, skillFile(name));
}

export function removeSkill(name: string): void {
    if (!isValidSkillName(name)) return;
    rmSync(join(skillsDir(), name), { recursive: true, force: true });
}

/**
 * Copy `<dir>/<skill>/SKILL.md` trees into the library, overwriting a skill of
 * the same name, so re-importing picks up upstream edits.
 */
export function importSkillsFrom(dir: string): string[] {
    if (!existsSync(dir)) throw new Error(`No such folder: ${dir}`);
    const imported: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const source = join(dir, entry.name);
        if (!existsSync(join(source, 'SKILL.md'))) continue;
        if (!isValidSkillName(entry.name)) continue;
        cpSync(source, join(skillsDir(), entry.name), { recursive: true });
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
 * Fill the library on first run, and only on first run. Skills here are the
 * app's own copies — editable without touching whatever they came from — so
 * seeding is a one-time import rather than a link. Returns the names imported.
 */
export function seedSkillLibrary(candidates: string[]): string[] {
    const existing = listSkills();
    // A library holding only the placeholder still counts as unseeded; otherwise
    // one launch before pointing at a real skills folder would lock it in forever.
    const onlyStarter = existing.length === 1 && existing[0]?.name === STARTER_SKILL_NAME;
    if (existing.length > 0 && !onlyStarter) return [];

    for (const dir of candidates) {
        if (!dir.trim() || !existsSync(dir)) continue;
        try {
            const imported = importSkillsFrom(dir);
            if (imported.length > 0) {
                // Real skills supersede the placeholder.
                if (onlyStarter && !imported.includes(STARTER_SKILL_NAME)) removeSkill(STARTER_SKILL_NAME);
                return imported;
            }
        } catch {
            // An unreadable seed folder is not a reason to fail startup — the
            // starter skill below still gives a Processor something to select.
        }
    }

    if (onlyStarter) return [];
    saveSkill(STARTER_SKILL_NAME, STARTER_SKILL);
    return [STARTER_SKILL_NAME];
}
