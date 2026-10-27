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
for its type. Every slot has a colour of its own — the email's, then one per slot a node fills — and a wire takes the
colour of the newest slot it carries: the one its port adds, or else what the step before handed on. So a wire's
colour matches the chip of the slot it brings to the next card. A wire stays grey until a trigger reaches it. The
inspector's *Data* section spells out the rest: what the node reads, what every path into it is sure
to bring, and what leaves by each port.

A slot counts at a node only if **every** path from a trigger to it fills that slot. A Processor reading `order`
behind both an Extractor's *Valid* port and a Categorizer branch that skips the Extractor is flagged on the canvas,
and the flow cannot be watched until that is fixed. A test run of such a flow stops at that node and says why.

### Named schemas

A slot's schema can be one the node keeps to itself, or one **named** for the whole flow, such as `Shipment`, which
any Extractor or Processor in it can pick. Every node that picks it fills the same shape, and its port and chips name
the slot's type `Shipment` rather than `JSON · 9 fields`.

The inspector's *Schema* picker offers *This node's own* and each named schema. **New…** names what the node has now
and switches the node to it. On a named schema, the JSON below it is the shared one, so an edit changes it for every
node that uses it. **Rename…** renames it and every reference to it. **Delete…** gives each node that used it a copy of
its own, so nothing breaks. Leaving a named schema for *This node's own* starts from a copy of it. Picking a named
schema over one of the node's own replaces it, so the app asks first.

Named schemas live in the flow file, under `schemas`, and a node or a field refers to one as
`{"$ref": "#/schemas/<name>"}`. So one named schema can be built from others, such as `Shipment` holding a `Settings`:

```json
"schemas": {
  "Settings": {"type": "object", "properties": {"output_dir": {"type": "string"}}, "required": ["output_dir"]},
  "Shipment": {
    "type": "object",
    "properties": {
      "bl_no": {"type": "string", "description": "The House B/L number."},
      "settings": {"$ref": "#/schemas/Settings", "description": "The settings this run works from."}
    },
    "required": ["bl_no", "settings"]
  }
}
```

A key beside `$ref`, such as that `description`, wins over the named schema's own. A run fills every reference in
before the node starts, so Claude only sees the whole schema. A node whose schema names a schema the flow lacks, or
one that contains itself, is flagged on the canvas and leaves by *Error* if it runs.

## Workspaces and flow files

A **workspace** is a folder holding flows and the skills they share:

```
<workspace>/
├─ flows/<name>.json        one file per flow
└─ skills/<name>/SKILL.md   the library every flow here ticks from
```

One workspace is open at a time. The start window lists its flows — each one's size, when it was last edited, whether
a trigger in it is being polled — and from it you open, create, duplicate, rename and delete them. Its **Skills** tab
lists the skills they share, and which flows tick each one (see [Skills](skills.md#managing-skills)). **☰ Flows** in the
canvas's top bar brings it back. **Switch workspace…** opens another one you have used, any folder, or a new one.
Switching stops watching every flow and closes every canvas, so it asks first when either would happen, and it is
refused while a run is under way or waiting.

**New workspace** asks for a name and a location — `Documents/Patchbay` the first time — and makes a folder named after
it there. **Open folder…** makes any folder the workspace, such as a git repository; its `flows` and `skills` folders
are made the first time something is written to them. A workspace is a folder you keep, not a copy the app holds, so
one kept in git is edited, run and committed from one place.

The workspace's folder is the working directory of every run of its flows. With file access off, a Processor can still
read the whole of it, so keep anything a step should not read somewhere else.

**New flow** and **Duplicate** ask for a name and save the flow in `flows`, in a file named after it. **Import flow
file…** copies a flow file somebody sent you into `flows`, with any skills it carries that the workspace does not have.
A flow file put into `flows` by hand is listed too.

A flow's **id** never changes — renaming it, or its file, leaves its runs and the watcher's marks pointing at the same
flow. Renaming offers to rename the file too, ticked when the file is still the one the app chose. Deleting a flow
deletes its file; the skills it ticked stay in the workspace.

Opening a flow while a canvas is up on another asks whether to open it in that window or a second one beside it; a
flow already open raises its window rather than drawing it twice. Every canvas shows all of the workspace's runs, and
the whole console.
