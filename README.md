# Patchbay

*A [Dawnlit](https://github.com/dawnlit-ai) project.*

A patchbay is a board where you run a cable from one jack to another and the signal follows the wire you can see. This
is that, for email: drag nodes onto a canvas, connect them port to port, and watch a real email travel the path you
drew. Outlook supplies the mail, Claude does the thinking, and every pass is written down so you can work out afterward
why an email went where it did.

![licence](https://img.shields.io/badge/licence-AGPL--3.0-blue) ![by](https://img.shields.io/badge/by-Dawnlit-0f9d58) ![stack](https://img.shields.io/badge/Electron-44-informational) ![stack](https://img.shields.io/badge/React-19-informational) ![stack](https://img.shields.io/badge/TypeScript-7-informational)

## What it does

A **flow** is a graph with one trigger and any number of branches:

```
Outlook Inbox ──▶ Categorize ──┬─ "Invoice"      ─▶ Process (skill) ─┬─ Done         ─▶ Terminal
                               │                                     ├─ Needs review ─▶ Terminal (needs-review)
                               │                                     └─ Error        ─▶ Terminal
                               ├─ "Support"      ─▶ Process (skill) ──▶ …
                               └─ Unmatched      ─▶ Terminal (needs-review)
```

- **Outlook Trigger** — polls the folders you tick through the real Outlook client, and starts one run per new email.
- **Categorizer** — an if/else you write in prose. Claude picks exactly one branch, and says why.
- **Extractor** — pulls fields out of the email into a JSON Schema you give it, for later steps to read.
- **Processor** — runs Claude with the [skills](docs/skills.md) you tick, holding tools scoped to this one email.
- **Terminal** — ends a path and records a disposition.

Each node hands the email out of exactly **one** output port, so a run is a readable path rather than a cloud of
concurrent activity. Every run records the prompt each node sent, every tool call and result, and every change to the
mailbox; select one and the canvas lights up the path that email took.

**Nothing sends mail.** A Processor can leave an unsent draft in Outlook for a person; no tool in the app sends one.

## Download

Each [release](https://github.com/dawnlit-ai/patchbay/releases) carries a zip for each platform. There is no installer.

| Platform               | Zip                               |
|------------------------|-----------------------------------|
| Windows                | `Patchbay-win-x64-Portable.zip`   |
| Mac with Apple silicon | `Patchbay-osx-arm64-Portable.zip` |
| Intel Mac              | `Patchbay-osx-x64-Portable.zip`   |

**Windows.** Unzip it somewhere you can write to — not Program Files — and open `Patchbay.exe`. The build is not
signed, so the first time, SmartScreen says Windows *protected your PC*: **More info → Run anyway**. Removing Patchbay
is deleting the folder.

**Mac.** Unzip it, move `Patchbay.app` into Applications and open it. It is not signed by a certificate Apple vouches
for, so the first time, macOS says it cannot check it for malicious software: open **System Settings → Privacy &
Security** and click **Open Anyway** beside Patchbay.

Flows, skills, settings, runs and logs live in the workspace — `%APPDATA%\Patchbay\workspace` on Windows,
`~/Library/Application Support/Patchbay/workspace` on a Mac — so updating or deleting the app leaves them where they
are.

A downloaded copy updates itself in the background; **Settings → Updates** says what it found and has **Restart to
update**. Choose the channel there too: **Stable** for published releases, or **Nightly** for a build of each day's
changes to master.

## Requirements

- **Windows or macOS with a desktop Outlook client.** Patchbay drives the real client over COM/AppleScript, not
  Microsoft Graph — no app registration, no cloud permissions. macOS needs *legacy* Outlook.
- **[Claude Code](https://code.claude.com/docs/en/setup) installed and signed in**, with a Claude account or an
  Anthropic API key. Patchbay doesn't include it: it runs the `claude` on your computer and reuses its login.
- **Optionally, the Antigravity CLI (`agy`)**, to run nodes on Gemini and the other models it offers. It needs a
  permission rule per tool — see [Models and agents](docs/models.md#agy).

## First run

1. The welcome window opens with no flows. **New flow** asks where to keep it, and gives you a canvas and a folder of
   its own there. Drag an **Outlook Trigger** onto the canvas and choose a mailbox.
2. Drag a **Categorizer** onto the canvas and describe two or three kinds of email you actually get. Drag from the
   trigger's *On email* port to its input.
3. Drag a **Processor** per branch, tick a skill, and connect it.
4. Pick a real email you already understand and drag it out of Outlook's message list onto the trigger. It runs
   through the flow straight away, and the runs panel opens to follow it. On a Mac, select the email in Outlook and
   right-click the trigger → *Run the email selected in Outlook* instead. (**Test run…** picks one from a list.)
5. When the path looks right, **Start watching**. Mail already in the folder is left alone — only new mail starts a
   run.

## Documentation

- [Flows](docs/flows.md) — the nodes in detail, the slots data travels in, and where flow files live
- [Models and agents](docs/models.md) — fallback models, Claude Code, agy, and what runs cost
- [Skills and tools](docs/skills.md) — the two skill libraries, MCP servers, and the tools a run is handed
- [Runs and the console](docs/runs.md) — what a run records, and what the app logs outside any run
- [Letting an agent drive it](docs/agent-control.md) — Patchbay's own MCP server
- [Development](docs/development.md) — running from source, self-checks, architecture
- [Releasing](docs/releasing.md) — the nightly and stable workflows, and signing

## Licence

Copyright © 2026 Dawnlit. Patchbay is free software under the **GNU Affero General Public License**, version 3 or
(at your option) any later version, and comes with no warranty. See [LICENSE](LICENSE). The AGPL's network clause is
the point of choosing it: anyone who runs a modified version of this app as a service has to offer its users the
modified source.

The licence covers this repository's own code, not what it talks to. `@anthropic-ai/claude-agent-sdk` is proprietary
("© Anthropic PBC. All rights reserved", subject to Anthropic's
[legal agreements](https://code.claude.com/docs/en/legal-and-compliance)), and `@dawnlit/outlook-bridge` is
Apache-2.0. Neither is held in this repository; both are installed from npm by whoever builds the app. A release build
carries the SDK's own code, but not Claude Code, which each user installs from Anthropic.
