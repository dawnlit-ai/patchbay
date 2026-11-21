import { z } from 'zod';
import {
    type CategorizerConfig,
    type CreateEmailConfig,
    createEmailProblems,
    decideSwitch,
    DRAFTED_PORT,
    type DraftOutcome,
    type ExtractorConfig,
    fieldText,
    fillFields,
    type FlowNode,
    type FolderGrant,
    HELD_PORT,
    type JsonSchema,
    type ModelChoice,
    MOVED_PORT,
    type MoveEmailConfig,
    type MoveEmailOutcome,
    moveEmailProblems,
    moveFolderLabel,
    moveFolderPath,
    needsField,
    nodeSchemaIssue,
    outputPorts,
    type ProcessorConfig,
    resolveNode,
    type Schemas,
    type SendConfig,
    type SendFailure,
    type SendOutcome,
    sendProblems,
    SENT_PORT,
    SKIPPED_PORT,
    stepModels,
    type SwitchConfig,
    type SwitchOutcome,
    type TerminalConfig,
    UNMATCHED_PORT,
} from '@shared/flow';
import { findFolder, type FolderSetting, nodeTools } from '@shared/settings';
import { type EmailEnvelope, emailHeader, type LiveText, now, type TraceEvent } from '@shared/trace';
import { errorMessage, isObject } from '@shared/util';
import type { AgentMcpServer, AgentRunRequest } from '../agents';
import type { ChoiceQuestion } from '../agents/decision';
import { agents } from '../agentHost';
import { createEmailToolServer, EMAIL_SERVER_NAME, emailToolNames, REPEATABLE_EMAIL_TOOLS } from '../tools/emailTools';
import { requireServer, usableServers } from '../store/mcpStore';
import { findNewEmail, findReply, recordReply, repliedEmail, type ReplyRecord } from '../store/replyStore';
import { findSend, recordSend } from '../store/sendStore';
import { listSkills, missingSkills, SKILL_PLUGIN, workspaceSkillPlugin } from '../store/skillStore';
import { getSettings } from '../store/settingsStore';
import { isFolder, workspaceRoot } from '../paths';
import * as outlook from '../outlook/bridge';

/** What the engine hands a node, and what it expects back. */
export interface NodeContext {
    runId: string;
    flowId: string;
    node: FlowNode;
    /** The workspace's named schemas, which the node's schema may refer to. */
    schemas: Schemas;
    email: EmailEnvelope;
    /** How the run started: a poll of a watched flow, or a person or agent handing it one email to test with. */
    trigger: 'poll' | 'manual';
    /** Slots earlier nodes on this path filled, by name. */
    data: Readonly<Record<string, unknown>>;
    scratchDir: string;
    signal: AbortSignal;

    onEvent(event: TraceEvent): void;

    /** What the agent is writing now, before it is whole. */
    onLive(text: LiveText | null): void;
}

export interface NodeOutcome {
    /** Port to leave by. Null ends the path here. */
    outPort: string | null;
    summary: string;
    /** Set on a terminal node, recorded on the run. */
    disposition?: string;
    /** Slots this node filled, by name, for the nodes after it. */
    provided?: Record<string, unknown>;
    error?: string;
}

function emailContext(email: EmailEnvelope, body: string | undefined): string {
    return [
        ...emailHeader(email, email.ref.account),
        '',
        body ? `--- Body ---\n${body}` : `--- Preview (body not fetched) ---\n${email.bodyPreview}`,
    ].join('\n');
}

/** The slots a node reads, as JSON blocks after the email. */
function slotContext(ctx: NodeContext, names: string[]): string[] {
    return names.flatMap((name) => [
        '',
        `--- ${name} (filled by an earlier node in this flow) ---`,
        JSON.stringify(ctx.data[name] ?? null, null, 2),
    ]);
}

/**
 * A step's models as the agents take them: its own first one on, then its others
 * on and Settings' fallbacks, unless it waits for its own, to go to in turn.
 */
function modelsFor(config: {
    models: ModelChoice[];
    useFallbacks: boolean
}): Pick<AgentRunRequest, 'model' | 'effort' | 'fallbacks'> {
    const [first, ...fallbacks] = stepModels(config, getSettings().fallbacks).map(({model, effort}) => ({
        model,
        effort
    }));
    // parseFlow keeps one on, so only a node built by hand gets here without one.
    if (!first) throw new Error('The node has no model turned on.');
    return {...first, fallbacks};
}

/** A step's servers from the workspace, the allowlist entries for their tools, and why it cannot have them. */
interface NodeServers {
    servers: Record<string, AgentMcpServer>;
    allowed: string[];
    problem?: NodeOutcome;
}

/**
 * The workspace's MCP servers that `mcpTools` names anything of, and the
 * allowlist entries for what it names. A server a node ticks that no run can be
 * handed — not allowed yet, blocked, missing a value, or defined nowhere — stops
 * the step with `problem` rather than running without the tools the node was
 * built to use, as a missing skill does.
 */
async function nodeServers(mcpTools: string[]): Promise<NodeServers> {
    const servers: Record<string, AgentMcpServer> = {};
    const allowed: string[] = [];
    const refused = (e: unknown): NodeServers => {
        const message = errorMessage(e);
        return {servers, allowed, problem: {outPort: 'error', summary: message, error: message}};
    };
    for (const name of usableServers()) {
        const whole = `mcp__${name}`;
        // Only what the node names: a server's other tools stay refused, so an email
        // written to steer the agent cannot reach a tool the step never needed.
        const granted = mcpTools.filter((t) => t === whole || t.startsWith(`${whole}__`));
        if (granted.length === 0) continue;
        // Only now are the values set for it opened: a server the node does not tick never has them read.
        try {
            servers[name] = (await requireServer(name)).launch;
        } catch (e) {
            return refused(e);
        }
        allowed.push(...granted);
    }
    const unmet = mcpTools.find((t) => t.startsWith('mcp__') && !allowed.includes(t));
    if (unmet !== undefined) {
        try {
            // Rejects, saying what stands in the way of the server it names.
            await requireServer(unmet.slice('mcp__'.length).split('__')[0]!);
        } catch (e) {
            return refused(e);
        }
    }
    return {servers, allowed};
}

/** A node's folders as this computer has them, split by what its run may do there, and why it cannot have them. */
interface NodeFolders {
    read: FolderSetting[];
    write: FolderSetting[];
    problem?: NodeOutcome;
}

/**
 * The folders from Settings → Folders that a node ticks, each held to the less
 * of what the node asks and Settings allows there. A folder Settings does not
 * list, or one not on this computer, stops the step with `problem` rather than
 * running without a folder it was built to use, as a missing skill does.
 */
function nodeFolders(grants: FolderGrant[]): NodeFolders {
    const read: FolderSetting[] = [];
    const write: FolderSetting[] = [];
    const refused = (message: string): NodeFolders => ({
        read,
        write,
        problem: {outPort: 'error', summary: message, error: message}
    });
    const {folders} = getSettings();
    for (const grant of grants) {
        const folder = findFolder(folders, grant.folder);
        if (!folder) {
            return refused(
                `The node ticks the folder "${grant.folder}", which Settings → Folders on this computer does not list. Add it there, or untick it on the node.`,
            );
        }
        if (!isFolder(folder.path)) {
            return refused(`Settings → Folders has "${folder.name}" at ${folder.path}, which is not a folder on this computer.`);
        }
        (grant.access === 'write' && folder.access === 'write' ? write : read).push(folder);
    }
    return {read, write};
}

/** Skills as Claude names them: each of the workspace's plugin, `workspace:<name>`. */
const skillNames = (skills: string[]): string[] => skills.map((name) => `${SKILL_PLUGIN}:${name}`);

/**
 * Every skill in the workspace, loaded whatever the node ticks: a step can use
 * any of them, and its ticks are the ones it is told to load first. Naming them
 * all to the run is also what hides every other skill — none from outside the
 * workspace reaches a step. The plugin is disposed of once the run is over.
 */
function workspaceSkills(): { plugins: string[] | undefined; names: string[]; dispose(): void } {
    const plugin = workspaceSkillPlugin();
    return {
        plugins: plugin ? [plugin.path] : undefined,
        names: skillNames(plugin?.names ?? []),
        dispose: () => plugin?.dispose(),
    };
}

/**
 * Why a node cannot start, if a skill it ticks is no longer there — deleted or
 * renamed outside the app since. It would run without the instructions it was
 * given, so it leaves by its error port instead.
 */
function lostSkills(skills: string[]): NodeOutcome | null {
    const missing = missingSkills(skills);
    if (missing.length === 0) return null;
    const one = missing.length === 1;
    const message =
        `${missing.map((ref) => `“${ref}”`).join(', ')} ${one ? 'is' : 'are'} ticked but no longer in the workspace, ` +
        `deleted or renamed outside the app. Put ${one ? 'it' : 'them'} back, or untick ${one ? 'it' : 'them'}.`;
    return {outPort: 'error', summary: message, error: message};
}

/**
 * The email's body, read from Outlook up to `maxChars` and traced. Kept on the
 * envelope only when whole: a body cut at one node's limit would pass for all
 * there is with the nodes after it.
 */
async function readBody(ctx: NodeContext, maxChars: number): Promise<string> {
    const result = await outlook.readBody(ctx.email.ref, maxChars);
    if (!result.truncated) ctx.email.body = result.body;
    ctx.onEvent({at: now(), type: 'outlook', label: `Read body (${result.bodyLength} characters)`});
    return result.body;
}

// ── Trigger ──────────────────────────────────────────────────────────────
// The email is already in hand; this pass just starts the trace at the trigger.

function runTrigger(email: EmailEnvelope): NodeOutcome {
    return {outPort: 'out', summary: `Received in ${email.ref.folderPath.replace(/^\\+/, '')}`};
}

// ── Categorizer ──────────────────────────────────────────────────────────

async function runCategorizer(ctx: NodeContext, config: CategorizerConfig): Promise<NodeOutcome> {
    if (config.categories.length === 0) {
        return {outPort: UNMATCHED_PORT, summary: 'No categories defined — sent to Unmatched.'};
    }

    let body: string | undefined;
    if (config.includeBody) {
        try {
            body = await readBody(ctx, config.bodyMaxChars);
        } catch (e) {
            // An unreadable body means classifying on the preview, not failing.
            ctx.onEvent({
                at: now(),
                type: 'error',
                label: 'Could not read the body; classifying on the preview',
                detail: errorMessage(e),
            });
        }
    }

    // Asked as Jev asks it, with the email as the state the question is about.
    const question: ChoiceQuestion = {
        type: 'choice',
        instructions: [
            'Which of these categories does the email below belong to? Choose by what the email',
            'actually is, not by keywords alone. If it plausibly fits none of them, it is',
            `"${UNMATCHED_PORT}" rather than a forced match — a wrong branch is more expensive than`,
            'an unmatched one.',
        ].join('\n'),
        criteria: {
            ...Object.fromEntries(
                config.categories.map((c) => [c.id, [c.label, c.description].filter(Boolean).join(' — ')]),
            ),
            [UNMATCHED_PORT]: 'None of the other categories genuinely fits.',
        },
    };
    const result = await agents.decide({
        question,
        state: emailContext(ctx.email, body),
        about: 'Email',
        // A tie with Unmatched goes to it, for the reason the question gives.
        prefer: UNMATCHED_PORT,
        ...modelsFor(config),
        cwd: workspaceRoot(),
        signal: ctx.signal,
        onEvent: ctx.onEvent,
        onLive: ctx.onLive,
    });
    const {answer} = result;
    if (!result.ok || !answer) {
        return {
            outPort: null,
            summary: 'Classification failed',
            error: result.error ?? result.unavailable ?? 'No answer came back.',
        };
    }
    ctx.onEvent({at: now(), type: 'note', label: `Answer: ${answer.choice}`, detail: JSON.stringify(answer, null, 2)});

    const chosen = config.categories.find((c) => c.id === answer.choice);
    const named = (id: string): string => {
        const category = config.categories.find((c) => c.id === id);
        return `${category ? category.label || category.id : 'Unmatched'} · ${Math.round((answer.probabilities[id] ?? 0) * 100)}%`;
    };
    // Jev gives no reason, so the runner-up stands in for one.
    const [runnerUp] = Object.keys(answer.probabilities)
        .filter((id) => id !== answer.choice)
        .sort((a, b) => (answer.probabilities[b] ?? 0) - (answer.probabilities[a] ?? 0));
    return {
        outPort: chosen ? `cat:${chosen.id}` : UNMATCHED_PORT,
        summary: answer.reason
            ? `${named(answer.choice)} — ${answer.reason}`
            : [named(answer.choice), runnerUp && `then ${named(runnerUp)}`].filter(Boolean).join(', '),
    };
}

// ── Switch ───────────────────────────────────────────────────────────────
// No model and nothing done to the email: the rules pick the way on.

function runSwitch(ctx: NodeContext, config: SwitchConfig): NodeOutcome {
    const decision = decideSwitch(config, ctx.data);
    ctx.onEvent({at: now(), type: 'note', label: `Decided by ${decision.why}`, detail: decision.checked.join('\n')});
    const port = outputPorts(ctx.node).find((p) => p.id === decision.port);
    if (!port) {
        // A rule sent down a route since removed, which the canvas flags; a test
        // run of a flow being drawn can still get here.
        const message = `${ctx.node.name} decided by ${decision.why}, but that rule leads to no route ${ctx.node.name} has: pick one for it.`;
        return {outPort: null, summary: message, error: message};
    }
    const provided = config.output
        ? {[config.output]: {route: port.label, why: decision.why} satisfies SwitchOutcome}
        : undefined;
    return {outPort: port.id, summary: `${port.label} — ${decision.why}`, provided};
}

// ── Extractor ────────────────────────────────────────────────────────────

/**
 * A missing field's path from inside `data`, as the prompt asks. Some models write
 * it from the top of their answer instead ("data.entries.0.split"), a path the
 * schema cannot be followed down, which would count every field listed as required.
 */
function fromData(schema: JsonSchema, path: string): string {
    const ownData = isObject(schema.properties) && Object.hasOwn(schema.properties, 'data');
    return !ownData && path.startsWith('data.') ? path.slice('data.'.length) : path;
}

/** How much of the body goes into an Extractor's prompt. */
const EXTRACT_BODY_CHARS = 50_000;

async function runExtractor(ctx: NodeContext, config: ExtractorConfig): Promise<NodeOutcome> {
    const lost = lostSkills(config.skills);
    if (lost) return lost;

    // Read up front, so an extraction from the body alone is a single turn.
    let body = ctx.email.body;
    if (body === undefined) {
        try {
            body = await readBody(ctx, EXTRACT_BODY_CHARS);
        } catch (e) {
            return {outPort: 'error', summary: 'Could not read the body', error: errorMessage(e)};
        }
    }

    // Built before Claude is asked, so a schema zod cannot follow fails fast.
    let validator: z.ZodType;
    try {
        validator = z.fromJSONSchema(config.schema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (e) {
        const message = `The schema cannot be used: ${errorMessage(e)}`;
        return {outPort: 'error', summary: message, error: message};
    }

    const capabilities = {readEmail: true, allowSaveAttachments: config.includeAttachments};
    const server = createEmailToolServer({
        email: ctx.email,
        scratchDir: ctx.scratchDir,
        config: capabilities,
        onEvent: ctx.onEvent,
        actions: [],
    });
    // Its own ticks, and what its ticked skills grant: a skill it does not tick grants nothing.
    const tools = nodeTools(config, listSkills());
    const extra = await nodeServers(tools);
    if (extra.problem) return extra.problem;
    const allowedTools = [...emailToolNames(capabilities), ...extra.allowed];
    if (config.includeAttachments) allowedTools.push('Read');

    const ticked = config.skills.length > 0;
    const prompt = [
        'Extract the data described by the schema of `data` from the email below.',
        ...(ticked
            ? [
                `Load ${skillNames(config.skills).map((s) => `\`${s}\``).join(', ')} with the Skill tool first: ` +
                `${config.skills.length === 1 ? 'it says' : 'they say'} how to read this kind of email.`,
            ]
            : []),
        config.instruction.trim(),
        '',
        'Take every value from the email itself. When the email does not give a field, do',
        'not guess one: leave it out if the schema allows that, or give an empty value if it',
        'does not, and list the field\'s path (e.g. "items.0.sku") in `missing`.',
        ...(config.inputs.length > 0
            ? [
                'The data after the email is what earlier steps took from it. Use it to know what',
                'to look for, and take a value from it where the schema\'s description says to.',
            ]
            : []),
        ...(tools.length > 0
            ? ['A value one of your tools returns about this email counts as given, as the email\'s own would.']
            : []),
        ...(config.includeAttachments
            ? ['The attachments may hold what the body does not: save the ones that could, with `mcp__email__save_attachment`, and read them with Read.']
            : tools.length > 0
                ? []
                : ['Work from the body alone; the attachments are not available here.']),
        '',
        '--- Email ---',
        emailContext(ctx.email, body),
        ...slotContext(ctx, config.inputs),
    ].join('\n');

    const library = workspaceSkills();

    const result = await agents.run({
        prompt,
        ...modelsFor(config),
        cwd: workspaceRoot(),
        skillPlugins: library.plugins,
        skills: library.names,
        followSkills: skillNames(config.skills),
        additionalDirectories: config.includeAttachments ? [ctx.scratchDir] : undefined,
        // Read reaches the attachments it saves, and not the workspace it starts in.
        folders: {read: config.includeAttachments ? [ctx.scratchDir] : [], write: []},
        // Nothing that writes or runs a command: Skill to load the workspace's
        // skills, and Read for the attachments it saves.
        tools: [...(library.names.length > 0 ? ['Skill'] : []), ...(config.includeAttachments ? ['Read'] : [])],
        allowedTools,
        mcpServers: {[EMAIL_SERVER_NAME]: server, ...extra.servers},
        repeatableTools: REPEATABLE_EMAIL_TOOLS,
        signal: ctx.signal,
        onEvent: ctx.onEvent,
        onLive: ctx.onLive,
        jsonSchema: {
            type: 'object',
            properties: {
                data: config.schema,
                missing: {
                    type: 'array',
                    items: {type: 'string'},
                    description: 'Path of every field the email did not give.',
                },
                note: {type: 'string', description: 'Anything a person should know about this extraction.'},
            },
            required: ['data', 'missing', 'note'],
            additionalProperties: false,
        },
    }).finally(library.dispose);

    if (!result.ok) {
        return {outPort: 'error', summary: result.error ?? 'Extraction failed', error: result.error};
    }

    const answer = (result.structured ?? {}) as { data?: unknown; missing?: string[]; note?: string };
    ctx.onEvent({
        at: now(),
        type: 'note',
        label: `Extracted ${config.output}`,
        detail: JSON.stringify(answer, null, 2),
    });

    // Claude lists every field the email left out, but only a required one stands
    // in `data` as an empty value; an optional one is simply not there.
    const missing = (answer.missing ?? []).map((path) => fromData(config.schema, path));
    const needed = missing.filter((path) => needsField(config.schema, answer.data, path));
    const checked = validator.safeParse(answer.data);
    const problems = [
        ...needed.map((path) => `${path}: not in the email`),
        ...(checked.success ? [] : checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)),
    ];
    const note = answer.note?.trim() ? ` — ${answer.note.trim()}` : '';
    if (problems.length > 0) {
        return {outPort: 'invalid', summary: `${config.output} incomplete: ${problems.join('; ')}${note}`};
    }
    const optional = missing.length - needed.length;
    const leftOut = optional > 0 ? ` · ${optional} optional field${optional === 1 ? '' : 's'} not in the email` : '';
    return {
        outPort: 'valid',
        summary: `${config.output} extracted${leftOut}${note}`,
        provided: {[config.output]: answer.data},
    };
}

// ── Processor ────────────────────────────────────────────────────────────

/** How each outcome the agent may report leaves the node. */
const PORT_FOR_OUTCOME: Record<string, string> = {done: 'done', 'needs-review': 'review', failed: 'error'};

async function runProcessor(ctx: NodeContext, config: ProcessorConfig): Promise<NodeOutcome> {
    const lost = lostSkills(config.skills);
    if (lost) return lost;

    // Built before Claude is asked, as the Extractor does, so a bad schema costs no run.
    let validator: z.ZodType | undefined;
    if (config.output) {
        try {
            validator = z.fromJSONSchema(config.schema as Parameters<typeof z.fromJSONSchema>[0]);
        } catch (e) {
            const message = `The schema of ${config.output} cannot be used: ${errorMessage(e)}`;
            return {outPort: 'error', summary: message, error: message};
        }
    }

    const actions: string[] = [];
    const server = createEmailToolServer({
        email: ctx.email,
        scratchDir: ctx.scratchDir,
        config,
        onEvent: ctx.onEvent,
        actions,
    });

    const folders = nodeFolders(config.folders);
    if (folders.problem) return folders.problem;
    // Its own ticks, and what its ticked skills grant: a skill it does not tick grants nothing.
    const extra = await nodeServers(nodeTools(config, listSkills()));
    if (extra.problem) return extra.problem;
    const allowedTools = [...emailToolNames(config), ...extra.allowed];
    // Files anywhere, from an older flow, as its box gave them: no folder holds the file tools.
    if (config.filesAnywhere) allowedTools.push('Read', 'Write', 'Edit', 'Glob', 'Grep');
    if (config.allowShell) allowedTools.push('Bash');
    const where = (list: FolderSetting[]): string => list.map((f) => `${f.name} (${f.path})`).join(', ');

    const one = config.skills.length === 1;
    const prompt = [
        config.instruction.trim(),
        // The instruction may name a skill as the node ticks it, without the
        // plugin's prefix the session knows it by.
        ...(config.skills.length > 0
            ? [
                '',
                `This step's skill${one ? ' is' : 's are'} ${skillNames(config.skills).map((s) => `\`${s}\``).join(', ')}: ` +
                `load ${one ? 'it' : 'them'} with the Skill tool, by ${one ? 'that name' : 'those names'} exactly, before anything else. ` +
                `A skill the instruction names is one of these, whatever other skill shares its name.`,
            ]
            : []),
        '',
        ...(config.readEmail
            ? [
                'You are handling exactly one email. Use the `mcp__email__*` tools to work with',
                'it — they are bound to this message and cannot reach any other. Read the full',
                'body before you decide anything.',
            ]
            : [
                'You are working from the data below, which earlier steps took from one email;',
                'the email itself is not yours to read.',
            ]),
        '',
        `Scratch folder for this run (save and read files here): ${ctx.scratchDir}`,
        ...(folders.read.length > 0 ? [`Folders you may read: ${where(folders.read)}`] : []),
        ...(folders.write.length > 0 ? [`Folders you may read and write in: ${where(folders.write)}`] : []),
        ...(config.filesAnywhere || folders.read.length + folders.write.length === 0
            ? []
            : ['Your file tools reach these folders and no others: give Glob and Grep one of them as their `path`.']),
        ...(config.readEmail ? ['', '--- Email ---', emailContext(ctx.email, ctx.email.body)] : []),
        ...slotContext(ctx, config.inputs),
        '',
        'When you are finished, return the structured result describing what you did.',
        ...(config.output
            ? [
                `With the outcome "done", put your result in \`data\`: the nodes after this one read it`,
                `as "${config.output}", and it is all of your work they get. Leave \`data\` out otherwise.`,
            ]
            : []),
    ].join('\n');

    const library = workspaceSkills();

    const result = await agents.run({
        prompt,
        ...modelsFor(config),
        // The workspace's folder. No setting sources: a workspace may be a project
        // with Claude Code settings and skills of its own, which are not this step's.
        cwd: workspaceRoot(),
        skillPlugins: library.plugins,
        // The scratch folder, where attachments are saved, is outside that directory.
        additionalDirectories: [ctx.scratchDir],
        // Its file tools reach the run folder and the node's folders, and not the
        // workspace it starts in unless that is one of them: not its flows, nor
        // the files that say which MCP servers start with what.
        folders: config.filesAnywhere
            ? undefined
            : {
                read: [ctx.scratchDir, ...folders.read.map((f) => f.path)],
                write: folders.write.map((f) => f.path),
            },
        skills: library.names,
        followSkills: skillNames(config.skills),
        allowedTools,
        // Without the shell ticked it goes, since `dontAsk` would let its read-only
        // commands through too, and "read-only" is the shell's own guess.
        // With no skills in the workspace, no Skill tool either: nothing else is this step's to load.
        disallowedTools: [
            ...(config.allowShell ? [] : ['Bash', 'PowerShell']),
            ...(library.names.length > 0 ? [] : ['Skill']),
        ],
        mcpServers: {[EMAIL_SERVER_NAME]: server, ...extra.servers},
        repeatableTools: REPEATABLE_EMAIL_TOOLS,
        signal: ctx.signal,
        onEvent: ctx.onEvent,
        onLive: ctx.onLive,
        jsonSchema: {
            type: 'object',
            properties: {
                outcome: {
                    type: 'string',
                    enum: ['done', 'needs-review', 'failed'],
                    description:
                        'done: handled, nothing left for a person. needs-review: a person has to decide or check something — say what in the summary. failed: something broke.',
                },
                summary: {type: 'string'},
                actions: {type: 'array', items: {type: 'string'}},
                // Optional in the shape, since a run that stops for review has
                // nothing to hand on; Done without it is caught below.
                ...(config.output ? {data: config.schema} : {}),
            },
            required: ['outcome', 'summary', 'actions'],
            additionalProperties: false,
        },
    }).finally(library.dispose);

    if (!result.ok) {
        return {
            outPort: 'error',
            summary: result.error ?? 'Processing failed',
            error: result.error,
        };
    }

    const answer = (result.structured ?? {}) as {
        outcome?: string;
        summary?: string;
        actions?: string[];
        data?: unknown;
    };
    // Both what the tools recorded and what Claude says it did go in the summary.
    // The tool record wins any argument: it is the one that touched Outlook.
    const performed = actions.length > 0 ? ` [${actions.join('; ')}]` : '';
    const stated = (answer.actions ?? []).join('; ');
    const summary = `${answer.summary ?? 'Processed'}${performed}${stated ? ` — ${stated}` : ''}`;
    const outPort = PORT_FOR_OUTCOME[answer.outcome ?? ''] ?? 'done';

    if (!validator) return {outPort, summary};

    if (answer.data !== undefined) {
        ctx.onEvent({
            at: now(),
            type: 'note',
            label: `Filled ${config.output}`,
            detail: JSON.stringify(answer.data, null, 2),
        });
    }
    if (outPort !== 'done') return {outPort, summary};

    // The nodes after Done read this slot unconditionally, so a result that
    // doesn't match is a broken run rather than a thinner one.
    const checked = answer.data === undefined ? null : validator.safeParse(answer.data);
    if (!checked?.success) {
        const problems = checked
            ? checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
            : 'it returned none';
        const message = `Finished as done, but ${config.output} does not match its schema: ${problems}`;
        return {outPort: 'error', summary: `${message} — ${summary}`, error: message};
    }
    return {outPort, summary, provided: {[config.output]: answer.data}};
}

// ── Create email ─────────────────────────────────────────────────────────
// No model: Outlook fills the template, and the draft waits in Drafts for a
// person, or for a Send later in the run. Nothing here sends.

/** Text made safe to stand in a template's HTML, its line breaks kept. */
const asHtml = (text: string): string =>
    text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\r?\n/g, '<br>');

/** What a Create email drafts, once its fields are filled from the run. */
interface Drafting {
    placeholders: Record<string, string>;
    /** A new email's; empty for a reply. */
    to: string;
    cc: string;
    subject: string;
}

/** The node's placeholders, and a new email's To, Cc and Subject, filled from the run. Throws, naming the field, when one holds no value. */
function filled(config: CreateEmailConfig, data: Readonly<Record<string, unknown>>): Drafting {
    const placeholders: Record<string, string> = {};
    for (const {name, field} of config.placeholders) {
        const value = fieldText(data, field);
        if (value === null) throw new Error(`{{${name}}} is filled from ${field}, which holds no value to write in`);
        placeholders[name] = asHtml(value);
    }
    if (config.mode === 'reply') return {placeholders, to: '', cc: '', subject: ''};
    const written = (text: string, label: string): string => {
        try {
            return fillFields(text, data).trim();
        } catch (e) {
            throw new Error(`${label}: ${errorMessage(e)}`);
        }
    };
    const to = written(config.to, 'To');
    if (!/[^\s;,]/.test(to)) throw new Error(`To came to no one once ${config.to.trim()} was filled in`);
    return {placeholders, to, cc: written(config.cc, 'Cc'), subject: written(config.subject, 'Subject')};
}

async function runCreateEmail(ctx: NodeContext, config: CreateEmailConfig): Promise<NodeOutcome> {
    const [problem] = createEmailProblems(ctx.node, config);
    if (problem) return {outPort: 'error', summary: problem, error: problem};

    const fresh = config.mode === 'new';
    const what = fresh ? 'new email' : 'reply';
    const template = config.template.trim();
    const section = config.section.trim();
    const from = `template ${template}${section ? ` [${section}]` : ''}`;
    const handOn = (outcome: Pick<DraftOutcome, 'why'> & Partial<DraftOutcome>): Record<string, unknown> => ({
        [config.output]: {
            drafted: false,
            section: '',
            to: '',
            account: '',
            draftEntryId: '', ...outcome
        } satisfies DraftOutcome,
    });
    // The account it drafts from: its own, or the one the email came to.
    const account = config.account.trim() || ctx.email.ref.account;

    // A second run over this email finds what the first one drafted, and drafts
    // none of its own. A reply is the flow's — one per email, whichever of its
    // nodes a later run's route reaches; a new email is this node's.
    const email = repliedEmail(ctx.email);
    const earlier: ReplyRecord | undefined = fresh
        ? findNewEmail(ctx.flowId, ctx.node.id, email)
        : findReply(ctx.flowId, email);
    if (earlier) {
        const by = earlier.nodeId === ctx.node.id ? '' : ` by another node of this flow (${earlier.nodeId})`;
        const why = `a ${what} about this email was already drafted${by}, ${earlier.at} (run ${earlier.runId}), to ${earlier.to}`;
        return {outPort: SKIPPED_PORT, summary: `No second ${what} — ${why}`, provided: handOn({why})};
    }

    let drafting: Drafting;
    try {
        drafting = filled(config, ctx.data);
    } catch (e) {
        const message = `${ctx.node.name} drafted nothing: ${errorMessage(e)}.`;
        return {outPort: 'error', summary: message, error: message};
    }

    const signature = config.signature.trim();
    const content = {
        templateSubject: template,
        ...(section ? {templateSection: section} : {}),
        ...(Object.keys(drafting.placeholders).length > 0 ? {templatePlaceholders: drafting.placeholders} : {}),
        ...(signature ? {signatureName: signature} : {}),
    };
    let result: { to: string; subject: string; draftEntryId: string; detail: string };
    try {
        if (fresh) {
            const {draftEntryId} = await outlook.draftEmail(account, {
                ...content,
                to: drafting.to,
                ...(drafting.cc ? {cc: drafting.cc} : {}),
                subject: drafting.subject,
            });
            result = {
                to: drafting.to,
                subject: drafting.subject,
                draftEntryId,
                detail: `Cc: ${drafting.cc || '(none)'}`
            };
        } else {
            const reply = await outlook.draftReply(ctx.email.ref, account, {...content, replyAll: config.replyAll});
            result = {
                ...reply,
                detail: [`Original sender: ${reply.repliedToSender}`, `Reply all: ${config.replyAll ? 'yes' : 'no'}`].join('\n'),
            };
        }
    } catch (e) {
        // A missing template, section, placeholder or signature fails every
        // email the same way until it is fixed in Outlook; the bridge says which.
        const message = errorMessage(e);
        return {outPort: 'error', summary: `Could not draft the ${what}: ${message}`, error: message};
    }

    const filledIn = Object.entries(drafting.placeholders).map(([name, value]) => `{{${name}}}: ${value}`);
    ctx.onEvent({
        at: now(),
        type: 'outlook',
        label: `${fresh ? 'draft_email' : 'draft_reply'} → ${result.to} from ${from}`,
        detail: [
            `From: ${account}`,
            `Subject: ${result.subject}`,
            result.detail,
            `Signature: ${signature || '(none)'}`,
            ...filledIn,
            `Draft id: ${result.draftEntryId || '(Outlook did not say)'}`,
        ].join('\n'),
    });

    try {
        recordReply({
            at: now(),
            mode: config.mode,
            runId: ctx.runId,
            flowId: ctx.flowId,
            nodeId: ctx.node.id,
            account,
            draftEntryId: result.draftEntryId,
            to: result.to,
            subject: result.subject,
            template,
            section,
            email,
        });
    } catch (e) {
        // The draft is there, so the step still drafted: failing it would invite
        // a re-run, and with nothing recorded, a second draft.
        ctx.onEvent({
            at: now(),
            type: 'error',
            label: 'Drafted, but could not record the draft: a re-run would draft a second one',
            detail: errorMessage(e),
        });
    }

    const signed = signature ? ` · signed ${signature}` : '';
    const everyone = !fresh && config.replyAll ? ' · reply all' : '';
    const kind = fresh ? ' · new email' : '';
    const elsewhere = account.toLowerCase() === ctx.email.ref.account.toLowerCase() ? '' : ` · from ${account}`;
    return {
        outPort: DRAFTED_PORT,
        summary: `${section || template} drafted to ${result.to}${kind}${elsewhere}${signed}${everyone}`,
        provided: handOn({
            drafted: true,
            section,
            to: result.to,
            account,
            draftEntryId: result.draftEntryId,
            why: `drafted from ${from}`,
        }),
    };
}

// ── Send ─────────────────────────────────────────────────────────────────
// The one step that sends mail, and only the drafts a Create email made earlier
// in this run, by the ids in the draft slots it names. A Create email that found
// its draft already made hands on no id, so an earlier run's draft is never sent
// by a later one. Held back while its sending is off, and on every test run.

/** A draft this run made, as a Send finds it in a slot. */
interface ReadyDraft {
    slot: string;
    to: string;
    /** The account the draft is in, and is sent from. */
    account: string;
    id: string;
}

/** Whether a slot holds what a Create email fills one with. */
const isDraftOutcome = (value: unknown): value is DraftOutcome =>
    isObject(value) &&
    typeof value.drafted === 'boolean' &&
    typeof value.draftEntryId === 'string' &&
    typeof value.to === 'string';

/** Who drafts are to, in a few words. */
const whoTo = (drafts: { to: string }[]): string => drafts.map((d) => d.to || '(no one named)').join('; ');

async function runSend(ctx: NodeContext, config: SendConfig): Promise<NodeOutcome> {
    const handOn = (outcome: Pick<SendOutcome, 'why'> & Partial<SendOutcome>): Record<string, unknown> => ({
        [config.output]: {sent: [], held: [], failed: [], ...outcome} satisfies SendOutcome,
    });

    const [problem] = sendProblems(ctx.node, config);
    if (problem) return {outPort: 'error', summary: problem, error: problem, provided: handOn({why: problem})};

    // What this run drafted, slot by slot, and what of it cannot be sent whatever the setting.
    // Each draft is sent from the account it was drafted in, which its Create
    // email may have chosen; a slot that does not say is the email's own.
    const ready: ReadyDraft[] = [];
    const failed: SendFailure[] = [];
    const passed: string[] = [];
    for (const slot of config.drafts) {
        const draft = ctx.data[slot];
        if (!isDraftOutcome(draft)) {
            failed.push({to: '', why: `${slot} holds no Create email’s draft`});
        } else if (!draft.drafted) {
            passed.push(`${slot}: drafted by an earlier run, so not this run’s to send`);
        } else if (!draft.draftEntryId) {
            failed.push({
                to: draft.to,
                why: `Outlook gave the draft in ${slot} no id it could be told apart by, so it waits in Drafts for a person to send`,
            });
        } else if (ready.some((r) => r.id === draft.draftEntryId)) {
            passed.push(`${slot}: the same draft as one named before it`);
        } else {
            const account = (typeof draft.account === 'string' && draft.account.trim()) || ctx.email.ref.account;
            const earlier = findSend(account, draft.draftEntryId);
            if (earlier) {
                failed.push({
                    to: draft.to,
                    why: `the draft in ${slot} was already sent, ${earlier.at} (run ${earlier.runId}), and is not sent twice`,
                });
            } else {
                ready.push({slot, to: draft.to, account, id: draft.draftEntryId});
            }
        }
    }
    const notes = [...passed, ...failed.map((f) => `Cannot send to ${f.to || '(no one named)'}: ${f.why}`)];

    // Held back: the drafts wait in Outlook, and the trace says where they would have gone.
    const holding = ctx.trigger === 'manual' ? 'a test run never sends' : config.sending ? null : 'sending is off on this node';
    if (holding) {
        const would = ready.length > 0 ? `would have sent to ${whoTo(ready)}` : 'this run drafted nothing to send';
        const why = `Held: ${holding}; ${would}`;
        ctx.onEvent({
            at: now(),
            type: 'note',
            label: why,
            detail: [...ready.map((r) => `Would send to ${r.to} (${r.slot}, draft ${r.id})`), ...notes].join('\n') || undefined,
        });
        return {outPort: HELD_PORT, summary: why, provided: handOn({held: ready.map((r) => r.to), failed, why})};
    }

    if (ready.length === 0) {
        if (failed.length > 0) {
            const message = `Sent nothing: ${failed.map((f) => f.why).join('; ')}.`;
            return {outPort: 'error', summary: message, error: message, provided: handOn({failed, why: message})};
        }
        const why = 'Sent nothing: this run drafted nothing to send';
        if (notes.length > 0) ctx.onEvent({at: now(), type: 'note', label: why, detail: notes.join('\n')});
        return {outPort: HELD_PORT, summary: why, provided: handOn({why})};
    }

    // One call per account the drafts are in. Outlook stopping on one account
    // leaves that account's drafts unsent as far as this run can tell, and
    // still records what the accounts before it sent.
    let outlookSent = 0;
    const refused = new Map<string, string>();
    for (const account of new Set(ready.map((r) => r.account))) {
        const ids = ready.filter((r) => r.account === account).map((r) => r.id);
        try {
            const result = await outlook.sendDrafts(account, ids);
            outlookSent += result.sent;
            for (const f of result.failed) refused.set(f.entryId, `Outlook did not send it: ${f.error}`);
        } catch (e) {
            // Outlook may have sent some before it stopped: the Sent Items folder says which.
            const message = `Outlook stopped while sending from ${account}: ${errorMessage(e)}. Check Sent Items before sending the rest by hand.`;
            for (const id of ids) refused.set(id, message);
        }
    }

    const sent = ready.filter((r) => !refused.has(r.id));
    for (const r of ready) {
        const why = refused.get(r.id);
        if (why !== undefined) failed.push({to: r.to, why});
    }
    ctx.onEvent({
        at: now(),
        type: 'outlook',
        label: `send_drafts → ${sent.length > 0 ? whoTo(sent) : 'nothing sent'}`,
        detail: [
            ...sent.map((r) => `Sent to ${r.to} (${r.slot}, draft ${r.id})`),
            ...notes,
            ...ready.filter((r) => refused.has(r.id)).map((r) => `Not sent to ${r.to}: ${refused.get(r.id)}`),
            ...(outlookSent === sent.length ? [] : [`Outlook counted ${outlookSent} sent`]),
        ].join('\n'),
    });

    for (const r of sent) {
        try {
            recordSend({
                at: now(),
                runId: ctx.runId,
                flowId: ctx.flowId,
                nodeId: ctx.node.id,
                account: r.account,
                draftEntryId: r.id,
                slot: r.slot,
                to: r.to,
                email: repliedEmail(ctx.email),
            });
        } catch (e) {
            // It went: failing the step would say otherwise.
            ctx.onEvent({
                at: now(),
                type: 'error',
                label: `Sent to ${r.to}, but could not record it`,
                detail: errorMessage(e)
            });
        }
    }

    const tos = sent.map((r) => r.to);
    if (failed.length > 0) {
        const went = sent.length > 0 ? `Sent to ${whoTo(sent)}, but not` : 'Sent nothing';
        const message = `${went}: ${failed.map((f) => `${f.to || '(no one named)'} — ${f.why}`).join('; ')}.`;
        return {
            outPort: 'error',
            summary: message,
            error: message,
            provided: handOn({sent: tos, failed, why: message})
        };
    }
    const why = `Sent to ${whoTo(sent)}`;
    return {outPort: SENT_PORT, summary: why, provided: handOn({sent: tos, why})};
}

// ── Move email ───────────────────────────────────────────────────────────
// No model: Outlook files the email into the folder, creating it if it is not
// there yet. A field in braces is filled from the run's slots first; an empty
// field stops before Outlook so `Processed/{{order.client}}` never files into
// `Processed` when `order.client` is blank.

function filledFolder(folder: string, data: Readonly<Record<string, unknown>>): string {
    const written = fillFields(folder, data, true).trim();
    if (!/[^\\/\s]/.test(written)) {
        throw new Error(`folder came to nothing once ${folder.trim()} was filled in`);
    }
    return written;
}

async function runMoveEmail(ctx: NodeContext, config: MoveEmailConfig): Promise<NodeOutcome> {
    const handOn = (outcome: Pick<MoveEmailOutcome, 'why'> & Partial<MoveEmailOutcome>): Record<string, unknown> | undefined =>
        config.output
            ? {[config.output]: {moved: false, folder: '', folderCreated: false, ...outcome} satisfies MoveEmailOutcome}
            : undefined;

    const [problem] = moveEmailProblems(ctx.node, config);
    if (problem) return {outPort: 'error', summary: problem, error: problem, provided: handOn({why: problem})};

    let folder: string;
    try {
        folder = filledFolder(config.folder, ctx.data);
    } catch (e) {
        const message = `${ctx.node.name} moved nothing: ${errorMessage(e)}.`;
        return {outPort: 'error', summary: message, error: message, provided: handOn({why: message})};
    }

    const named = moveFolderLabel(config.under, folder);
    let result: { folderPath: string; folderCreated: boolean; moved: number; failed: { error: string }[] };
    try {
        result = await outlook.moveEmail(ctx.email.ref, moveFolderPath(config.under, ctx.email.ref.account, folder));
    } catch (e) {
        const message = `Could not move the email to ${named}: ${errorMessage(e)}`;
        return {outPort: 'error', summary: message, error: message, provided: handOn({folder, why: message})};
    }
    if (result.moved === 0) {
        const reason = result.failed.map((f) => f.error).join('; ') || 'Outlook did not move the email';
        const message = `Could not move the email to ${named}: ${reason}`;
        return {
            outPort: 'error',
            summary: message,
            error: message,
            provided: handOn({folder: result.folderPath || folder, why: message}),
        };
    }

    const where = result.folderPath || folder;
    const created = result.folderCreated ? ' (folder created)' : '';
    ctx.email.ref.folderPath = where;
    ctx.onEvent({
        at: now(),
        type: 'outlook',
        label: `move_email → ${where}${created}`,
    });
    const why = `Moved to ${where}${created}`;
    return {
        outPort: MOVED_PORT,
        summary: why,
        provided: handOn({moved: true, folder: where, folderCreated: result.folderCreated, why}),
    };
}

// ── Terminal ─────────────────────────────────────────────────────────────

function runTerminal(config: TerminalConfig): NodeOutcome {
    return {outPort: null, disposition: config.disposition, summary: config.disposition};
}

export async function executeNode(ctx: NodeContext): Promise<NodeOutcome> {
    // None picked, or a name the workspace lacks: the canvas flags both, and a
    // test run of a flow being drawn stops here.
    const issue = nodeSchemaIssue(ctx.schemas, ctx.node);
    if (issue) return {outPort: 'error', summary: issue, error: issue};
    // Filled in once, here, so every step below sees the schema whole.
    const config = resolveNode(ctx.schemas, ctx.node).config;
    switch (config.kind) {
        case 'trigger.outlook':
            return runTrigger(ctx.email);
        case 'categorizer':
            return runCategorizer(ctx, config);
        case 'switch':
            return runSwitch(ctx, config);
        case 'extractor':
            return runExtractor(ctx, config);
        case 'processor':
            return runProcessor(ctx, config);
        case 'create-email':
            return runCreateEmail(ctx, config);
        case 'send':
            return runSend(ctx, config);
        case 'move-email':
            return runMoveEmail(ctx, config);
        case 'terminal':
            return runTerminal(config);
    }
}
