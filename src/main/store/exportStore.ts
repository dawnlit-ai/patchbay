import { readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { workspaceRoot } from '../paths';
import { zip, type ZipEntry } from '../zip';
import { startingPoints } from './mcpStore';
import { readmeFile } from './workspaceStore';
import { WORKSPACE_MCP_FILES } from '@shared/settings';

/**
 * The open workspace as one zip, to hand to someone who opens it in Patchbay:
 * what Patchbay reads in it — its flows, skills and schemas, its MCP server files
 * and its README — and nothing else of a folder that may be a whole repository,
 * but for a file a server it hands out starts. A file the workspace keeps in
 * `.patchbay/export/` goes in place of its namesake, so a workspace whose servers
 * run from source here can hand out ones that start an installed copy. What has
 * been allowed, the values set for servers, and the runs are this machine's, kept
 * in the app's data, and stay here.
 */

/** Where a workspace keeps the files its export carries in place of its own. */
export const EXPORT_OVERLAY = '.patchbay/export';

const FOLDERS = ['flows', 'skills', 'schemas'];

/** The Finder's and Explorer's own files, which nobody is meant to receive. */
const JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * Never handed out because a server names it: a file of secrets, or one inside
 * what a package manager or git keeps, which would arrive without the rest.
 */
const withheld = (path: string): boolean => {
    const parts = path.split('/');
    return parts.some((p) => p === 'node_modules' || p === '.git') || /^\.env(\.|$)/i.test(parts.at(-1) ?? '');
};

const isFile = (path: string): boolean => {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
};

/** Every file below `dir`, by its path from there with `/` between folders. A link is followed, each folder once. */
function filesBelow(dir: string, seen = new Set<string>(), prefix = ''): { path: string; from: string }[] {
    let real: string;
    try {
        real = realpathSync(dir);
    } catch {
        return [];
    }
    if (seen.has(real) || !statSync(real).isDirectory()) return [];
    seen.add(real);
    const found: { path: string; from: string }[] = [];
    for (const name of readdirSync(dir).sort()) {
        if (JUNK.has(name.toLowerCase())) continue;
        const from = join(dir, name);
        if (isFile(from)) found.push({path: prefix + name, from});
        else found.push(...filesBelow(from, seen, `${prefix}${name}/`));
    }
    return found;
}

/**
 * What the export holds, by its path in the workspace with `/` between folders,
 * and the file each is read from.
 */
function contents(root: string): Map<string, string> {
    const files = new Map<string, string>();
    /** Each path held, by its lower case: a Mac or Windows unzips two spelled the same but for case over each other. */
    const spelled = new Map<string, string>();
    /** Put one in, in place of any spelled the same but for case. */
    const put = (path: string, from: string): void => {
        const held = spelled.get(path.toLowerCase());
        if (held !== undefined) files.delete(held);
        spelled.set(path.toLowerCase(), path);
        files.set(path, from);
    };
    const holds = (path: string): boolean => spelled.has(path.toLowerCase());

    for (const folder of FOLDERS) {
        for (const file of filesBelow(join(root, folder))) put(`${folder}/${file.path}`, file.from);
    }
    for (const file of WORKSPACE_MCP_FILES) if (isFile(join(root, file))) put(file, join(root, file));
    const readme = readmeFile();
    if (readme) put(basename(readme), readme);
    for (const file of filesBelow(join(root, EXPORT_OVERLAY))) put(file.path, file.from);

    // The files the servers handed out start, as their definitions in the export name them.
    for (const serverFile of WORKSPACE_MCP_FILES) {
        const from = files.get(serverFile);
        if (!from) continue;
        for (const {cwd, texts} of startingPoints(serverFile, readFileSync(from, 'utf8'), root)) {
            // An argument may be a whole path or a flag's value: `--config=settings.json`.
            const named = texts.flatMap((text) => (text.includes('=') ? [text, text.slice(text.indexOf('=') + 1)] : [text]));
            for (const text of named) {
                if (!text) continue;
                const target = resolve(cwd, text);
                const inside = relative(root, target);
                if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
                const path = inside.split(sep).join('/');
                if (!holds(path) && !withheld(path) && isFile(target)) put(path, target);
            }
        }
    }
    return files;
}

/**
 * Write the open workspace's export to `to`, as a zip of one folder named after
 * the workspace's own, so unzipping it gives the same folder each time. Written
 * beside it first, so a failure never leaves half a zip over an older one.
 */
export function exportWorkspace(to: string): string {
    const root = workspaceRoot();
    const folder = basename(root);
    const entries: ZipEntry[] = [...contents(root)]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, from]) => {
            const stat = statSync(from);
            return {name: `${folder}/${path}`, data: readFileSync(from), modified: stat.mtime, mode: stat.mode};
        });
    const target = resolve(to);
    const partial = join(dirname(target), `.${basename(target)}.${process.pid}.part`);
    try {
        writeFileSync(partial, zip(entries));
        renameSync(partial, target);
    } finally {
        rmSync(partial, {force: true});
    }
    return target;
}
