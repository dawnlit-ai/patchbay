import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { skillsDir, skillsDirAt } from '../paths';
import { EMAIL_SERVER_NAME, type SkillDetail, type SkillSummary } from '@shared/settings';

/**
 * The open workspace's library: `skills/<name>/SKILL.md` folders, shared by
 * every flow in the workspace. A node ticks a skill by its name.
 */

/** Skill names become directory names and Agent SDK allowlist entries. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function isValidSkillName(name: string): boolean {
    return NAME_RE.test(name) && name.length <= 64;
}

/**
 * A recursive delete that removes a link rather than following it: under Electron,
 * `rmSync` deletes what a junction points at, and a skill may link to the user's own.
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

/** The plugin name the library reaches Claude under: a run's ticked skills are `workspace:<name>` to it. */
export const SKILL_PLUGIN = 'workspace';

/** Writes the plugin manifest the SDK needs beside a `skills` folder. */
function writeManifest(pluginDir: string): void {
    mkdirSync(join(pluginDir, '.claude-plugin'), {recursive: true});
    const content = {name: SKILL_PLUGIN, description: 'Skills shared by every flow in this Patchbay workspace.'};
    writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify(content, null, 2), 'utf8');
}

/**
 * The plugin a run loads its skills from: every skill in the workspace, so a
 * step can use any of them, and the only skills it gets. The workspace's
 * `skills` folder is not in plugin layout, and writing a manifest into the
 * user's folder is not the app's place, so the skills are copied into a
 * temporary one — which also keeps an edit made mid-run out of it. Null when the
 * workspace has none. `dispose` removes the copy.
 */
export function workspaceSkillPlugin(): { path: string; names: string[]; dispose(): void } | null {
    const names = listSkills()
        .map((skill) => skill.name)
        .filter(isValidSkillName);
    if (names.length === 0) return null;
    const root = mkdtempSync(join(tmpdir(), 'patchbay-skills-'));
    writeManifest(root);
    for (const name of names) {
        // Dereferenced, so a link inside a skill is copied as content, not as a way back into the folder.
        cpSync(join(skillsDirAt(), name), join(root, 'skills', name), {recursive: true, dereference: true});
        // The agent would grant a skill's `allowed-tools` itself on loading it, ticked
        // or not, and built-in tools too. Patchbay grants them, from ticked skills alone.
        const file = join(root, 'skills', name, 'SKILL.md');
        const content = readFileSync(file, 'utf8');
        const stripped = withoutAllowedTools(content);
        if (stripped !== content) writeFileSync(file, stripped, 'utf8');
    }
    const dispose = (): void => {
        try {
            removeTree(root);
        } catch {
            // A copy left in the temp folder is harmless; failing a finished run over it is not.
        }
    };
    return {path: root, names, dispose};
}

interface Frontmatter {
    name?: string;
    description?: string;
}

/** Reads `name` and `description` from the frontmatter, without a YAML parser. */
export function parseFrontmatter(content: string): Frontmatter {
    const block = frontmatterBlock(content);
    if (!block) return {};
    const out: Frontmatter = {};
    for (const line of block.text.split(/\r?\n/)) {
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

const ALLOWED_TOOLS_KEY = 'allowed-tools:';

/** The frontmatter between its `---` lines, and where it sits in the file. */
function frontmatterBlock(content: string): { start: number; text: string } | null {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (match?.[1] === undefined) return null;
    // Anchored at the opening `---`, so the block starts on the line after it.
    return {start: content.indexOf('\n') + 1, text: match[1]};
}

/**
 * The lines `allowed-tools` takes up in the frontmatter's: its own, and the
 * indented or blank ones after it that a list goes on in. Null without one.
 */
function allowedToolsLines(lines: string[]): { at: number; end: number } | null {
    const at = lines.findIndex((line) => line.startsWith(ALLOWED_TOOLS_KEY));
    if (at < 0) return null;
    let end = at + 1;
    while (end < lines.length && (lines[end]!.trim() === '' || /^\s/.test(lines[end]!))) end++;
    return {at, end};
}

/** One list's entries, split at commas and spaces outside brackets, so `Bash(git add:*)` stays whole. */
function toolEntries(text: string): string[] {
    const out: string[] = [];
    let entry = '';
    let depth = 0;
    const flush = (): void => {
        const bare = entry.trim().replace(/^(["'])(.*)\1$/, '$2');
        if (bare) out.push(bare);
        entry = '';
    };
    for (const ch of text) {
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        if (depth === 0 && (ch === ',' || /\s/.test(ch))) flush();
        else entry += ch;
    }
    flush();
    return out;
}

/**
 * What `allowed-tools` lists, written as Claude Code takes it: on its own line
 * with commas or spaces between, in `[…]`, or one per `- ` line under it.
 */
function allowedToolsEntries(frontmatter: string): string[] {
    const lines = frontmatter.split(/\r?\n/);
    const span = allowedToolsLines(lines);
    if (!span) return [];
    let inline = lines[span.at]!.slice(ALLOWED_TOOLS_KEY.length).trim();
    if (inline.startsWith('[') && inline.endsWith(']')) inline = inline.slice(1, -1);
    if (inline !== '') return toolEntries(inline);
    return lines
        .slice(span.at + 1, span.end)
        .flatMap((line) => {
            const item = /^\s+-\s*(.*)$/.exec(line);
            return item ? toolEntries(item[1] ?? '') : [];
        });
}

/** A workspace server's tool, or all of one's, as a node ticks it: `mcp__crm__lookup`, `mcp__crm`. */
const SERVER_TOOL = /^mcp__[A-Za-z0-9_-]+$/;

/**
 * A skill's `allowed-tools`, split into the workspace server tools a node that
 * ticks it is handed — `mcp__<server>__*` taken as `mcp__<server>` — and the
 * rest, which a skill does not grant: built-in tools, and the email's own.
 */
export function skillTools(content: string): { tools: string[]; ungranted: string[] } {
    const tools: string[] = [];
    const ungranted: string[] = [];
    const block = frontmatterBlock(content);
    for (const entry of block ? allowedToolsEntries(block.text) : []) {
        const tool = entry.endsWith('__*') ? entry.slice(0, -'__*'.length) : entry;
        const own = tool === `mcp__${EMAIL_SERVER_NAME}` || tool.startsWith(`mcp__${EMAIL_SERVER_NAME}__`);
        const list = SERVER_TOOL.test(tool) && !own ? tools : ungranted;
        const kept = list === tools ? tool : entry;
        if (!list.includes(kept)) list.push(kept);
    }
    return {tools, ungranted};
}

/** The SKILL.md with no `allowed-tools`, as a run gets it. Unchanged when it has none. */
export function withoutAllowedTools(content: string): string {
    const block = frontmatterBlock(content);
    if (!block) return content;
    const eol = block.text.includes('\r\n') ? '\r\n' : '\n';
    const lines = block.text.split(/\r?\n/);
    const span = allowedToolsLines(lines);
    if (!span) return content;
    const kept = [...lines.slice(0, span.at), ...lines.slice(span.end)].join(eol);
    return content.slice(0, block.start) + kept + content.slice(block.start + block.text.length);
}

/** Read from where it is, without creating anything, so asking after a skill never makes the library's folder. */
function skillFile(name: string): string {
    return join(skillsDirAt(), name, 'SKILL.md');
}

function summarize(name: string, content: string, file: string): SkillSummary {
    const stat = statSync(file);
    return {
        name,
        description: parseFrontmatter(content).description ?? '',
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        ...skillTools(content),
    };
}

/**
 * The library's skills, by name. One deleted or unreadable mid-list is left out
 * rather than failing the list.
 */
export function listSkills(): SkillSummary[] {
    const dir = skillsDirAt();
    let entries;
    try {
        entries = readdirSync(dir, {withFileTypes: true});
    } catch {
        return [];
    }
    const out: SkillSummary[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const file = join(dir, entry.name, 'SKILL.md');
        try {
            out.push(summarize(entry.name, readFileSync(file, 'utf8'), file));
        } catch {
            // No SKILL.md, or it went between the listing and the read.
        }
    }
    return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name: string): SkillDetail | null {
    if (!isValidSkillName(name)) return null;
    const file = skillFile(name);
    if (!existsSync(file)) return null;
    const content = readFileSync(file, 'utf8');
    return {...summarize(name, content, file), content};
}

/**
 * The SKILL.md, for opening in another app. The list it was picked from can be
 * behind the disk, so a skill gone since is refused by name.
 */
export function locateSkill(name: string): string {
    const file = isValidSkillName(name) ? skillFile(name) : null;
    if (!file || !existsSync(file)) {
        throw new Error(`“${name}” is no longer in this workspace. It was deleted or renamed outside the app.`);
    }
    return file;
}

/** Write a new skill. Refused when the library already has one of that name. */
export function createSkill(name: string, content: string): SkillSummary {
    if (isValidSkillName(name) && existsSync(skillFile(name))) {
        throw new Error(`This workspace already has a “${name}”. Pick another name, or edit that one.`);
    }
    return saveSkill(name, content);
}

/**
 * The ticks naming a skill the library does not have — deleted or renamed since
 * the node ticked it. A run checks before it starts.
 */
export function missingSkills(names: string[]): string[] {
    return names.filter((name) => !isValidSkillName(name) || !existsSync(skillFile(name)));
}

export function saveSkill(name: string, content: string): SkillSummary {
    if (!isValidSkillName(name)) {
        throw new Error(
            `Invalid skill name "${name}". Use lowercase letters, digits and hyphens — the name becomes both a folder and a Claude skill identifier.`,
        );
    }
    mkdirSync(join(skillsDir(), name), {recursive: true});
    const file = skillFile(name);
    writeFileSync(file, content, 'utf8');
    return summarize(name, content, file);
}

/** Windows refuses to rename or delete a folder while another app has a file in it open. Says so, not EBUSY. */
function heldOpen(e: unknown, name: string, doing: string): unknown {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EBUSY' && !(code === 'EPERM' && process.platform === 'win32')) return e;
    return new Error(`Could not ${doing} “${name}”: another app has a file in its folder open. Close it there and try again.`);
}

export function removeSkill(name: string): void {
    if (!isValidSkillName(name)) return;
    try {
        removeTree(join(skillsDirAt(), name));
    } catch (e) {
        throw heldOpen(e, name, 'delete');
    }
}

/** Copy `<dir>/<skill>/SKILL.md` folders into the library, overwriting same-named skills. `only` limits it to those. */
export function importSkillsFrom(dir: string, only?: string[]): string[] {
    if (!existsSync(dir)) throw new Error(`No such folder: ${dir}`);
    const imported: string[] = [];
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        if (!entry.isDirectory()) continue;
        if (only && !only.includes(entry.name)) continue;
        const source = join(dir, entry.name);
        if (!existsSync(join(source, 'SKILL.md'))) continue;
        if (!isValidSkillName(entry.name)) continue;
        cpSync(source, join(skillsDir(), entry.name), {recursive: true});
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
export function importSkillFiles(files: string[]): { imported: string[]; skipped: string[] } {
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
            saveSkill(name, content);
        } else {
            const source = resolve(dirname(file));
            const target = resolve(join(skillsDir(), name));
            if (source === target) {
                skipped.push(`${name} (already in the library)`);
                continue;
            }
            cpSync(source, target, {recursive: true});
        }
        imported.push(name);
    }
    return {imported, skipped};
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
- You do not draft, send or move mail: the steps after this one do.
`;

/** Give a new workspace's library its first skill, so a Processor has something to tick. */
export function seedStarterSkill(): void {
    saveSkill(STARTER_SKILL_NAME, STARTER_SKILL);
}
