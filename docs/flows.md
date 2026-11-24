# Flows

A **flow** is a graph with a trigger, or several, and any number of branches. Each node hands the email out of exactly **one**
output port, and the engine follows the single edge attached to it — so a run is a readable path rather than a cloud
of concurrent activity.

## The nodes

- **Outlook Trigger** — polls a mailbox through the real Outlook client and starts one run per new email. Tick the
  folders it reads in the Inbox's folder tree: each tick is that folder alone, so ticking just the Inbox leaves the
  folders in it out, and *+ below* ticks a folder with everything inside it. Unticking a folder unticks the folders
  inside it too. A folder made later — by you, or by a rule filing mail away — is not read until you tick it. A
  trigger reading more than one folder knows an email by sender, time and subject rather than by entry id, so filing
  one from one watched folder into another doesn't make it new again. Its **AI monitor** section brings a reviewer
  into every run it starts, which writes down what in the flow it would change — see
  [The AI monitor](runs.md#the-ai-monitor).
- **Categorizer** — an if/else you write in prose. Give each branch a description; its model picks exactly one, and
  says why. Every model answers as TypeSafe AI's Jev does — a probability for each branch, *Unmatched* included — and
  the email leaves by the most likely one. The run's trace shows the whole answer. A Categorizer can run on
  [Jev](models.md#jev) itself, which gives no reason.
- **Switch** — an if/else written as [rules](#switches) on what earlier steps found, with no model. Each of its routes
  is a port; the first rule that matches picks one, and an email no rule matches leaves by *Otherwise*.
- **Extractor** — pulls fields out of the email (and its attachments, if you let it) into the [workspace
  schema](#named-schemas) it names, and puts the result in a named slot. It leaves by *Valid* when every required
  field was in the email and the result matches the schema, by *Incomplete* when something is missing or wrong, or by
  *Error*. Like a Processor, it has the workspace's skills, reads slots earlier nodes filled, and takes tools from the
  workspace's MCP servers; unlike one, it cannot run commands.
- **Processor** — runs Claude with the workspace's [skills](skills.md), loading the ones you tick first, and holding
  [tools scoped to this one email](skills.md#the-email-scoped-tools).
  It leaves by *Done*, by *Needs review* when it finished but a person has to decide or check something, or by
  *Error*. Give it an output slot and one of the workspace's schemas and its result fills that slot on *Done*, so a
  long job can be split into steps that each hand their work to the next — and a run that stops shows which step it
  stopped at. It drafts, sends and moves no mail: a Create email, Send or Move email after it does.
- **Create email** — drafts a [reply](#create-email) to the email, or a new email, from a template email in the
  mailbox, its placeholders filled from what earlier steps found. It runs no model, and drafts nothing an earlier run
  already drafted. It leaves by *Drafted*, by *Already drafted*, or by *Error*.
- **Send** — [sends](#sending) the drafts a Create email made earlier in the same run, picked by the draft slots it
  ticks. Its sending is off by default, and a test run never sends. It leaves by *Sent*, by *Held*, or by *Error*.
- **Move email** — [files](#moving) the email into a folder in its mailbox, creating the folder if it does not exist,
  with no model. It leaves by *Moved* or by *Error*.
- **Terminal** — ends a path and records a disposition. It does nothing to the email: whatever a flow files or
  saves, one of its steps does, with its own tools.

The trigger does not process mail already sitting in a folder when you start watching — switching a flow on shouldn't
fire fifty runs for last week's inbox.

A Categorizer, Extractor or Processor runs on one model, and goes on to the fallback models listed in Settings → Agents
when that one is at its limit or out of reach, unless it is set to wait for its own. See [Models and agents](models.md).

A Processor's or an Extractor's **Access**, below its model, is folded to a line saying what its run may reach beyond the
email: its server tools, and a Processor's folders and whether it runs commands — `6 server tools from its skills · run
folder only · no commands`. Click it to open it. It opens on its own when the node has more than that: a folder, the
shell, a tool ticked on the node itself, a box left from before, or a server its tools need that is not allowed yet or
cannot start.

## Switches

A Categorizer decides from what the email says. Often an earlier step has already decided — an Extractor's
`quote.reply`, a Processor's `placement.logged_before` — and all that is left is to send the email the right way. A
**Switch** does that with no model, so it costs nothing to run and the same data always takes the same route.

Its **routes** are its ways out, each a port of its own, named as you like. Its **rules**, read top to bottom, each name
a field — a slot an earlier node filled and the path into it, such as `quote.reply` or `placement.answering.kind` — the
value that makes it match, and the route it sends the email down. The first rule whose field holds its value decides;
an email no rule matches leaves by *Otherwise*. The rate-replies flow's choice of reply, as a Switch with the routes
*Quote*, *No quote* and *Skip*:

| Field                      | is         | →        |
|----------------------------|------------|----------|
| `placement.logged_before`  | `true`     | Skip     |
| `quote.reply`              | `offer`    | Skip     |
| `placement.answering.kind` | `thanks`   | Skip     |
| `quote.reply`              | `quote`    | Quote    |
| `quote.reply`              | `no-quote` | No quote |

Several rules can lead to one route. A Switch does nothing to the email; the run's trace records how each rule read
and which one decided. Give it an **output slot** and every way out fills it with the `route` the email took — its
label, or `Otherwise` — and `why`, so a step where the routes meet again, such as one that logs the email whichever way
it went, can say which. A later Switch's rule on `route` is checked against the routes this one has.

Each rule is checked against the schema of the slot it reads, so the canvas flags a field that schema lacks, a value it
never holds — one outside a field's *One of a list*, or other than `true` or `false` for a *Yes / no* — a group
compared as one value, and a slot not every path fills. The field box offers the fields that reach the node, and the
value box a field's choices. A rule left leading to a route since removed is flagged too, and a route no rule leads to
is pointed out, since no email can leave by it.

## Create email

Many flows end the same way: thank the sender, confirm receipt, or tell someone else what came in, in wording the
office has already written. A **Create email** drafts that email without a model, so it costs nothing to run and gives
the same answer every time.

It drafts **a reply to this email**, or **a new email**. A new one goes *To* the addresses it names, separated by `;`
or `,`, copied to any under *Cc*, with its own *Subject*; any of the three can name a field an earlier node filled, in
braces, which the run writes in — `{{shipment.agent_email}}`, `Pre-alert received: B/L {{shipment.bl_no}}`. *Reply
to everyone* widens a reply from the sender to everyone on the email.

Under *From*, its **account** is the Outlook account it drafts from — the one the email came to, unless you pick
another. That account's `Templates` folder holds the template, the draft waits in its Drafts, and a Send after it sends
it from there. Its **signature** is picked from the ones Outlook keeps; Outlook keeps one set for all its accounts, so
every one is offered whichever account is chosen. The signature goes in the template's `{{SIGNATURE}}`, or below its
text when it has none — so a template with `{{SIGNATURE}}` needs one picked.

Its **template** is the subject of an email saved in the From account's `Templates` folder. One template can hold several
emails around a shared greeting and signature, each between `[[SECTION]]` and `[[/SECTION]]` markers, such as
`[[QUOTE]]…[[/QUOTE]]` and `[[NOQUOTE]]…[[/NOQUOTE]]`; its **section** is the one it drafts, and a template without
them is drafted whole. A new email keeps the template's whole document, its styles included; a reply takes its body,
above the quoted original. Its **placeholders** fill the template's `{{NAME}}`s, each from a field an earlier node
filled — `{{TOTAL}}` from `quote.total` — written in as text.

Each field it names is checked against the schema of the slot it reads, as a Switch's rules are, so the canvas flags
one that schema lacks, a group or a list where one value is written in, and a slot not every path fills. A field that
holds nothing when a run reaches it leaves by *Error*, drafting nothing.

Whether an email gets a reply, and which, is the path's to decide: a [Switch](#switches) before one Create email per
reply. The rate-replies flow's Switch above sends *Quote* to a Create email drafting `QUOTE`, *No quote* to one
drafting `NOQUOTE`, and *Skip* and *Otherwise* past both, to the step that logs the quote, where all four meet again.

A template it cannot fill whole — a section it lacks, a `{{PLACEHOLDER}}` it doesn't fill, a `{{SIGNATURE}}` with no
signature picked, a signature Outlook doesn't have — leaves by *Error*, drafting nothing, and every email fails the same way until it is fixed in Outlook.

It fills its **output slot** with what happened — `drafted`, the `section`, who it went `to`, the `account` it is in,
the draft's Outlook id and `why` — so the steps after it can say so.

**It only drafts, and never twice.** The email waits in the From account's Drafts folder for a person, or a [Send](#sending)
node after it, to send. Patchbay
records each draft, by the id Outlook gave it, in the app's data rather than the workspace. An email gets one reply
from a flow: a second run over it — a re-run, or one after a later step failed — finds the reply already drafted, by
whichever of the flow's Create email nodes, and leaves by *Already drafted* without drafting another, even when this
time its route led to a different one. A new email is the node's own: each Create email drafts one about an email, so
a flow can tell the office and the trucker each, once.

## Sending

While you are setting a flow up, a Create email's drafts wait in Outlook for you to read and send by hand. Once you
trust what it writes, a **Send** after it sends them, with no model.

Under *Sends*, tick the draft slots whose drafts it sends — one for a reply, or several when a run drafts both a reply
and a new email to the office. Only slots every path into the node fills with a Create email's *Draft* are offered; one
that holds anything else, or none at all, is flagged on the canvas.

**It sends only what this run drafted.** Each draft is sent by the id Outlook gave it when the Create email earlier in
this run made it, from the account that Create email drafted it in. A Create email that left by *Already drafted* puts no id in its slot, so an earlier run's draft is
passed over and never sent by a later run. Patchbay records each send in the app's data as well, so the same draft is
never sent twice. A draft Outlook can no longer find in Drafts — sent or deleted by hand since — or one Outlook could
not give an id to, leaves by *Error* rather than going unnoticed; if other drafts in the same step did go out, the
output slot lists both what was `sent` and what `failed`.

**Sending starts off, and test runs never send.** New Send nodes have *Send the drafts when a watched flow runs*
unticked, and the card on the canvas shows `Sending: off` or `Sending: on` at a glance. While it is off — and on every
test run, whether started from **Test run…** or by dragging an email onto the trigger — the step sends nothing and leaves by
*Held*, recording in the trace and in its output slot's `held` list who each draft would have gone to. Those drafts stay
in Outlook's Drafts to be sent by hand: turning sending on later does not reach back to send them on a re-run.

Every way out — *Sent*, *Held* and *Error* — fills its **output slot** with `sent`, `held`, `failed` and `why`.

## Moving

Once a flow has handled an email, a **Move email** files it into a folder in its mailbox, with no model.

The **folder** is a path from the top of the mailbox: `Inbox\Processed` is the Processed folder in the Inbox,
`Processed` the one beside the Inbox, where Outlook puts a folder made on the mailbox itself, and `Deleted Items\2026`
one in Deleted Items, which is found by its role whatever Outlook calls it. Click the folder box to open the folders
of the mailbox a trigger in the flow watches, as a tree with Outlook's own folders first, and pick one; with more than
one mailbox, the foot of the list chooses whose folders it shows. Typing in its search finds a folder by name, and a
path no folder has yet is offered as a new folder. Either way the email is filed in the mailbox it came to. The canvas
says where: *To Inbox\Processed*. If the folder is not there yet, the box marks it *new*, and Outlook creates it the
first time an email is filed there. The pencil beside the box types the path instead, for one that names a field an
earlier node filled, in braces, which the run writes in: `Inbox\Processed\{{shipment.client}}`; typing `{{` offers the
fields that reach the node. Each field is checked against
the schema of the slot it reads, and a field that is missing or blank when the run reaches the node leaves by *Error*
rather than filing into the parent folder.

A flow saved before the folder was a whole path opens with the path it filed into: a folder that was *In the Inbox*
becomes `Inbox\…`, one *Beside the Inbox* keeps its name, and a well-known folder stays as it was. It is written back
that way the next time the flow is saved.

Give it an **output slot** and both *Moved* and *Error* fill it with `moved`, the `folder` Outlook filed the email into,
`folderCreated` and `why`.

Outlook gives an email a new id when it files it, and the run follows the email to it, so a step after a Move email —
a Create email replying to it, or a Processor reading it — finds it in the folder it was filed in, as does a rerun.

On a Mac, Outlook ignores a scripted move for a Microsoft 365 mailbox it syncs through Microsoft's cloud. Patchbay then
files the email through Outlook's own *Message → Move → Choose Folder…*: Outlook comes to the front for a moment, the
email is opened, and so marked read, and whatever was in front is put back. For that, Patchbay needs **Accessibility**
access in *System Settings → Privacy & Security → Accessibility*, called *Device Control and Data Access* on macOS 27.
Without it the email leaves by *Error*, naming the setting. Outlook's Move dialog finds folders by name alone, so no
other folder in the mailbox may have the folder's name, or have it inside its own (`Processed 2025` would for
`Processed`). If one does, the email leaves by *Error*, naming the folders found, and is not moved. Outlook may refuse
to create a folder on such a mailbox, so make it yourself in Outlook first.

## Data on the wire

A run carries named **slots**. The trigger fills `email`; an Extractor fills the slot it names, and only on *Valid*;
a Processor with an output slot fills it only on *Done*, and one that says *Done* with a result that doesn't match its
schema leaves by *Error* instead. A node adds slots and never takes one away, so the email is still there for whichever
step replies to it or files it.

A Processor ticks what it reads: the email, any slots earlier nodes filled (each goes into its prompt as JSON), or
both. Under the email, *Its attachments* lets it save them into the run folder to read; unticked, it works from the body
alone. Without the email it gets none of the email's content, and works from those slots alone — so an Extractor can
pull the fields, and a Processor work from them without the email's wording to steer it. An Extractor always
reads the email, with its attachments when *Its attachments* is ticked under it, and any slots it ticks besides, and a
Switch the slots its rules name. The inspector's *Reads* list names the schema each slot carries
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
├─ .patchbay/export/        optional: files an export carries in place of these
└─ README.md                optional: what the workspace is for
```

One workspace is open at a time. The start window lists its flows — each one's size, when it was last edited, whether a
trigger in it is being polled — and from it you open, create, duplicate, rename and delete them. Its **Skills** tab
lists the skills they share, and which flows tick each one (see [Skills](skills.md#managing-skills)). Its **Schemas**
tab lists the [named schemas](#named-schemas): each one's description, its fields, the flows and nodes that use it, and
when it was last edited. The one picked shows every field with its kind and description, and **Edit…**, **Duplicate…**
and **Delete…** under them. **New schema** and **Edit…** (or a double-click) open the schema in a dialog with its name
and the same field editor as the inspector. Nothing is written until **Save**, renaming it there carries every flow
along, and a click outside asks before it throws edits away. **Duplicate…** starts a new schema from a copy of an old
one. Deleting one is refused while any node or schema names it, and the window says which. Right-clicking one can also
open its file in the app your system gives `.json` files, or show it in its folder; a file the form cannot read opens
there instead. A schema some node names but the folder no longer holds is listed at the bottom, with **Create it…**. Its
**MCP** tab lists the [MCP servers](skills.md#mcp-servers) defined in the workspace (`.mcp.json`, `.vscode/mcp.json`,
`.cursor/mcp.json`, `.gemini/settings.json`), which flows tick them, and the tools an allowed server offers, with
**Allow**, **Block** and **Edit** on the picked row, **Set…** beside each value it looks up, and **Create .mcp.json** in
the rail. Its **README** tab shows the `README.md` at the top of the workspace folder — a repository's own README, for a
workspace that is one. **Open README.md** in its header opens the file in the app your system gives `.md` files, as a
skill's **Edit** does; with none, the rail offers **Write a README**, which starts one from a template naming the flows
and opens it. The tab shows what was saved when you come back to the window. Links in it copy their target rather than
opening it, and images show as their alt text. **☰ Flows** in the canvas's top bar brings it back. **Switch workspace…**
opens another one you have used, any folder, or a new one. Switching stops watching every flow and closes every canvas,
so it asks first when either would happen, and it is refused while a run is under way or waiting.

**New workspace** asks for a name and a location — `Documents/Patchbay` the first time — and makes a folder named after
it there. **Open folder…** makes any folder the workspace, such as a git repository; its `flows`, `skills` and `schemas`
folders are made the first time something is written to them. A workspace is a folder you keep, not a copy the app
holds, so one kept in git is edited, run and committed from one place.

**Export workspace…** saves the open workspace as one zip, to hand to someone who opens it in Patchbay. It holds a
folder named after the workspace's, so unzipping each new export gives the same folder, with what Patchbay reads in
it: `flows`, `skills` and `schemas`, the MCP server files and the README. Nothing else in the folder goes, so a
workspace that is a whole repository hands out only its workspace — but for a file inside it that a server in the
export starts, such as the script a `node` command runs, which goes too, unless it is a `.env` file or sits in
`node_modules` or `.git`. A file kept in `.patchbay/export/` goes in place of the one at the same path, or beside the
rest when there is none: a workspace whose `.mcp.json` runs its server from source here can keep one in
`.patchbay/export/` that starts the copy an installed app keeps, and the script that finds it. What has been allowed,
the values set for servers, and the runs are this machine's, in the app's data, and stay behind: whoever opens the
export allows its servers for themselves.

The workspace's folder is the working directory of every run of its flows. Even so, a Processor's file tools do not
reach it unless it, or a folder inside it, is listed in Settings → Folders and ticked on the node (see [File
access](skills.md#file-access)). A node that may run commands is held to none of this.

**New flow** and **Duplicate** ask for a name and save the flow in `flows`, in a file named after it. **Import flow
file…** copies a flow file somebody sent you into `flows`. A flow file put into `flows` by hand is listed too.

A flow's **id** never changes — renaming it, or its file, leaves its runs and the watcher's marks pointing at the same
flow. Renaming offers to rename the file too, ticked when the file is still the one the app chose. Deleting a flow
deletes its file; the skills and schemas it used stay in the workspace.

Opening a flow while a canvas is up on another asks whether to open it in that window or a second one beside it; a
flow already open raises its window rather than drawing it twice. Every canvas shows all of the workspace's runs, and
the whole console.
