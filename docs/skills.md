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
when no node is selected. Patchbay has no editor of its own: **Edit** opens a skill's `SKILL.md` in the app your system gives
`.md` files, and right-clicking a skill can also show its folder or delete it. **New** writes one from a template,
ticks it on the node whose list it came from, and opens it. **Import…** copies chosen `SKILL.md` files into the
library, each with the folder it sits in — which is how skills kept elsewhere, such as `~/.claude/skills`, come in.

The start window's **Skills** tab lists the same library beside the workspace's flows: each skill's description, which
flows tick it, and when it was last edited, with **New skill** and **Import skills…** in the rail. The skill picked has
**Edit SKILL.md** and **Delete…** under it. Edit, or a double-click, opens its `SKILL.md` in the app your system gives
`.md` files; right-clicking it can also show its folder. A skill some flow ticks but the folder
no longer holds is listed at the bottom, with the flows that tick it.

The app watches the workspace's `skills` folder, so a skill saved, renamed or deleted elsewhere — in your editor, Finder
or Explorer, a `git pull` — shows as it happens. A node still ticking one that has gone lists it on its own, to untick,
and a run reaching that node leaves by its error port naming the skill.

## MCP servers

A Processor or Extractor is handed only the server tools ticked under *Tools from MCP servers* — one by one, or *All*
of a server's — and a server with nothing ticked is not started for its run. So a step that reads mail from outside,
and needs a record lookup, holds that lookup and not the same server's tool that sends mail.

Servers come from the workspace, like its flows, skills and schemas, so a flow is handed the same ones on every
computer it is opened on. Patchbay reads `.mcp.json` (Claude Code), `.vscode/mcp.json`, `.cursor/mcp.json` and
`.gemini/settings.json` in that order, fills in `${VAR}`, `${VAR:-default}`, `${env:VAR}`, VS Code's `${input:id}` and
`${workspaceFolder}` ([as below](#tokens-and-other-values)), and starts commands in the workspace's folder. A name
defined in two files is taken from the first. Because a workspace's file can come from a cloned repository, a server
found there is not started — not even to list its tools — until you click **Allow** on it in the start window's **MCP**
tab or the inspector. Editing what a server starts asks again.

Servers you keep for every project in an agent itself — `claude mcp add --scope user`, or agy's own settings — stay
that agent's, for its own sessions. No run is handed them: a run starts with only the servers its node ticks.

The start window's **MCP** tab lists the workspace's servers with their state, which flows tick their tools, and
(once allowed) the tools each offers. From there you can allow or block them, open or create `.mcp.json`, or see any
server a flow ticks that is not in the workspace. These files are watched like the `skills` folder, so a server added
in your editor or by a `git pull` shows as it happens.

A node that ticks a server no run can be handed — not allowed yet, blocked, missing a value, or defined nowhere —
leaves by its error port saying which, rather than running without the tools it was built to use. So does one on a
Claude model whose server's definition sets a `cwd` other than the workspace folder: Claude starts every server there.
agy starts each where its definition says, but cannot reach a server over the older SSE transport. agy is handed a
run's servers in a file in that run's own folder, which the run is refused from reading or searching.

An app opened from the Finder or the Dock does not have a terminal's PATH, so a server's command — `npx`, `uvx`,
`node` — is also looked for in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, both to list its tools and in
a run. One installed by a version manager such as nvm or Volta lives elsewhere: give its full path.

A skill that calls another app's MCP tools (`mcp__<server-name>__*`) needs that server allowed in the workspace, and
the tools it calls ticked on the node, before it can run.

### Tokens and other values

Write a token into a server's `env` or `headers` as a variable rather than as itself —
`"Authorization": "Bearer ${CRM_TOKEN}"` — so it stays out of a file you commit, then set its value with **Set…**
beside the server in the start window's **MCP** tab, or in the inspector. A value set there is kept for that one server in that one workspace,
encrypted with the key your system keeps for Patchbay (the Keychain on macOS, DPAPI on Windows), in the app's data
rather than the workspace. It is opened only when that server starts — to list its tools, or for a run whose node
ticks it — and no window shows it again: it can be changed or cleared, not read. Another server naming the same
variable does not get it. Linux without a keyring has nothing to keep one in, and Patchbay says so rather than keep it
in the clear.

A variable is filled from the value set for the server first, then from Patchbay's environment, then from the
definition's own default, as in `${PORT:-3000}`. An app opened from the Finder or the Dock does not share your
terminal's environment. VS Code's `${input:id}` is only ever a value set here, shown with the description its file's
`inputs` give it. A server with a variable none of these fill can still be allowed, but is marked **needs a value**,
and a node that ticks it stops at its error port saying which, rather than starting it with a hole in its command.

## The email-scoped tools

Inside a Processor run, a skill gets an MCP server whose tools are bound to the one email being handled. An
Extractor's gets the same server, less `draft_reply` and `move_email`:

| Tool              | Always | What it does                                                                       |
|-------------------|--------|------------------------------------------------------------------------------------|
| `read_email`      | ✅     | The sender's own text, sender, attachment names — and the quoted thread on request |
| `record_note`     | ✅     | Writes a note into the run trace                                                   |
| `save_file`       | ✅     | Saves a text file into the run folder, by a bare file name, and returns its path   |
| `save_attachment` | opt-in | Saves into the run folder, returns paths                                           |
| `draft_reply`     | opt-in | Leaves an **unsent** draft in Outlook, written or from a template email            |
| `move_email`      | opt-in | Files the email into an Inbox subfolder                                            |

`save_attachment` also writes a workbook (`.xlsx`, `.xlsm`) out beside itself as CSV, one file per visible sheet, since
Read can't open one. Each cell reads as the sheet shows it — `51%` rather than `0.51`, dates as `YYYY-MM-DD` — and line
N of the CSV is row N of the sheet, so a figure can be traced to its cell.

`draft_reply` can reply with a template email kept in the mailbox (a `Templates` folder by default), found by subject:
it keeps the one `[[SECTION]]` asked for, fills its `{{PLACEHOLDERS}}`, and puts the named Outlook signature in
`{{SIGNATURE}}`. A template that cannot be filled completely fails the call rather than drafting half a reply.

There is no tool that takes an entry id, so a skill cannot reach another message however it is prompted — and **nothing
here sends mail.** A drafted reply waits in Outlook for a person. `read_email` does hand back this email's own entry
id, so a record a skill writes elsewhere can link back to the message it came from.

## File access

A Processor's own file access is a separate switch, *Read and write files anywhere, and run commands*, and it starts
off. Off, Claude reads the run folder — the saved attachments — and the workspace's folder, writes only through
`save_file`, and has no shell at all. That is what a node reading mail from outside should get: an email written to
steer the agent reading it can then reach nothing outside the workspace and change nothing in it. Keep anything a step
should not read out of the workspace's folder, and switch file access on only for a skill that has to run a script.
