# Patchbay

*A [Dawnlit](https://github.com/dawnlit-ai) project.*

A patchbay is a board where you run a cable from one jack to another and the signal follows the wire you can see. This
is that, for email: drag nodes onto a canvas, connect them port to port, and watch a real email travel the path you
drew. Outlook supplies the mail, Claude does the thinking, and every pass is written down so you can work out afterwards
why an email went where it did.

![licence](https://img.shields.io/badge/licence-AGPL--3.0-blue) ![by](https://img.shields.io/badge/by-Dawnlit-0f9d58) ![stack](https://img.shields.io/badge/Electron-44-informational) ![stack](https://img.shields.io/badge/React-19-informational) ![stack](https://img.shields.io/badge/TypeScript-7-informational)

## What it does

A **flow** is a graph with one trigger and any number of branches:

```
Outlook Inbox ──▶ Categorize ──┬─ "Pre-alert"    ─▶ Process (skill) ─┬─ Done  ─▶ Terminal
                               │                                     └─ Error ─▶ Terminal
                               ├─ "Rate quote"   ─▶ Process (skill) ──▶ …
                               └─ Unmatched      ─▶ Terminal (needs-review)
```

- **Outlook Trigger** — polls a mailbox folder through the real Outlook client and starts one run per new email.
- **Categorizer** — an if/else you write in prose. Give each branch a description; Claude picks exactly one, and says
  why.
- **Processor** — runs Claude with the skills you tick, holding tools scoped to this one email.
- **Terminal** — ends a path, records a disposition, optionally files the email.

Each node hands the email out of exactly **one** output port, and the engine follows the single edge attached to it.
That constraint is what makes a run a readable path rather than a cloud of concurrent activity.

## The run log

Every email produces a `Run`, and every node it touches produces a `Pass`:

- which port it left by, and the one-line reason
- the full prompt sent to Claude
- every tool call with its arguments, and every result
- Outlook side effects (body read, attachment saved, draft left, email moved)
- cost, turns and duration

Select a run in the bottom panel and the canvas lights up the exact nodes and edges that email travelled, with each node
showing its pass number and outcome.

Runs are plain JSON in the app workspace — one file per run, plus a JSONL index. A database would be the reflex, but
these records exist to be read when something has gone wrong, so a file you can open and paste into a bug report wins.

## Requirements

- **Windows or macOS with a desktop Outlook client** — this drives the real client over COM/AppleScript, not Microsoft
  Graph. No app registration, no cloud permissions. (macOS needs *legacy* Outlook.)
- **Node 24+**
- **Claude Code installed**, or an Anthropic API key. The app drives Claude through the Claude Agent SDK, which runs a
  `claude` binary. If Claude Code is already installed the app finds it automatically and reuses its login.

## Install

```bash
npm install
node node_modules/electron/install.js   # see note below
npm start
```

> **npm 12 blocks dependency lifecycle scripts by default.** Electron's postinstall
> is what downloads the actual Electron binary, so it must be run once by hand
> after `npm install` (the second line above). The packages this project needs to
> unblock are declared in `allowScripts` in `package.json`; run
> `npm install-scripts ls` to review what is still blocked. `.npmrc` sets
> `allow-git=all`, which is required because `@dawnlit/outlook-bridge` installs
> straight from GitHub.

To build a distributable:

```bash
npm run make      # needs: npm install-scripts approve electron-winstaller
```

### Check the whole chain works

```bash
npm run selftest
```

Takes the newest email in your first Outlook account and pushes it through a throwaway trigger → categorizer → terminal
flow, printing the path it took. It reads and classifies; it never writes to the mailbox. One Claude call, a couple of
cents. A healthy run ends:

```
path        : trigger → cat → end-ok
edges taken : e1, e2
#2 Sort [ok] → cat:business
    Business · 97% — A personally written follow-up from a company CEO chasing
    status on a paid production order… clearly operational business correspondence.
SELFTEST OK
```

## First run

1. **Start watching** is off. Click the trigger node and choose a mailbox — the account list comes from your Outlook
   client.
2. Drag a **Categorizer** onto the canvas and describe two or three kinds of email you actually get. Drag from the
   trigger's *On email* port to its input.
3. Drag a **Processor** per branch, tick a skill, and connect it.
4. Hit **Test run…**, pick a real email you already understand, and read the trace.
5. When the path looks right, **Start watching**.

The trigger does not process mail already sitting in the folder unless you ask it to — switching a flow on shouldn't
fire fifty runs for last week's inbox.

## Skills

A skill is a `SKILL.md` file with frontmatter, exactly as Claude Code defines them:

```
<userData>/workspace/.claude/skills/<name>/SKILL.md
```

On first run the library seeds itself from the first of these that exists —
`skillSeedPath` in Settings, `~/Documents/GitHub/smart-logistics-assistant/skills`, then `./skills` — falling back to
one starter skill if none do. These are the app's **own copies**: edit them in the Skills tab without touching the
originals. Seeding runs only while the library is empty — or holds nothing but that starter skill, which the app wrote
itself — so it never fights an edit you made here.

The **Skills** tab edits them in place, and **Import…** pulls in a folder of existing skills at any time. The Agent SDK
discovers them from the workspace, so what you see in the tab is what Claude sees at runtime.

> A seeded skill that calls another app's MCP tools (`mcp__smart-logistics__*`,
> say) needs that server added under **Settings → MCP servers** before a
> Processor can run it.

Inside a Processor run, a skill gets an MCP server whose tools are bound to the one email being handled:

| Tool              | Always | What it does                             |
|-------------------|--------|------------------------------------------|
| `read_email`      | ✅     | Full body, sender, attachment names      |
| `record_note`     | ✅     | Writes a note into the run trace         |
| `save_attachment` | opt-in | Saves into the run folder, returns paths |
| `draft_reply`     | opt-in | Leaves an **unsent** draft in Outlook    |
| `move_email`      | opt-in | Files the email into an Inbox subfolder  |

There is no tool that takes an entry id, so a skill cannot reach another message however it is prompted — and **nothing
here sends mail.** A drafted reply waits in Outlook for a person.

## Architecture

```
src/
├─ shared/      flow graph, run/trace records, IPC contract   (both processes)
├─ main/
│  ├─ engine/   graph walk + the poller that turns mail into runs
│  ├─ claude/   Agent SDK wrapper, and the email-scoped MCP tools
│  ├─ outlook/  seam over @dawnlit/outlook-bridge
│  ├─ store/    flows, skills, settings, run traces (JSON on disk)
│  └─ ipc.ts    one handler per channel in shared/ipc.ts
├─ preload/     contextBridge — the renderer gets `window.api` and nothing else
└─ renderer/    React Flow canvas, inspector, trace viewer
```

Three decisions worth knowing:

**The `Flow` object is the only copy of the graph.** React Flow's node array is derived on every render, and every
canvas interaction is translated straight back into a `Flow` edit. There is no second graph to drift.

**Ports are derived from config, not stored.** Editing a categorizer's categories moves its ports with it, and the
engine treats an edge leaving a port that no longer exists as a dead end it reports, rather than a silent stall.

**Runs execute one at a time, and every Outlook call is queued.** Outlook's COM automation is single-threaded — a second
script asking for the client while one is mid-call blocks until the first finishes, and if that one is slow the second
burns its whole timeout waiting. (This is not theoretical: two processes talking to Outlook at once is what produced the
first `powershell run exceeded its 120000ms
budget` during development.) So the poller, the inspector's folder lookup and a skill's `read_email` all funnel through
one queue in `main/outlook/bridge.ts`.

## Costs

Every Categorizer pass is one Claude call; every Processor pass is an agent loop. Both record `total_cost_usd` on the
pass, and the Processor honours a per-node USD budget. Classification runs about a cent on Opus; a processing run
depends entirely on the skill.

## Licence

Copyright (C) 2026 Dawnlit.

Patchbay is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public
License** as published by the Free Software Foundation, either version 3 of the Licence, or (at your option)
any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text, or
<https://www.gnu.org/licenses/>.

The AGPL's network clause (section 13) is the point of choosing it here: anyone who runs a modified version of this app
as a service has to offer its users the modified source.

**On dependencies.** The licence above covers this repository's own code. It does not relicense what it talks to:
`@anthropic-ai/claude-agent-sdk` is proprietary ("© Anthropic PBC. All rights reserved", subject to Anthropic's
[legal agreements](https://code.claude.com/docs/en/legal-and-compliance)), and
`@dawnlit/outlook-bridge` is Apache-2.0 (also Dawnlit's, but separately licensed and separately versioned). Both are
installed from npm by whoever builds the app rather than redistributed here — worth understanding before you ship
binaries, since bundling a proprietary SDK into an AGPL distribution is a question for a lawyer rather than a README.

---

Built by **Dawnlit** — <https://github.com/dawnlit-ai>
