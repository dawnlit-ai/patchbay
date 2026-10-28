import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * An app opened from the Finder or the Dock gets launchd's PATH — /usr/bin, /bin,
 * /usr/sbin, /sbin — not a terminal's, so `npx`, `uvx` or `node`, which an MCP
 * server's command usually is, would not be found. Whatever this app starts that
 * starts a server in turn — the server itself to list its tools, or the agent a
 * run hands it to — is given the folders their installers put them in as well.
 */

/** Homebrew's on Apple silicon and on Intel, and where uv's and Claude Code's installers put theirs. */
const installDirs = (): string[] => [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

/**
 * `env` with those folders after the rest of its PATH — its own PATH, else this
 * app's — where it lacks them. Windows' PATH is the user's own already, so there
 * `env` is left as it is.
 */
export function withToolPath<T extends Record<string, string | undefined>>(env: T): T {
    if (process.platform === 'win32') return env;
    const current = (env.PATH ?? process.env.PATH ?? '').split(delimiter).filter(Boolean);
    const missing = installDirs().filter((dir) => !current.includes(dir));
    return missing.length === 0 ? env : {...env, PATH: [...current, ...missing].join(delimiter)};
}
