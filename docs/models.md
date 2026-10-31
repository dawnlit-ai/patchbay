# Models and agents

Patchbay runs your nodes on agents you install yourself: Claude Code, the Antigravity CLI (`agy`), or both. Neither
is required — Patchbay opens and you can build flows without them — but a Categorizer, Extractor or Processor runs on
one, so installing at least one is recommended. A Categorizer can also run on [Jev](#jev), TypeSafe AI's model, with
an API key. **Settings → Agents** shows each one's version, whether it is signed in, and how much of its plan's 5-hour
and weekly limits it has used.

It also lists the agents in order. The model lists offer each agent's models in that order, and a new node starts on
the first one's it can run on — move Antigravity above Claude and new nodes start on one of agy's models. Switch an agent off and its
models leave the lists, it is no longer checked, and a step on one of its models goes straight to its next model; one
agent always stays on.

## Fallback models

A Categorizer, Extractor or Processor lists its **Models**, each with its own effort level, in the order its step
tries them: it runs on the first one that is on, and the others are its fallbacks — agy's Sonnet, say, then agy's
Gemini Pro, then Claude's own Sonnet. Drag a model up or down the list to change its turn, or switch one off to pass it
over without losing it; one is always on.

A step moves on only when the model before is at its usage limit, or its agent is switched off, not installed or cannot be reached —
and never once the step has changed something: a Processor that drafted a reply before its quota ran out is not run
again. A model known to be at its limit is passed over until the reset its agent named, and the run's trace says each
time a step moved on and why. The last model waits for its limit to reset rather than failing, as a node with one
model does.

## Claude Code

Install [Claude Code](https://code.claude.com/docs/en/setup) and sign in, with a Claude account or an Anthropic API
key. Patchbay does not include it: it drives Claude through the Claude Agent SDK, which runs the `claude` installed on
your computer — found where Claude Code's installers put it or on the PATH, or at the path set under
**Settings → Agents** — and reuses its login.

The inspector's model lists come from that login, marked *· claude*, so a new model appears without a new build of
the app. So do the effort levels, which differ from model to model. While Claude is listed first, new nodes start on
`opus`, the alias for the newest Opus.

Until Claude Code is installed, Settings → Agents says so, Claude's models are missing from the lists, new nodes start
on the first model another agent offers instead, and a step on a Claude model goes to its fallback if it has one.

## agy

The Antigravity CLI runs a node on Gemini, and on the Claude and GPT models beside it, which spend agy's own Google
quota rather than your Claude plan. agy keeps one quota for its Gemini models and another for its Claude and GPT ones,
so Gemini still answers once agy's Claude models are used up.

Install it and sign in. It is found where it installs itself, in `~/.local/bin`, or at the path set under
**Settings → Agents**. Its models join the model lists marked *· agy*, each with the effort levels agy lists it at;
agy gives them no default level, so a node on one always names its level.

Each run gets a workspace of its own holding the node's skills and servers, with a hook that refuses every tool the
node was not given — agy's shell, browser and web search included. The hook can refuse but not grant: headless, agy
calls an MCP tool only when its own settings allow it, so **each tool a node uses needs a rule** under
`permissions.allow` in `~/.gemini/antigravity-cli/settings.json`:

```
mcp(patchbay_<server>/<tool>)
```

A run that is refused one says which rules to add. A Processor with file-system access cannot run on agy.

## Jev

[Jev](https://typesafe.ai) is TypeSafe AI's model. It writes no text: asked a question with named answers, it gives
each answer a probability. That is exactly a Categorizer's question, so a Categorizer can run on it — and no other
node can, or is offered its models. It is much cheaper and faster than an agent for the one call a Categorizer makes,
and it spends neither Claude's nor agy's limits, which leaves them to the Processors.

It is off until you switch it on under **Settings → Agents**, since each email a Categorizer sorts on it is sent to
TypeSafe AI. Give it an API key there — kept encrypted on this computer and never shown again — or set
`TYPESAFE_AI_API_KEY` in Patchbay's environment. Its models join a Categorizer's list marked *· jev*: `jev-latest`,
which moves to each new release, and `jev-preview`. TypeSafe lists no versions, so a version seen answering —
`jev-1.14.0`, say — joins the list once it has, for a node to be pinned to.

A Categorizer on Jev routes the email by its most likely category, as on any model, but gives no reason: its summary
names the runner-up instead (*Sales · 77%, then Support · 18%*). The trace shows the question sent, the whole answer,
and the tokens it took. A refused key, an outage that outlasts two retries, or a rate limit hands the step to its next
model; on the last one, a rate limit is waited out.

## Costs

Every Categorizer pass is one model call; every Processor pass is an agent loop that runs until the agent is done.
The app neither caps nor records what either spends — that is left to your plan or API account, and to whatever usage
view it gives you. Classification runs about a cent on Opus; a processing run depends entirely on the skill. Jev bills
the key by input token, and its trace says how many each pass took: a few hundred for a short email.
