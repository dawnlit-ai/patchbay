/**
 * Turning what a person typed into a name a filesystem will take. Shared because
 * the dialog has to show the folder it is about to create while it is being
 * typed, and the store has to arrive at the same answer when it creates it.
 */

/** Long enough to stay readable in a path, short enough not to be the path. */
const MAX = 48;

/**
 * A directory name from a flow name: lowercase, dashed, ASCII. It is a path
 * segment on three operating systems rather than a title, and two of them treat
 * `Pre-Alerts` and `pre-alerts` as the same folder — so the case goes, and what
 * is left is what both the app and the file manager agree the folder is called.
 */
export function toFolderName(name: string): string {
    const slug = name
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .toLowerCase()
        .slice(0, MAX)
        .replace(/^-+|-+$/g, '');
    // Everything typed was punctuation, or the name was blank. The caller numbers
    // it if something is already called this.
    return slug || 'flow';
}
