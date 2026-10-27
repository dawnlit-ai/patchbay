# Runs and the console

## The run log

Every email produces a `Run`, and every node it touches produces a `Pass`:

- which port it left by, and the one-line reason
- the full prompt sent to the model
- every tool call with its arguments, and every result
- Outlook side effects (body read, attachment saved, draft left, email moved)
- when it started and finished

Select a run in the bottom panel and the canvas lights up the exact nodes and edges that email traveled, with each node
showing its pass number and outcome.

A run under way shows where it is as it goes. The node it is at pulses amber on the canvas, saying what it is doing —
waiting for the model, running a tool, writing — and in the panel its pass sits open below the finished ones, with
tool calls and the agent's text arriving as they happen. The run's file is written as it goes too, so a run cut off by
a crash still shows the node it was at and what it had done there.

Right-click a run to put its email through the flow again (once whatever stopped it has been fixed, say) or to delete
it. The new run starts at the trigger the email came in by and reads the flow as it is now.

Runs are plain JSON — one file per run, plus a JSONL index — in the app's data folder, kept apart for each workspace,
and the runs panel shows the open workspace's. They stay out of the workspace itself, which may be a git repository,
because a trace holds the mail it handled. These records exist to be read when something has gone wrong, so a file you
can open and paste into a bug report wins over a database.

## The console

A run explains why an email went where it did. It cannot explain an email that never became a run, and that is what
the **Console** tab beside Runs is for. It records what the app did outside any one run:

- **watcher** — watching started and stopped, what each poll found, the first poll that marks a folder's mail as seen
  without running it, a poll whose every email was new (so more may have arrived than one poll takes), and queued
  email dropped by Stop
- **run** — each run starting and how it ended, with a link to its trace
- **outlook** — every call to the client, how long it took, and how long it waited in the queue behind another
- **agent** — the MCP server listening or failing to, every tool call an agent makes and its input, and every request
  refused
- **app** — startup, and which workspace it opened on

Warnings and errors you have not looked at are counted on the tab. The level filter starts at *Info and up*; routine
lines — a poll that found nothing, an Outlook call that worked — are *debug*, shown under *Everything*.

The window keeps the last 2,000 lines. Every line is also appended to `<userData>/workspace/logs/<date>.jsonl`, one file
per day, kept for 14 days — **Folder** opens it, and **Clear** empties the window without touching the files.
