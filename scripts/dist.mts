/**
 * Hands the app `electron-forge package` built for this machine to Velopack, which
 * makes the portable zip people download and the packages installed copies update
 * themselves from, in out/releases.
 *
 *   node scripts/dist.mts                    pack only
 *   node scripts/dist.mts --publish <tag>    fetch the last release for a delta, pack,
 *                                            then add it all to the GitHub release <tag>
 *   node scripts/dist.mts --arch arm64       pack the build for another architecture,
 *                                            which `electron-forge package --arch=arm64`
 *                                            made; x64 or arm64, with either of the above
 *
 * The channel follows the version: `0.2.0` goes out on `<os>-<arch>`, and
 * `0.2.0-nightly.<stamp>` on `<os>-<arch>-nightly` — the names the app asks for.
 *
 * Environment:
 *   VPK                     the vpk tool, if not on PATH; a .dll runs through dotnet
 *   GITHUB_TOKEN            for --publish: reads drafts and uploads
 *   GITHUB_REPOSITORY       owner/name to publish to (default dawnlit-ai/patchbay)
 *   PATCHBAY_SIGN_IDENTITY  macOS: the certificate to sign with (name or SHA-1)
 *   PATCHBAY_KEYCHAIN       macOS: the keychain holding it
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const {version} = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const nightly = version.includes('-nightly');

const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'osx' : null;
if (!os) throw new Error(`There are no Patchbay releases for ${process.platform}.`);
const archAt = process.argv.indexOf('--arch');
const arch = archAt >= 0 ? process.argv[archAt + 1] : process.arch;
// The two the app asks for an update channel by (src/main/updates.ts).
if (arch !== 'x64' && arch !== 'arm64') throw new Error(`There are no Patchbay releases for ${arch}; --arch takes x64 or arm64.`);
const rid = `${os}-${arch}`;
const channel = nightly ? `${rid}-nightly` : rid;

const packDir =
    os === 'win'
        ? join(root, 'out', `Patchbay-win32-${arch}`)
        : join(root, 'out', `Patchbay-darwin-${arch}`, 'Patchbay.app');
if (!existsSync(packDir)) throw new Error(`Nothing at ${packDir}. Run electron-forge package --arch=${arch} first.`);
const releases = join(root, 'out', 'releases');

const tagAt = process.argv.indexOf('--publish');
const tag = tagAt >= 0 ? process.argv[tagAt + 1] : undefined;
if (tagAt >= 0 && !tag) throw new Error('--publish needs the tag of the release to add to.');
const token = process.env.GITHUB_TOKEN;
if (tag && !token) throw new Error('--publish needs GITHUB_TOKEN.');
const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY ?? 'dawnlit-ai/patchbay'}`;

function vpk(args: string[], allowFailure = false): void {
    const tool = process.env.VPK ?? 'vpk';
    const [command, ...rest] = tool.endsWith('.dll') ? ['dotnet', tool] : [tool];
    // Without a console of its own, vpk draws no progress bars into the log.
    const result = spawnSync(command!, [...rest, '--legacyConsole', ...args], {stdio: 'inherit'});
    if (result.status === 0) return;
    if (allowFailure) return;
    throw new Error(`vpk ${args[0]} failed${result.error ? `: ${result.error.message}` : ''}.`);
}

console.log(`Patchbay ${version} for ${rid}, on the ${channel} channel`);

if (tag) {
    // The newest release on this channel, so the new one carries a delta from it.
    // The first release on a channel has none to fetch.
    vpk(
        ['download', 'github', '--repoUrl', repoUrl, '--token', token!, '--channel', channel, '--outputDir', releases,
            ...(nightly ? ['--pre'] : [])],
        true,
    );
}

const signing: string[] = [];
const identity = process.env.PATCHBAY_SIGN_IDENTITY;
if (os === 'osx' && identity) {
    signing.push('--signAppIdentity', identity);
    if (process.env.PATCHBAY_KEYCHAIN) signing.push('--keychain', process.env.PATCHBAY_KEYCHAIN);
} else if (os === 'osx') {
    console.warn(
        'Not signed: fine for trying it on this Mac, but a downloaded copy would be refused as damaged. ' +
        'Set PATCHBAY_SIGN_IDENTITY to sign it.',
    );
}

vpk([
    'pack',
    '--packId', 'Patchbay',
    '--packVersion', version,
    '--packTitle', 'Patchbay',
    '--packAuthors', 'Dawnlit',
    '--packDir', packDir,
    '--mainExe', os === 'win' ? 'Patchbay.exe' : 'Patchbay',
    '--runtime', rid,
    '--channel', channel,
    // Portable only: unzip and run, no installer.
    '--noInst',
    '--outputDir', releases,
    ...signing,
]);

if (tag) {
    vpk(['upload', 'github', '--repoUrl', repoUrl, '--token', token!, '--tag', tag, '--merge', '--outputDir', releases,
        '--channel', channel, ...(nightly ? ['--pre'] : [])]);
}
