# Skills and tools

## Skills

A skill is a `SKILL.md` file with frontmatter, exactly as Claude Code defines them. There are **two libraries**, and
the inspector lists both, one above the other:

```
<userData>/workspace/global/skills/<name>/SKILL.md                  shared by every flow
<folder holding the flow's file>/.claude/skills/<name>/SKILL.md     this flow only
```

**Global** is the shared shelf: any flow can tick these, and editing one changes it everywhere. **Flow** skills sit in
the flow's own folder — the working directory its nodes run in — so only that flow sees them. Two flow files kept in
one folder share it, and its library with it. The two libraries may hold the same name without either shadowing the
other: a node stores a global tick as `global:<name>` and its own as the bare name.

The global library is seeded on first run from `skillSeedPath` in Settings, or else `./skills`, falling back to one
starter skill if neither exists. Seeding runs only while that library is empty, or holds nothing but that starter
skill, so it never fights an edit you made.

### Managing skills

The list sits in a Processor's or Extractor's inspector, where a tick lets the node use a skill, and on its own when no
node is selected. Patchbay has no editor of its own: **Edit** opens a skill's `SKILL.md` in the app your system gives
`.md` files, and right-clicking a skill can also show its folder or delete it. **New** writes one from a template,
ticks it on the node whose list it came from, and opens it.

The app watches every folder the two libraries read, so a skill saved, renamed or deleted elsewhere — in your editor,
Finder or Explorer, a `git pull` — shows as it happens. A node still ticking one that has gone lists it on its own, to
untick, and a run reaching that node leaves by its error port naming the skill.

- **Move** — drag a skill onto the other library. The open flow's ticks are re-pointed as it goes (`global:x` ↔ `x`).
  A skill leaving the global shelf is one other flows can no longer tick, and one landing on a name already there
  replaces it, so both are asked about first.
- **Import…** pulls a folder of existing skills into the library it sits on.
- **Opening a flow file** that carries skills of its own writes them into `.claude/skills` beside it the first time,
  and adds any global skill whose name is still free. It never rewrites a skill already there.

**Settings → Global skills** links folders of skills on the machine — `~/.claude/skills`, say — into the global
library, which reads and writes them in place, copying nothing. The app workspace's own folder is always read too, and
is where new skills are saved. The linked folders are ordered: when two hold a skill of the same name the higher one's
is used, the workspace's comes last, and the others are shown as hidden. Unlinking a folder deletes nothing.

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
off. Off, Claude reads the run folder — the saved attachments — and the flow's folder, writes only through `save_file`,
and has no shell at all. That is what a node reading mail from outside should get: an email written to steer the agent
reading it can then reach nothing beyond its own run. Switch it on only for a skill that has to run a script.
