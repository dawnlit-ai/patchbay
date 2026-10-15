# Flows

A **flow** is a graph with one trigger and any number of branches. Each node hands the email out of exactly **one**
output port, and the engine follows the single edge attached to it — so a run is a readable path rather than a cloud
of concurrent activity.

## The nodes

- **Outlook Trigger** — polls a mailbox through the real Outlook client and starts one run per new email. Tick the
  folders it reads in the Inbox's folder tree: each tick is that folder alone, so ticking just the Inbox leaves the
  folders in it out, and *+ below* ticks a folder with everything inside it. Unticking a folder unticks the folders
  inside it too. A folder made later — by you, or by a rule filing mail away — is not read until you tick it. A
  trigger reading more than one folder knows an email by sender, time and subject rather than by entry id, so filing
  one from one watched folder into another doesn't make it new again.
- **Categorizer** — an if/else you write in prose. Give each branch a description; Claude picks exactly one, and says
  why.
- **Extractor** — pulls fields out of the email (and its attachments, if you let it) into the JSON Schema you give it,
  and puts the result in a named slot. It leaves by *Valid* when every required field was in the email and the result
  matches the schema, by *Incomplete* when something is missing or wrong, or by *Error*. Like a Processor, it can tick
  skills, read slots earlier nodes filled, and take tools from the MCP servers in Settings; unlike one, it cannot draft
  a reply, move the email or run commands.
- **Processor** — runs Claude with the skills you tick, holding [tools scoped to this one email](skills.md#the-email-scoped-tools).
  It leaves by *Done*, by *Needs review* when it finished but a person has to decide or check something, or by
  *Error*. Give it an output slot and a JSON Schema and its result fills that slot on *Done*, so a long job can be
  split into steps that each hand their work to the next — and a run that stops shows which step it stopped at.
- **Terminal** — ends a path and records a disposition. It does nothing to the email: whatever a flow files or
  saves, one of its steps does, with its own tools.

The trigger does not process mail already sitting in a folder when you start watching — switching a flow on shouldn't
fire fifty runs for last week's inbox.

A Categorizer, Extractor or Processor can run on more than one model, each a fallback for the one before. See
[Models and agents](models.md).

## Data on the wire

A run carries named **slots**. The trigger fills `email`; an Extractor fills the slot it names, and only on *Valid*;
a Processor with an output slot fills it only on *Done*, and one that says *Done* with a result that doesn't match its
schema leaves by *Error* instead. A node adds slots and never takes one away, so the email is still there for whichever
step replies to it or files it.

A Processor ticks what it reads: the email, any slots earlier nodes filled (each goes into its prompt as JSON), or
both. Without the email it gets none of the email's content, but drafting a reply and moving the email still act on
it — so an Extractor can pull the fields, and a Processor draft a templated reply from them alone. An Extractor always
reads the email, and any slots it ticks besides.

Each card lists the slots it **reads** under its title, and each port shows the slot it **adds**, if any; hover one
for its type. The inspector's *Data* section spells out the rest: what the node reads, what every path into it is sure
to bring, and what leaves by each port.

A slot counts at a node only if **every** path from a trigger to it fills that slot. A Processor reading `order`
behind both an Extractor's *Valid* port and a Categorizer branch that skips the Extractor is flagged on the canvas,
and the flow cannot be watched until that is fixed. A test run of such a flow stops at that node and says why.

## Flow files

The app opens on a start page listing every flow this install holds — its size, when it was last edited, whether a
trigger in it is being polled. From it you open, create, duplicate, rename and delete flows, and open a flow file
somebody sent you. **☰ Flows** in the canvas's top bar brings it back.

Flows are files you keep, not copies the app holds. **New flow** and **Duplicate** ask for a name and a location —
`Documents/Patchbay` the first time — and make a folder named after the flow there, holding its `flow.json`; a
duplicate's folder gets a copy of the original's own skills too. **Open flow file…** takes a flow file wherever it
already is, and copies nothing. A flow an agent makes without naming a location lives in the app workspace under
`flows/`.

Either way every edit is saved back to that file, and the folder it sits in is the flow's **project folder**: the
working directory its Processors run in, with the flow's own skills in `.claude/skills` — so a flow kept in a git
repository is edited, run and committed from one place. Keep each flow in a folder of its own: with file access off, a
Processor can still read the flow's whole folder.

A flow's **id** never changes — renaming it, or moving its file, leaves its runs and the watcher's marks pointing at
the same flow. Renaming offers to rename the folder too, ticked when the folder is still the one the app chose. A
rename or a delete is refused while a run is using the flow's directory. Deleting a flow kept outside the workspace
only takes it off the list — the file and its folder stay as they are.

Opening a flow while a canvas is up on another asks whether to open it in that window or a second one beside it; a
flow already open raises its window rather than drawing it twice. Runs and the console belong to the workspace, so
every canvas shows all of both.
