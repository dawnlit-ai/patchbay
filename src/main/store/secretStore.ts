import { safeStorage } from 'electron';
import { mcpSecretsFile } from '../paths';
import { readJson, writeJson } from './jsonFile';

/**
 * The values a workspace's MCP servers look up — a token, usually — set in the
 * app rather than written into a file the workspace may commit. Each is kept for
 * one server of one workspace, so another server, or the same name in another
 * workspace, never sees it. Each is encrypted with the key the system keeps for
 * Patchbay (the Keychain on macOS, DPAPI on Windows), and read only to start the
 * server it was set for. The windows are told which are set, never what they are.
 */

/** Sealed values, base64, by workspace key, then server, then variable name. */
type SecretFile = Record<string, Record<string, Record<string, string>>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function readAll(): SecretFile {
    const raw = readJson<unknown>(mcpSecretsFile(), {});
    return isObject(raw) ? (raw as SecretFile) : {};
}

/** Which names are set for each of one workspace's servers, without reading any of them. */
export function secretNames(workspace: string): Map<string, Set<string>> {
    const servers = readAll()[workspace];
    return new Map(Object.entries(isObject(servers) ? servers : {}).map(([server, values]) => [
        server,
        new Set(isObject(values) ? Object.keys(values) : []),
    ]));
}

async function seal(value: string): Promise<string> {
    // Linux without a keyring falls back to a key written into Chromium itself,
    // which keeps nothing from anyone who can read the file.
    const weak = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';
    if (weak || !(await safeStorage.isAsyncEncryptionAvailable())) {
        throw new Error(
            'This computer has no keychain Patchbay can keep a secret in. Give the server the value through Patchbay’s environment instead.',
        );
    }
    return (await safeStorage.encryptStringAsync(value)).toString('base64');
}

/** Write one value, or take it away with null. Sealed first, so two set at once both land. */
function store(workspace: string, server: string, name: string, sealed: string | null): void {
    const all = readAll();
    const values = {...all[workspace]?.[server]};
    if (sealed === null) delete values[name];
    else values[name] = sealed;
    const servers = {...all[workspace], [server]: values};
    if (Object.keys(values).length === 0) delete servers[server];
    if (Object.keys(servers).length === 0) delete all[workspace];
    else all[workspace] = servers;
    writeJson(mcpSecretsFile(), all);
}

export async function setSecret(workspace: string, server: string, name: string, value: string | null): Promise<void> {
    store(workspace, server, name, value === null ? null : await seal(value));
}

/** One server's values, opened, to start it with. */
export async function serverSecrets(workspace: string, server: string): Promise<Record<string, string>> {
    const sealed = readAll()[workspace]?.[server];
    const values: Record<string, string> = {};
    for (const [name, text] of Object.entries(isObject(sealed) ? sealed : {})) {
        let opened: Electron.DecryptStringAsyncReturnValue;
        try {
            opened = await safeStorage.decryptStringAsync(Buffer.from(String(text), 'base64'));
        } catch {
            throw new Error(
                `The value set for ${name} on ${server} could not be opened on this computer — set on another one, or under a key the system no longer has. Set it again.`,
            );
        }
        values[name] = opened.result;
        // The system has a newer key: sealed again under it, for next time.
        if (opened.shouldReEncrypt) store(workspace, server, name, await seal(opened.result));
    }
    return values;
}
