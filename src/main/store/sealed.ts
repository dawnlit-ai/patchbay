import { safeStorage } from 'electron';

/**
 * A value sealed with the key the system keeps for Patchbay — the Keychain on
 * macOS, DPAPI on Windows — as base64, for a file that should never hold it in
 * the clear. `otherwise` says what to do instead where there is no such key.
 */
export async function seal(value: string, otherwise: string): Promise<string> {
    // Linux without a keyring falls back to a key written into Chromium itself,
    // which keeps nothing from anyone who can read the file.
    const weak = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';
    if (weak || !(await safeStorage.isAsyncEncryptionAvailable())) {
        throw new Error(`This computer has no keychain Patchbay can keep a secret in. ${otherwise}`);
    }
    return (await safeStorage.encryptStringAsync(value)).toString('base64');
}

/**
 * A sealed value, opened. `reseal` is set when the system has a newer key, for
 * the value to be sealed again under it. Throws when it cannot be opened here.
 */
export async function unseal(sealed: string): Promise<{ value: string; reseal: boolean }> {
    const opened = await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'));
    return {value: opened.result, reseal: opened.shouldReEncrypt};
}
