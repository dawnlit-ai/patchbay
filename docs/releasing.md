# Releasing

Three workflows in `.github/workflows` build every platform — Windows x64, and Macs with Apple silicon and Intel — and
publish them as GitHub releases, which installed copies read to update. `build.yml` is the build itself; the other two
decide what to build and when. A build that fails on any platform takes its draft with it, so nothing half-built is
published.

## Nightly

`nightly.yml` runs every morning and builds master if it has changed since the last nightly; **Run workflow** on the
Actions tab builds one now. Its version is the one in `package.json`, or the next patch once a release of that is out,
with `-nightly.<UTC date and time>` after it — so a nightly sorts after the release before it and before the one it
leads up to. It is published as a prerelease, and only the five newest are kept: an installed copy reads GitHub's ten
newest releases, and the latest stable one has to stay among them.

## Stable

`release.yml` runs on a tag naming the version `package.json` holds:

```bash
npm version 0.2.0 --no-git-tag-version
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin master v0.2.0
```

Every platform is built into a draft release, its notes drawn from the commits since the last one. Nothing reaches
anyone until you publish the draft on GitHub: publishing it is the release. Then move `package.json` on to the next
version, which nightlies count from.

## The Mac signing certificate

Mac builds are signed with one self-signed certificate, held in the repository's secrets. It vouches for nothing — a
certificate Apple vouches for costs a yearly fee, which is why a first launch needs **Open Anyway** — but without a
signature a downloaded Mac build is refused as damaged, and macOS files the permission to control Outlook under the
certificate and the bundle ID, `com.dawnlit.patchbay`. Replacing either asks every Mac user for that permission again,
so make the certificate once, and keep a copy somewhere other than GitHub.

To make it, with OpenSSL (Git Bash has it):

```bash
cat > patchbay-signing.cnf <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Dawnlit Patchbay
[ext]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config patchbay-signing.cnf \
  -keyout patchbay-signing.key -out patchbay-signing.crt
openssl pkcs12 -export -inkey patchbay-signing.key -in patchbay-signing.crt -out patchbay-signing.p12 \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
base64 -w0 patchbay-signing.p12 > patchbay-signing.p12.b64
```

The last three options to `pkcs12` make a file macOS's keychain can read; it asks for a password to protect it with.
Under the repository's **Settings → Secrets and variables → Actions**, save what `patchbay-signing.p12.b64` holds as
`MACOS_SIGNING_CERTIFICATE`, and that password as `MACOS_SIGNING_PASSWORD`. Then move the files off this machine to
somewhere safe. Without the secret, the Mac builds fail rather than publish something no one else could open.

## Windows

Windows builds are not signed. Updates do not need it; a signature would only quiet SmartScreen, and `vpk pack` takes one
(`--signParams`, or `--azureTrustedSignFile` for Azure Artifact Signing) once there is a certificate to sign with.
