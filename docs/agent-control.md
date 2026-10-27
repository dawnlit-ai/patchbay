# Letting an agent drive it

There are two kinds of MCP server in this app, pointing opposite ways. A Processor is *handed* servers — the
[email-scoped one](skills.md#the-email-scoped-tools), plus whatever you add under **Settings → MCP servers**. This one
is the other direction: Patchbay's own, which an agent connects *to* in order to drive the app. Switch it on under
**Settings → Agent control** and paste the command shown there into a terminal:

```bash
claude mcp add --transport http patchbay http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"
```

After that, "wire me a flow that sorts invoices from support requests and runs the invoice skill on the first branch" is
something you can say to Claude Code and watch happen on the canvas. An agent writes through the same stores the window
does, and the window re-reads what it changed as it goes. A canvas edit made just before an agent's write to the same
flow is refused rather than saved over it: the canvas says so, and shows the flow as the agent left it.

## Tools

| Area      | Tools                                                                         |
|-----------|-------------------------------------------------------------------------------|
| Workspace | `get_workspace`                                                               |
| Flows     | `list_flows`, `get_flow`, `create_flow`, `rename_flow`, `delete_flow`         |
| Graph     | `add_node`, `update_node`, `remove_node`, `connect`, `disconnect`             |
| Schemas   | `list_schemas`, `set_schema`, `rename_schema`, `delete_schema`                |
| Skills    | `list_skills`, `get_skill`, `write_skill`, `import_skills`, `delete_skill`    |
| Mailbox   | `list_accounts`, `list_folders`, `list_recent_emails`                         |
| Running   | `get_status`, `start_watching`, `stop_watching`, `test_run`, `cancel_run`     |
| Runs      | `list_runs`, `get_run`, `get_console`                                         |
| Settings  | `get_settings`, `list_server_tools`                                           |

Every tool works on the workspace open in the app: its flows, its skills, its schemas and its runs.

`get_flow` hands back each node with the output ports its configuration currently gives it, which is what makes wiring
possible without guessing. Everything an agent writes goes through the same repair an opened flow file gets, so a
value of the wrong type falls back to its default rather than reaching a run — and an edge left hanging by an edit is
dropped, with the tool that dropped it saying how many.

Named schemas are the workspace's, not a flow's: `set_schema` writes `schemas/<name>.json`, which a node in any flow
picks as `{"$ref": "#/schemas/<name>"}`, and `list_schemas` says which nodes in which flows use each one.
`rename_schema` and `delete_schema` carry the change through every flow naming it.

`write_skill` writes one `SKILL.md` into the workspace's library; a skill with scripts or references beside it comes in
whole through `import_skills`, from a folder on this machine, optionally narrowed to the names wanted. `delete_skill`
names every flow still ticking the skill it deleted.

A test run's id comes back before the run starts, and it can wait — behind a run of the same flow, or for a free slot
under *Runs at once*. `get_run` says which, `list_runs` puts what is queued and under way first, and `cancel_run` takes
a queued one out before it starts. When an email never became a run at all, `get_console` reads the console.

## What it cannot do

- **No tool reaches into the mailbox for a message.** An agent lists a folder to pick an email to test against;
  fetching a body is the job of the run's own scoped tools, and those cannot reach a second message. A run already
  recorded is another matter — `get_run` returns the prompts a node sent, email and all, because a trace you cannot
  read is not a trace.
- **No tool writes settings.** The Claude and agy executables and the servers handed to a Processor decide what code
  a run executes, so they stay with the person at the window.
- **No tool opens another workspace.** Switching closes the person's canvases and stops their flows being watched.
- **Nothing sends mail.** Nothing in this app does.

## Security

It is off until you switch it on. When it is on it binds to `127.0.0.1` only; every request has to carry the token
Settings shows, and **New token** cuts off anything still holding the old one. A request whose `Host` is not this
listener, or that carries an `Origin` at all, is refused before the token is even looked at — those are the two headers
a web page cannot forge, and a page is the one thing that can be told to post to a loopback port without you knowing.
Close the last window and the server stops with it.

`test_run`, `start_watching` and `delete_flow` spend money or destroy work. They are ordinary tool calls, so whatever
permission prompt your client puts in front of a tool is what keeps a person in the loop.
