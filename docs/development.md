# Development

## Run from source

Needs **Node 24+** — the version Electron 44 itself runs, so it is also what `@types/node` is pinned to. `.npmrc` sets
`engine-strict`, which makes an older Node refuse the installation rather than fail somewhere later.

```bash
npm install
npm start
```

> **npm 12 blocks dependency lifecycle scripts by default.** The ones this project
> allows or refuses are declared in `allowScripts` in `package.json`; run
> `npm install-scripts ls` to review what is still blocked. The project's own
> `postinstall` downloads the Electron binary. `@dawnlit/outlook-bridge` links in
> from the sibling `../outlook-bridge` checkout with its `prepare` build refused,
> so after changing it, run `npm run build` there.

A copy run from source does not update itself.

## Build a release zip

To build the zip a release carries, for the machine you are on:

```bash
dotnet tool install -g vpk --version 1.2.161
npm run dist
```

`dist` packages the app and hands it to [Velopack](https://velopack.io), which writes the portable zip, and the packages
installed copies update themselves from, into `out/releases`. `vpk` needs the .NET SDK, and stays at the version of the
`velopack` package in `package.json`. A version with `-nightly` in it is packed for the nightly channel. On a Mac, set
`PATCHBAY_SIGN_IDENTITY` to a code-signing certificate's name, or a copy downloaded anywhere else is refused as damaged.

To try an update before publishing it, start a copy unzipped from an earlier build with
`--update-feed=<path to out/releases>`, and it checks there instead of GitHub.

## Check the whole chain works

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

The app's own MCP server has a check of its own, which costs nothing and touches neither Outlook nor Claude:

```bash
npm run mcpcheck
```

It starts the server against a throwaway workspace in the temp directory, drives it with a real MCP client — build a
flow, wire it, open a flow file in place, write, import and move skills, queue and cancel a run, read the console — and
prints a line per check.

## Architecture

```
src/
├─ shared/      flow graph, run/trace records, IPC contract   (both processes)
├─ main/
│  ├─ engine/   graph walk + the poller that turns mail into runs
│  ├─ agents/   runs a step on Claude (Agent SDK) or agy, then on its fallbacks; takes nothing from the app but its host
│  ├─ tools/    the email-scoped MCP tools a run is handed, and the Settings servers' tool lists
│  ├─ mcp/      the app's own MCP server — Patchbay as tools an agent can call
│  ├─ outlook/  seam over @dawnlit/outlook-bridge
│  ├─ store/    flows and their skills, settings, run traces (files on disk)
│  └─ ipc.ts    one handler per channel in shared/ipc.ts
├─ preload/     contextBridge — the renderer gets `window.api` and nothing else
└─ renderer/    React Flow canvas, inspector, trace viewer
```

Four decisions worth knowing:

**The `Flow` object is the only copy of the graph.** React Flow's node array is derived on every render, and every
canvas interaction is translated straight back into a `Flow` edit. There is no second graph to drift.

**Ports are derived from config, not stored.** Editing a categorizer's categories moves its ports with it, and the
engine treats an edge leaving a port that no longer exists as a dead end it reports, rather than a silent stall.

**Flows run in parallel, and every Outlook call is queued.** Up to *Runs at once* runs are under way together — three
by default, from Settings — and never two of one flow: a flow's directory is the working directory of every run of it,
and its mail is handled in the order it arrived. What does not parallelise is Outlook. Its COM automation is
single-threaded — a second script asking for the client while one is mid-call blocks until the first finishes, and if
that one is slow the second burns its whole timeout waiting. So the poller, the inspector's folder lookup and a skill's
`read_email` all funnel through one queue in `main/outlook/bridge.ts`: overlapping runs overlap while they are
thinking, and take turns the moment they touch the mailbox.

**The global skill library is handed over as a local plugin.** The flow's library is discovered as project skills from
the run's working directory; the global one goes in as a plugin, which is what lets a run load skills from outside its
own directory, and where the `global:` prefix comes from. Only the workspace's own folder is in plugin layout, so while
any folder is linked each run copies the global skills it ticks into a temporary plugin and deletes it afterwards —
which also keeps an edit made mid-run out of the run.
