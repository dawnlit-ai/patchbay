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
Outlook Inbox ──▶ Categorize ──┬─ "Pre-alert"    ─▶ Process (skill) ─┬─ Done         ─▶ Terminal
                               │                                     ├─ Needs review ─▶ Terminal (needs-review)
                               │                                     └─ Error        ─▶ Terminal
                               ├─ "Rate quote"   ─▶ Process (skill) ──▶ …
                               └─ Unmatched      ─▶ Terminal (needs-review)
```

- **Outlook Trigger** — polls a mailbox folder through the real Outlook client and starts one run per new email.
- **Categorizer** — an if/else you write in prose. Give each branch a description; Claude picks exactly one, and says
  why.
- **Processor** — runs Claude with the skills you tick, holding tools scoped to this one email. It leaves by *Done*,
  by *Needs review* when it finished but a person has to decide or check something, or by *Error*.
- **Terminal** — ends a path, records a disposition, optionally files the email.

Each node hands the email out of exactly **one** output port, and the engine follows the single edge attached to it.
That constraint is what makes a run a readable path rather than a cloud of concurrent activity.

## The welcome window

The app opens on a start page rather than a canvas, because "which flow?" is a question the canvas cannot draw an
answer to. It lists every flow this install holds — its size, when it was last edited, whether a trigger in it is
being polled — and is a window of its own, sized for a list rather than for the canvas it hands over to.

From it you can open a flow, start a new one, duplicate one, rename one, delete one, and open a flow file
somebody sent you. Each flow shows the **project folder** it lives in, with a button that opens that folder in
Finder or Explorer — it holds the flow's own file and the skills only that flow can reach, and it is the working
directory its Processors run in.

Renaming asks a second question: should the folder follow the name? It is offered ticked when the folder is still the
one the app chose, and left alone when you have named it yourself. Either way the flow's **id** does not move — runs
already recorded, the watcher's marks and anything an agent holds go on pointing at the same flow. Only the path
changes, and a rename is refused outright while a run is using that directory. So is deleting the flow; runs of it
still waiting in the queue are cancelled as it goes.

**☰ Flows** in the canvas's top bar brings the start page back. Opening a flow while a canvas is already up on a
different one asks where it should go: in that window, in place of the flow on it, or in a second canvas beside it.
A flow already open raises the window holding it rather than drawing it twice — two canvases on one graph would be
two editors of one file — and with no canvas up there is nothing to ask. The runs and the console belong to the
workspace rather than to the flow above them, so every canvas shows all of both, each run named for the flow it ran.

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

## The console

A run explains why an email went where it did. It cannot explain an email that never became a run, and that is what
the **Console** tab beside Runs is for. It records what the app did outside any one run:

- **watcher** — watching started and stopped, what each poll found, the first poll that marks a folder's mail as seen
  without running it, a poll whose every email was new (so more may have arrived than one poll takes), and queued
  email dropped by Stop
- **run** — each run starting and how it ended, with a link to its trace
- **outlook** — every call to the client, how long it took, and how long it waited in the queue behind another
- **agent** — the MCP server listening or failing to, every tool call an agent makes and its input, and every request
  refused
- **app** — startup, and the one-off workspace migrations

Warnings and errors you have not looked at are counted on the tab. The level filter starts at *Info and up*; routine
lines — a poll that found nothing, an Outlook call that worked — are *debug*, shown under *Everything*.

The window keeps the last 2,000 lines. Every line is also appended to `<userData>/workspace/logs/<date>.jsonl`, one file
per day, kept for 14 days — **Folder** opens it, and **Clear** empties the window without touching the files.

## Requirements

- **Windows or macOS with a desktop Outlook client** — this drives the real client over COM/AppleScript, not Microsoft
  Graph. No app registration, no cloud permissions. (macOS needs *legacy* Outlook.)
- **Node 24+** — the version Electron 44 itself runs, so it is also what `@types/node` is pinned to. `.npmrc` sets
  `engine-strict`, which makes an older Node refuse the install rather than fail somewhere later.
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

The MCP server the app exposes has a check of its own, which costs nothing and touches neither Outlook nor Claude:

```bash
npm run mcpcheck
```

It starts the server against a throwaway workspace in the temp directory, drives it with a real MCP client — build a
flow, wire it, write, import and move skills, queue and cancel a run, read the console — and prints a line per check.

## First run

1. The welcome window opens with no flows the first time. **New flow** gives you a canvas and a folder of its own.
   Drag an **Outlook Trigger** onto the canvas and choose a mailbox — the account list comes from your Outlook
   client.
2. Drag a **Categorizer** onto the canvas and describe two or three kinds of email you actually get. Drag from the
   trigger's *On email* port to its input.
3. Drag a **Processor** per branch, tick a skill from either library, and connect it.
4. Pick a real email you already understand from **Test with an email**, in the left sidebar, and drag it onto the
   trigger. It runs through the flow straight away, and the runs panel opens to follow it. Filter the list, or reach
   back 30 or 90 days, to find the message you mean. (**Test run…** does the same from a dialog.)
5. When the path looks right, **Start watching**.

The trigger does not process mail already sitting in the folder unless you ask it to — switching a flow on shouldn't
fire fifty runs for last week's inbox.

## Skills

A skill is a `SKILL.md` file with frontmatter, exactly as Claude Code defines them. There are **two libraries**, and
the Skills tab switches between them:

```
<userData>/workspace/global/skills/<name>/SKILL.md            shared by every flow
<userData>/workspace/flows/<folder>/.claude/skills/<name>/SKILL.md   this flow only
```

**Global** is the shared shelf: any flow can tick these, editing one changes it everywhere, and it is where the seeded
skills land. **Flow** skills sit inside the flow's own directory — which is also the working directory its nodes run in
— so only that flow sees them, and they are deleted with it. The two may hold the
same name without either shadowing the other: a Processor stores a global tick as `global:<name>` and its own as the
bare name.

The global library is seeded on first run from the first of these that exists — `skillSeedPath` in Settings, then
`./skills` — falling back to one starter skill if neither does. Seeding runs only while that library is empty, or holds
nothing but the starter skill the app wrote itself, so it never fights an edit you made here. A new flow starts with an
empty library of its own, because everything it needs is already on the shelf.

Drag a skill onto the other tab to **move** it between the libraries. The open flow's ticks are re-pointed as it goes
(`global:x` ↔ `x`); a skill leaving the global shelf is one other flows can no longer tick, and one landing on a name
already there replaces it, so both are asked about first.

**Import…** pulls a folder of existing skills into whichever library is showing. A flow file may carry skills of its
own: opening one restores the flow's own skills and adds any global skill whose name is still free — it never rewrites
a global skill this install already has.

Under the hood the flow's library is discovered as project skills from the run's working directory, and the global one
is handed over as a local plugin — which is what lets a run load skills from outside its own directory. That is where
the `global:` prefix comes from.

> A skill that calls another app's MCP tools (`mcp__<server-name>__*`,
> say) needs that server added under **Settings → MCP servers** before a
> Processor can run it.

Inside a Processor run, a skill gets an MCP server whose tools are bound to the one email being handled:

| Tool              | Always | What it does                                                                  |
|-------------------|--------|-------------------------------------------------------------------------------|
| `read_email`      | ✅     | The sender's own text, sender, attachment names — and the quoted thread on request |
| `record_note`     | ✅     | Writes a note into the run trace                                              |
| `save_attachment` | opt-in | Saves into the run folder, returns paths                                      |
| `draft_reply`     | opt-in | Leaves an **unsent** draft in Outlook, written or from a template email       |
| `move_email`      | opt-in | Files the email into an Inbox subfolder                                       |

There is no tool that takes an entry id, so a skill cannot reach another message however it is prompted — and **nothing
here sends mail.** A drafted reply waits in Outlook for a person. `read_email` does hand back this email's own entry id,
so a record a skill writes elsewhere can link back to the message it came from.

`draft_reply` can reply with a template email kept in the mailbox (a `Templates` folder by default), found by subject:
it keeps the one `[[SECTION]]` asked for, fills its `{{PLACEHOLDERS}}`, and puts the named Outlook signature in
`{{SIGNATURE}}`. The operator's own wording goes out as they wrote it, and a template that cannot be filled completely
fails the call rather than drafting half a reply.

## Letting an agent drive it

There are two kinds of MCP server in this app, pointing opposite ways. A Processor is *handed* servers — the
email-scoped one above, plus whatever you add under **Settings → MCP servers**. This one is the other direction:
Patchbay's own, which an agent connects *to* in order to drive the app. Switch it on under **Settings → Agent
control** and paste the command shown there into a terminal:

```bash
claude mcp add --transport http patchbay http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"
```

After that, "wire me a flow that sorts pre-alerts from rate quotes and runs the pre-alert skill on the first branch" is
something you can say to Claude Code and watch happen on the canvas. An agent writes through the same stores the window
does — one workspace, not two copies of it — and the window re-reads what it changed as it goes. Every canvas save
names the version it was made to, so an edit made in the moment before an agent's write to the same flow is refused
rather than saved over it: the canvas says so, and shows the flow as the agent left it.

| Area     | Tools                                                                     |
|----------|---------------------------------------------------------------------------|
| Flows    | `list_flows`, `get_flow`, `create_flow`, `rename_flow`, `delete_flow`     |
| Graph    | `add_node`, `update_node`, `remove_node`, `connect`, `disconnect`         |
| Skills   | `list_skills`, `get_skill`, `write_skill`, `import_skills`, `move_skill`, `delete_skill` |
| Mailbox  | `list_accounts`, `list_folders`, `list_recent_emails`                     |
| Running  | `get_status`, `start_watching`, `stop_watching`, `test_run`, `cancel_run` |
| Runs     | `list_runs`, `get_run`, `get_console`                                     |
| Settings | `get_settings`                                                            |

`get_flow` hands back each node with the output ports its configuration currently gives it, which is what makes wiring
possible without guessing. Everything an agent writes goes through the same repair an imported flow file gets, so a
value of the wrong type falls back to its default rather than reaching a run — and an edge left hanging by an edit is
dropped, with the tool that dropped it saying how many.

`write_skill` writes one `SKILL.md`; a skill with scripts or references beside it comes in whole through
`import_skills`, from a folder on this machine — `~/.claude/skills`, say — optionally narrowed to the names wanted.
`move_skill` re-points the flow's own Processors as the Skills tab does, and names any other flow a skill leaving the
global shelf strands.

A test run's id comes back before the run starts, and it can wait — behind a run of the same flow, or for a free slot
under *Runs at once*. `get_run` says which rather than reporting no such run, `list_runs` puts what is queued and under
way first, and `cancel_run` takes a queued one out before it starts. When an email never became a run at all,
`get_console` reads the console: this session's lines, or any day's file still kept.

Three things are deliberately absent:

- **No tool reaches into the mailbox for a message.** An agent lists a folder to pick an email to test against;
  fetching a body is the job of the run's own scoped tools, and those cannot reach a second message. A run already
  recorded is another matter — `get_run` returns the prompts a node sent, email and all, because a trace you cannot
  read is not a trace.
- **No tool writes settings.** The Claude executable and the servers handed to a Processor decide what code a run
  executes, so they stay with the person at the window.
- **Nothing sends mail.** Nothing in this app does.

It is off until you switch it on. When it is on it binds to `127.0.0.1` only; every request has to carry the token
Settings shows, and **New token** cuts off anything still holding the old one. A request whose `Host` is not this
listener, or that carries an `Origin` at all, is refused before the token is even looked at — those are the two headers
a web page cannot forge, and a page is the one thing that can be told to post to a loopback port without you knowing.
Close the last window and the server stops with it.

`test_run`, `start_watching` and `delete_flow` spend money or destroy work. They are ordinary tool calls, so whatever
permission prompt your client puts in front of a tool is what keeps a person in the loop.

## Architecture

```
src/
├─ shared/      flow graph, run/trace records, IPC contract   (both processes)
├─ main/
│  ├─ engine/   graph walk + the poller that turns mail into runs
│  ├─ claude/   Agent SDK wrapper, and the email-scoped MCP tools
│  ├─ mcp/      the app's own MCP server — Patchbay as tools an agent can call
│  ├─ outlook/  seam over @dawnlit/outlook-bridge
│  ├─ store/    flows and their skills, settings, run traces (files on disk)
│  └─ ipc.ts    one handler per channel in shared/ipc.ts
├─ preload/     contextBridge — the renderer gets `window.api` and nothing else
└─ renderer/    React Flow canvas, inspector, trace viewer
```

Three decisions worth knowing:

**The `Flow` object is the only copy of the graph.** React Flow's node array is derived on every render, and every
canvas interaction is translated straight back into a `Flow` edit. There is no second graph to drift.

**Ports are derived from config, not stored.** Editing a categorizer's categories moves its ports with it, and the
engine treats an edge leaving a port that no longer exists as a dead end it reports, rather than a silent stall.

**Flows run in parallel, and every Outlook call is queued.** Up to *Runs at once* runs are under way together — three
by default, from Settings — and never two of one flow: a flow's directory is the working directory of every run of it,
and its mail is handled in the order it arrived. So one long agent run holds up the rest of its own flow's mail and
nothing else. What does not parallelise is Outlook. Its COM automation is single-threaded — a second script asking for
the client while one is mid-call blocks until the first finishes, and if that one is slow the second burns its whole
timeout waiting. (This is not theoretical: two processes talking to Outlook at once is what produced the first
`powershell run exceeded its 120000ms budget` during development.) So the poller, the inspector's folder lookup and a
skill's `read_email` all funnel through one queue in `main/outlook/bridge.ts`: overlapping runs overlap while they are
thinking, and take turns the moment they touch the mailbox.

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
