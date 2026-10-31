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
- **Categorizer** — an if/else you write in prose. Give each branch a description; its model picks exactly one, and
  says why. Every model answers as TypeSafe AI's Jev does — a probability for each branch, *Unmatched* included — and
  the email leaves by the most likely one. The run's trace shows the whole answer. A Categorizer can run on
  [Jev](models.md#jev) itself, which gives no reason.
- **Extractor** — pulls fields out of the email (and its attachments, if you let it) into the [workspace
  schema](#named-schemas) it names, and puts the result in a named slot. It leaves by *Valid* when every required
  field was in the email and the result matches the schema, by *Incomplete* when something is missing or wrong, or by
  *Error*. Like a Processor, it has the workspace's skills, reads slots earlier nodes filled, and takes tools from the
  workspace's MCP servers; unlike one, it cannot draft a reply, move the email or run commands.
- **Processor** — runs Claude with the workspace's [skills](skills.md), loading the ones you tick first, and holding
  [tools scoped to this one email](skills.md#the-email-scoped-tools).
  It leaves by *Done*, by *Needs review* when it finished but a person has to decide or check something, or by
  *Error*. Give it an output slot and one of the workspace's schemas and its result fills that slot on *Done*, so a
  long job can be split into steps that each hand their work to the next — and a run that stops shows which step it
  stopped at.
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
reads the email, and any slots it ticks besides. The inspector's *Reads* list names the schema each slot carries
beside it, such as `order` · `Shipment`, or *No schema yet* when the node that fills it has not picked one.

Each card lists the slots it **reads** under its title, and each port shows the slot it **adds**, if any; hover one
for its type. Every slot has a colour of its own — the email's, then one per slot a node fills — and a wire takes the
colour of the newest slot it carries: the one its port adds, or else what the step before handed on. So a wire's
colour matches the chip of the slot it brings to the next card. A wire stays grey until a trigger reaches it. The
inspector's *Data* section spells out the rest: what every path into the node is sure to bring, and what leaves by
each port.

A slot counts at a node only if **every** path from a trigger to it fills that slot. A Processor reading `order`
behind both an Extractor's *Valid* port and a Categorizer branch that skips the Extractor is flagged on the canvas,
and the flow cannot be watched until that is fixed. A test run of such a flow stops at that node and says why.

### Named schemas

Every schema is the workspace's, **named** once, such as `Shipment`, and any Extractor or Processor in any of its
flows can pick it. No node keeps a schema of its own: an Extractor, or a Processor with an output slot, names one of the
workspace's, and is flagged on the canvas until it does. Every node that picks the same schema fills the same shape,
and its port and chips name the slot's type `Shipment`.

A schema is edited as a list of **fields**, with no JSON to write. Each field has a name, a kind (*Text*, *One of a
list*, *Number*, *Whole number*, *Yes / no*, *Group of fields*, *List*, or one of the workspace's named schemas), a
description, which is what Claude reads to fill it, and *Required*: a step passes only once every required field is
filled. *＋ Add field* adds one, ↑ ↓ reorder them, ✕ removes one, and a group or a list of groups opens to its own
fields. *JSON* beside *Fields* shows the same schema as JSON Schema, for anything the form has no control for. A field
the form cannot show, such as a map from any name to a list, is edited as JSON where it stands. Whatever the form
leaves alone, such as a list's `minItems`, is kept as it was.

The inspector's *Schema* picker offers each of the workspace's schemas. **New…** makes one and the node picks it at
once, starting from a copy of the one it named, if any. The fields below the picker are the shared ones, so an edit
changes the schema for every node in every flow that uses it; the hint under it says which. **Rename…** renames it and
every reference to it, in every flow. Deleting one is done from the start window's *Schemas* tab, and is refused while
any node or other schema still names it: there is no copy of it a node could keep instead. The refusal says which ones
name it.

Named schemas live in the workspace's `schemas` folder, a file each named after it, holding the JSON Schema itself.
A node or a field refers to one as `{"$ref": "#/schemas/<name>"}`, so one named schema can be built from others, such
as `Shipment` holding a `Settings`:

```json
// schemas/Settings.json
{"type": "object", "properties": {"output_dir": {"type": "string"}}, "required": ["output_dir"]}

// schemas/Shipment.json
{
  "type": "object",
  "properties": {
    "bl_no": {"type": "string", "description": "The House B/L number."},
    "settings": {"$ref": "#/schemas/Settings", "description": "The settings this run works from."}
  },
  "required": ["bl_no", "settings"]
}
```

A key beside `$ref`, such as that `description`, wins over the named schema's own. A run reads the schemas as it
starts and fills every reference in before each node does, so Claude only sees the whole schema. A node whose schema
names a schema the workspace lacks, or one that contains itself, is flagged on the canvas and leaves by *Error* if it
runs. A name is letters, digits and `_`, and two that differ only in case are one name, since Windows and macOS would
keep them in one file.

The app watches the `schemas` folder, so a file saved there in your editor, or brought in by a `git pull`, shows on
every canvas as it happens.

## Workspaces and flow files

A **workspace** is a folder holding flows, the skills and schemas they share, and an optional README:

```
<workspace>/
├─ flows/<name>.json        one file per flow
├─ skills/<name>/SKILL.md   the library every flow here ticks from
├─ schemas/<name>.json      the named schemas every flow here can pick
├─ .mcp.json                optional: MCP servers this workspace defines
└─ README.md                optional: what the workspace is for
```

One workspace is open at a time. The start window lists its flows — each one's size, when it was last edited, whether
a trigger in it is being polled — and from it you open, create, duplicate, rename and delete them. Its **Skills** tab
lists the skills they share, and which flows tick each one (see [Skills](skills.md#managing-skills)). Its **Schemas**
tab lists the [named schemas](#named-schemas): each one's description, its fields, the flows and nodes that use it,
and when it was last edited. The one picked shows every field with its kind and description, and **Edit…**,
**Duplicate…** and **Delete…** under them. **New schema** and **Edit…** (or a double-click) open the schema in a
dialog with its name and the same field editor as the inspector. Nothing is written until **Save**, renaming it there
carries every flow along, and a click outside asks before it throws edits away. **Duplicate…** starts a new schema
from a copy of an old one. Deleting one is refused while any node or schema names it, and the window says which.
Right-clicking one can also open its file in the app your system gives `.json` files, or show it in its folder; a file
the form cannot read opens there instead. A schema some node names but the folder no longer holds is listed at the
bottom, with **Create it…**. Its **MCP** tab lists the [MCP servers](skills.md#mcp-servers) defined in the workspace
(`.mcp.json`, `.vscode/mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`), which flows tick them,
and the tools an allowed server offers, with **Allow**, **Block** and **Edit** on the picked row, **Set…** beside each
value it looks up, and **Create .mcp.json** in the rail. Its **README** tab shows the `README.md` at the top of the workspace folder — a
repository's own README, for a workspace that is one.
**Open README.md** in its header opens the file in the app your system gives `.md` files, as a skill's **Edit** does;
with none, the rail offers **Write a README**, which starts one from a template naming the flows and opens it. The tab
shows what was saved when you come back to the window. Links in
it copy their target rather than opening it, and images show as their alt text. **☰ Flows** in the canvas's top bar
brings it back. **Switch workspace…** opens another one you have used, any folder, or a new one.
Switching stops watching every flow and closes every canvas, so it asks first when either would happen, and it is
refused while a run is under way or waiting.

**New workspace** asks for a name and a location — `Documents/Patchbay` the first time — and makes a folder named after
it there. **Open folder…** makes any folder the workspace, such as a git repository; its `flows`, `skills` and
`schemas` folders are made the first time something is written to them. A workspace is a folder you keep, not a copy the app holds, so
one kept in git is edited, run and committed from one place.

The workspace's folder is the working directory of every run of its flows. With file access off, a Processor can still
read the whole of it, so keep anything a step should not read somewhere else.

**New flow** and **Duplicate** ask for a name and save the flow in `flows`, in a file named after it. **Import flow
file…** copies a flow file somebody sent you into `flows`. A flow file put into `flows` by hand is listed too.

A flow's **id** never changes — renaming it, or its file, leaves its runs and the watcher's marks pointing at the same
flow. Renaming offers to rename the file too, ticked when the file is still the one the app chose. Deleting a flow
deletes its file; the skills and schemas it used stay in the workspace.

Opening a flow while a canvas is up on another asks whether to open it in that window or a second one beside it; a
flow already open raises its window rather than drawing it twice. Every canvas shows all of the workspace's runs, and
the whole console.
