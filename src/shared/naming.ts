/** Shared so a dialog previews exactly the file or folder name the store will create. */

/** Long enough to stay readable in a path, short enough not to be the path. */
const MAX = 48;

/**
 * A file or folder name from a flow's or a workspace's name: lowercase, dashed,
 * ASCII. Lowercase because Windows and macOS treat `Invoices` and `invoices` as one.
 */
export function toFolderName(name: string, fallback = 'flow'): string {
    const slug = name
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .toLowerCase()
        .slice(0, MAX)
        .replace(/^-+|-+$/g, '');
    // Everything typed was punctuation, or the name was blank. The caller numbers
    // it if something is already called this.
    return slug || fallback;
}
