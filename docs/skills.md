# Skills and tools

## Skills

A skill is a `SKILL.md` file with frontmatter, exactly as Claude Code defines them. A workspace has **one library**, in
its `skills` folder, and every flow in the workspace ticks from it:

```
<workspace>/skills/<name>/SKILL.md
```

A node stores a tick as the skill's name, so editing a skill changes it for every flow here that ticks it. A flow saved
while Patchbay had a global library and one per flow ticks the global one's skills as `global:<name>`; those read as the
plain name now.

A new workspace starts with one starter skill. A folder opened as a workspace starts with whatever its `skills` folder
holds — nothing, if it has none yet.

A run is handed a copy of just the skills its node ticks, as a plugin Claude knows as `workspace`, so a trace shows a
step loading `workspace:<name>`. A skill saved while a run is under way reaches the next run, not that one.

### Managing skills

The list sits in a Processor's or Extractor's inspector, where a tick lets the node use a skill, and on its own when no
node is selected. Patchbay has no editor of its own: **Edit** opens a skill's `SKILL.md` in the app your system gives
`.md` files, and right-clicking a skill can also show its folder or delete it. **New** writes one from a template,
ticks it on the node whose list it came from, and opens it. **Import…** copies chosen `SKILL.md` files into the
library, each with the folder it sits in — which is how skills kept elsewhere, such as `~/.claude/skills`, come in.

The start window's **Skills** tab lists the same library beside the workspace's flows: each skill's description, which
flows tick it, and when it was last edited, with **New skill** and **Import skills…** in the rail. Double-clicking a
skill opens its `SKILL.md`; right-clicking it can show its folder or delete it. A skill some flow ticks but the folder
no longer holds is listed at the bottom, with the flows that tick it.

The app watches the workspace's `skills` folder, so a skill saved, renamed or deleted elsewhere — in your editor, Finder
or Explorer, a `git pull` — shows as it happens. A node still ticking one that has gone lists it on its own, to untick,
and a run reaching that node leaves by its error port naming the skill.

Importing a flow file that carries skills of its own writes them into the library, never over a skill already there.

## MCP servers

A Processor or Extractor is handed only the server tools ticked under *Tools from MCP servers* — one by one, or *All*
of a server's — and a server with nothing ticked is not started for its run. So a step that reads mail from outside,
and needs a record lookup, holds that lookup and not the same server's tool that sends mail. Add servers under
**Settings → MCP servers**.

A skill that calls another app's MCP tools (`mcp__<server-name>__*`) needs that server added there, and the tools it
calls ticked on the node, before it can run.

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
