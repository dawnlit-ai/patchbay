# Skills and tools

## Skills

A skill is a `SKILL.md` file with frontmatter, exactly as Claude Code defines them. A workspace has **one library**, in
its `skills` folder, and it is the only one its flows use:

```
<workspace>/skills/<name>/SKILL.md
```

Every Processor and Extractor step is given the whole library, loaded automatically, and no skill from anywhere else —
not `~/.claude/skills`, not a project's `.claude/skills`, not another workspace's. Claude picks a skill by its
description, as it would in Claude Code, so a step can follow one skill that hands part of the job to another without
either being ticked. What a node ticks are the skills it loads **before anything else**: its prompt names them, so the
step starts from the skill meant for it rather than whichever one Claude judges closest.

A node stores a tick as the skill's name, so editing a skill changes it for every flow here.

A new workspace starts with one starter skill. A folder opened as a workspace starts with whatever its `skills` folder
holds — nothing, if it has none yet.

A run is handed a copy of the library, as a plugin Claude knows as `workspace`, so a trace shows a step loading
`workspace:<name>`. A skill saved while a run is under way reaches the next run, not that one. A workspace with no
skills gives its steps none, and no Skill tool. On an agy model, the skills are copied to where agy reads them, and the
step is told which to read first.

### Managing skills

The list sits in a Processor's or Extractor's inspector, where a tick makes the node load a skill first, and on its own
when no node is selected. Patchbay has no editor of its own: **Edit** opens a skill's `SKILL.md` in the app your system
gives `.md` files, and right-clicking a skill can also show its folder or delete it. **New** writes one from a template,
ticks it on the node whose list it came from, and opens it. **Import…** copies chosen `SKILL.md` files into the library,
each with the folder it sits in — which is how skills kept elsewhere, such as `~/.claude/skills`, come in.

The start window's **Skills** tab lists the same library beside the workspace's flows: each skill's description, which
flows tick it, and when it was last edited, with **New skill** and **Import skills…** in the rail. The skill picked has
**Edit SKILL.md** and **Delete…** under it. Edit, or a double-click, opens its `SKILL.md` in the app your system gives
`.md` files; right-clicking it can also show its folder. A skill some flow ticks but the folder
no longer holds is listed at the bottom, with the flows that tick it.

The app watches the workspace's `skills` folder, so a skill saved, renamed or deleted elsewhere — in your editor, Finder
or Explorer, a `git pull` — shows as it happens. A node still ticking one that has gone lists it on its own, to untick,
and a run reaching that node leaves by its error port naming the skill.

## MCP servers

A Processor or Extractor is handed only the server tools [its ticked skills grant](#tools-a-skill-grants) and the ones
ticked under *Tools from MCP servers*, in its [Access](flows.md#the-nodes) — one by one, or *All* of a server's — and a
server with neither is not started
for its run. So a step that reads mail from outside, and needs a record lookup, holds that lookup and not the same
server's tool that sends mail.

Servers come from the workspace, like its flows, skills and schemas, so a flow is handed the same ones on every
computer it is opened on. Patchbay reads `.mcp.json` (Claude Code), `.vscode/mcp.json`, `.cursor/mcp.json` and
`.gemini/settings.json` in that order, fills in `${VAR}`, `${VAR:-default}`, `${env:VAR}`, VS Code's `${input:id}` and
`${workspaceFolder}` ([as below](#tokens-and-other-values)), and starts commands in the workspace's folder. A name
defined in two files is taken from the first. Because a workspace's file can come from a cloned repository, a server
found there is not started — not even to list its tools — until you click **Allow** on it in the start window's **MCP**
tab or the inspector. Editing what a server starts asks again. An [exported](flows.md#workspaces-and-flow-files)
workspace carries these files, or the ones its `.patchbay/export/` holds instead, and is allowed afresh wherever it is
opened.

Servers you keep for every project in an agent itself — `claude mcp add --scope user`, or agy's own settings — stay
that agent's, for its own sessions. No run is handed them: a run starts with only the servers its node ticks.

The start window's **MCP** tab lists the workspace's servers with their state, which flows tick their tools, and
(once allowed) the tools each offers. From there you can allow or block them, open or create `.mcp.json`, or see any
server a flow ticks that is not in the workspace. These files are watched like the `skills` folder, so a server added
in your editor or by a `git pull` shows as it happens.

A node that ticks a server no run can be handed — not allowed yet, blocked, missing a value, or defined nowhere —
leaves by its error port saying which, rather than running without the tools it was built to use. So does one on a
Claude model whose server's definition sets a `cwd` other than the workspace folder: Claude starts every server there.
On agy, Patchbay starts each server itself, where its definition says, and serves it to agy through a proxy on
loopback, so agy is handed only an address for each, in a file in that run's own folder that the run is refused from
reading or searching. A server over the older SSE transport cannot run on agy.

An app opened from the Finder or the Dock does not have a terminal's PATH, so a server's command — `npx`, `uvx`,
`node` — is also looked for in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, both to list its tools and in
a run. One installed by a version manager such as nvm or Volta lives elsewhere: give its full path.

A skill that calls another app's MCP tools (`mcp__<server-name>__*`) needs that server allowed in the workspace, and
the tools it calls granted by the skill itself or ticked on the node, before it can run.

### Tools a skill grants

A skill names the tools it calls in its frontmatter's `allowed-tools`, as Claude Code writes it, and every node that
ticks the skill is handed them. A skill and the tools it calls then travel together, written once, not ticked again on
each node that uses it:

```yaml
---
name: rate-reply-log
description: …
allowed-tools: mcp__smart-logistics__rate_quotes
---
```

Entries are separated by commas or spaces, or given one per `- ` line under the key. `mcp__<server>__<tool>` grants one
tool, and `mcp__<server>` or `mcp__<server>__*` every tool of that server. The server still has to be allowed in the
workspace, as for a tool ticked on the node.

- **Only a ticked skill grants.** Every skill in the workspace reaches every run, but one the node does not tick grants
  nothing, even when the run loads it. So an email cannot steer a step into a skill whose tools the step was never
  meant to have.
- **Only the workspace's server tools.** Built-in tools such as Bash, Read or WebFetch, and the email's own tools, are
  not granted by a skill. A node's own settings give those. The inspector lists any a ticked skill names, as left out.
- **The run gets no `allowed-tools`.** Patchbay removes the key from the copy of the library a run is handed, so the
  agent cannot grant a skill's list itself.
- **Editing a skill's `allowed-tools` changes every node that ticks it,** in every flow, as editing its text does.

In the inspector, a tool a ticked skill grants shows ticked under *Tools from MCP servers*, with the skill it comes
from, and cannot be unticked there: untick the skill, or change its `allowed-tools`. A tool both granted and ticked
on the node keeps its own tick, which can be taken off. A skill that grants tools says how many beside its name in the
skill list. A tool a skill grants that no server offers is named under the heading, so the skill can be corrected.

### Tokens and other values

Write a token into a server's `env` or `headers` as a variable rather than as itself —
`"Authorization": "Bearer ${CRM_TOKEN}"` — so it stays out of a file you commit, then set its value with **Set…** beside
the server in the start window's **MCP** tab, or in the inspector. A value set there is kept for that one server in that
one workspace, encrypted with the key your system keeps for Patchbay (the Keychain on macOS, DPAPI on Windows), in the
app's data rather than the workspace. It is opened only when that server starts — to list its tools, or for a run whose
node ticks it — and no window shows it again: it can be changed or cleared, not read. Another server naming the same
variable does not get it. Linux without a keyring has nothing to keep one in, and Patchbay says so rather than keep it
in the clear.

A variable is filled from the value set for the server first, then from Patchbay's environment, then from the
definition's own default, as in `${PORT:-3000}`. An app opened from the Finder or the Dock does not share your
terminal's environment. VS Code's `${input:id}` is only ever a value set here, shown with the description its file's
`inputs` give it. A server with a variable none of these fill can still be allowed, but is marked **needs a value**,
and a node that ticks it stops at its error port saying which, rather than starting it with a hole in its command.

## The email-scoped tools

Inside a Processor or Extractor run, a skill gets an MCP server whose tools are bound to the one email being handled:

| Tool              | Always | What it does                                                                       |
|-------------------|--------|------------------------------------------------------------------------------------|
| `read_email`      | ✅     | The sender's own text, sender, attachment names — and the quoted thread on request |
| `record_note`     | ✅     | Writes a note into the run trace                                                   |
| `save_file`       | ✅     | Saves a text file into the run folder, by a bare file name, and returns its path   |
| `save_attachment` | opt-in | Saves into the run folder, returns paths                                           |

`save_attachment` also writes a workbook (`.xlsx`, `.xlsm`) out beside itself as CSV, one file per visible sheet, since
Read can't open one. Each cell reads as the sheet shows it — `51%` rather than `0.51`, dates as `YYYY-MM-DD` — and line
N of the CSV is row N of the sheet, so a figure can be traced to its cell.

There is no tool that takes an entry id, so a skill cannot reach another message however it is prompted — and **nothing
here drafts, sends or moves mail.** A [Create email](flows.md#create-email), [Send](flows.md#sending) or [Move
email](flows.md#moving) after the step does that, with no model. `read_email` does hand back this email's own entry id,
so a record a skill writes elsewhere can link back to the message it came from.

A Processor once had `draft_reply` and `move_email` too, each a box of its own in the inspector. One from a flow made
then still shows the box ticked, and is flagged on the canvas: the run no longer gets the tool, so the flow cannot be
watched until the node after it that does the work is in place, its instruction no longer asks for it, and the box is
unticked.

## File access

A Processor's file tools reach the folders it ticks under *Folders* in its *Access* and its own run folder, and nowhere
else. The folders come from **Settings → Folders**, which lists every folder on this computer a run may ever be handed,
each under a name and either *Read only* or *Read and write*. A node ticks a folder by that name, and picks *Read only*
or *Read and write* where Settings allows writing there. A flow names folders, never paths, so a flow copied to another
computer finds its folders there under the same names; a node ticking one that computer's Settings does not list stops
at its error port, saying which, rather than running without it.

With nothing ticked, Claude reads the run folder — the saved attachments — writes only through `save_file`, and
reads nothing else: not even the workspace's folder, where the flows and the files that say which MCP servers start
live, unless that folder, or one inside it, is listed in Settings and ticked. That is what a node reading mail from
outside should get: an email written to steer the agent reading it can reach nothing a person did not hand it. Each of
Read, Glob, Grep, Write and Edit is checked against those folders before it runs, links followed, and refused with the
reason when it reaches outside them.

*Run commands (Bash)* is a separate box, and it starts off. A command is held to no folder: it reaches whatever this
computer's user can, whatever is ticked. Tick it only for a skill that has to run a script.

A Processor from before Settings had folders had one box, *Read and write files anywhere, and run commands*. One that
had it ticked opens with *Run commands* ticked and *Read and write files anywhere* ticked under it, and is flagged on the
canvas: its run still reads and writes anywhere until that box is unticked, which is for good.

An Extractor's Read reaches its run folder alone, and only when it saves the attachments.
