import { type Flow, type FlowNode, outputPorts, refName, stepModels } from '@shared/flow';
import {
    emailHeader,
    MONITOR_SEVERITIES,
    MONITOR_VERDICTS,
    type MonitorFinding,
    type MonitorSeverity,
    type MonitorVerdict,
    now,
    type Pass,
    type Run,
    type RunMonitor,
    type TraceEvent,
    truncate,
} from '@shared/trace';
import { errorMessage, isObject } from '@shared/util';
import type { AgentRunRequest } from '../agents';
import { agents } from '../agentHost';
import { log } from '../log';
import { workspaceRoot } from '../paths';
import { workspaceSchemas } from '../store/schemaStore';
import { getSettings } from '../store/settingsStore';
import { getSkill } from '../store/skillStore';
import { recordReview, reindexRun, saveRun } from '../store/traceStore';

/**
 * The AI monitor: brought in when a trigger whose monitor is on starts a run,
 * it reviews the whole trace once the run ends, against the flow the run read,
 * and writes down what it would change. It runs with no tools at all — it cannot
 * read the mailbox, run a command or touch a file — so all it can do is say.
 */

/** Why an abort leaves nothing written: the run was deleted, or its workspace closed, while it was being reviewed. */
export const DROPPED = 'dropped';

export interface ReviewRequest {
    /** The run, ended, carrying its monitor. */
    run: Run;
    /** The flow as the run read it: what the review's node ids refer to. */
    flow: Flow;
    /** Set when there is nothing to review, saying why: the run was cancelled. */
    skip?: string;
    signal: AbortSignal;

    /** The run has changed: its review began, or ended. */
    onUpdate(run: Run): void;
}

// ── What it is shown ─────────────────────────────────────────────────────

/** An event's detail as the review reads it: enough to see what a tool returned, not every byte of it. */
const EVENT_CHARS = 2_000;
/** A node's own prompt carries the email again, which the review is given once already. */
const PROMPT_CHARS = 4_000;
const BODY_CHARS = 8_000;
const SKILL_CHARS = 6_000;
const SLOT_CHARS = 3_000;
/** A pass with more events than this keeps its first and last ones, the middle counted. */
const EVENTS_KEPT = {first: 15, last: 35} as const;

const INSTRUCTIONS = [
    'You are the monitor for a Patchbay flow. Patchbay walks one email at a time through',
    'a graph of nodes drawn on a canvas: each node hands the email out of exactly one',
    'output port, and the run follows the one edge wired to that port. A Categorizer',
    'picks a branch by matching category descriptions written in prose; a Switch picks',
    'one by rules on data earlier nodes filled; an Extractor fills a slot to a schema;',
    'a Processor runs a model with skills and tools on the email; Create email, Send',
    'and Move email act on the mailbox with no model; a Terminal ends the path.',
    '',
    'You were brought in when this email triggered the flow, and the run has now',
    'ended. Read how it went, and say what in the flow — or in the skills, schemas and',
    'instructions it uses — should change so the next email like this one is handled',
    'better. You change nothing yourself: a person reads what you write.',
    '',
    'Worth saying:',
    '- The email took the wrong branch, or the right one for a weak reason, and the',
    '  category description or rule that would have sent it right.',
    '- The run ended on a port wired to nothing, failed, or stopped for review where a',
    '  clearer instruction or skill would have let it finish.',
    '- A Processor or Extractor struggled: repeated or failing tool calls, fields it',
    '  could not find, an instruction or skill it misread or ignored.',
    '- A step spent more than it needed: a large model on a simple decision, a full',
    '  body read where the preview would have settled it.',
    '- A slot filled in a shape a later node had to work around.',
    '',
    'Rules:',
    '- Ground every finding in this run, naming the pass number that shows it.',
    '- Make each suggestion a concrete edit: the node or skill, the field, and the new',
    '  wording or setting — not "improve the prompt".',
    '- Name the node a finding is about by its id from the flow; "" when it is about',
    '  the flow as a whole.',
    '- One run is one example. Do not redesign the flow around it, and say so where a',
    '  change is only worth making if more emails look like this one.',
    '- A run that went as it should needs no findings: say so, with the verdict',
    '  "fine". Do not invent problems.',
].join('\n');

const REVIEW_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        verdict: {
            type: 'string',
            enum: MONITOR_VERDICTS,
            description:
                'fine: nothing to change. suggestions: the run went through, but something would handle the next one better. problem: the run went wrong, or would have with a slightly different email.',
        },
        summary: {type: 'string', description: 'How the run went, in one or two sentences.'},
        findings: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    nodeId: {
                        type: 'string',
                        description: 'The id of the node it is about, from the flow; "" for the flow as a whole.',
                    },
                    severity: {
                        type: 'string',
                        enum: MONITOR_SEVERITIES,
                        description:
                            'note: worth knowing, no change asked. suggestion: a change that would help. problem: something wrong, or about to go wrong.',
                    },
                    observed: {
                        type: 'string',
                        description: 'What happened in this run that shows it, naming the pass.'
                    },
                    suggestion: {
                        type: 'string',
                        description: 'The change to make: where, which field, and the new wording or setting. Empty for a note.',
                    },
                },
                required: ['nodeId', 'severity', 'observed', 'suggestion'],
                additionalProperties: false,
            },
        },
    },
    required: ['verdict', 'summary', 'findings'],
    additionalProperties: false,
};

/** Every node with the ports its configuration gives it and where each is wired, as get_flow shows them. */
function flowForReview(flow: Flow): unknown {
    return {
        name: flow.name,
        nodes: flow.nodes.map((node) => ({
            id: node.id,
            kind: node.kind,
            name: node.name,
            config: node.config,
            outputs: outputPorts(node).map((port) => ({
                port: port.id,
                label: port.label,
                connectedTo:
                    flow.edges.find((e) => e.source === node.id && e.sourceHandle === port.id)?.target ?? null,
            })),
        })),
    };
}

/** The nodes the run visited, each once, in the flow the run read. */
function visited(run: Run, flow: Flow): FlowNode[] {
    return [...new Set(run.path)].flatMap((id) => flow.nodes.find((n) => n.id === id) ?? []);
}

/** The skills and named schemas the visited nodes use, which is where most of their behavior is written. */
function references(nodes: FlowNode[]): string[] {
    const skills = new Set<string>();
    const schemas = new Set<string>();
    for (const {config} of nodes) {
        if ('skills' in config) for (const name of config.skills) skills.add(name);
        if ('schema' in config) {
            const name = refName(config.schema);
            if (name) schemas.add(name);
        }
    }
    const named = workspaceSchemas();
    return [
        ...[...skills].flatMap((name) => {
            const skill = getSkill(name);
            return ['', `--- Skill "${name}" ---`, skill ? truncate(skill.content, SKILL_CHARS) : '(no longer in the workspace)'];
        }),
        ...[...schemas].flatMap((name) => [
            '',
            `--- Schema "${name}" ---`,
            name in named ? truncate(JSON.stringify(named[name], null, 2), SKILL_CHARS) : '(no longer in the workspace)',
        ]),
    ];
}

const seconds = (from: string, to: string): string =>
    `${((new Date(to).getTime() - new Date(from).getTime()) / 1000).toFixed(1)} s`;

function eventLines(event: TraceEvent): string[] {
    const head = `- [${event.type}] ${event.label}`;
    if (!event.detail) return [head];
    const detail = truncate(event.detail, event.type === 'prompt' ? PROMPT_CHARS : EVENT_CHARS);
    return [head, ...detail.split('\n').map((line) => `    ${line}`)];
}

function passLines(pass: Pass, flow: Flow): string[] {
    const node = flow.nodes.find((n) => n.id === pass.nodeId);
    const port = pass.outPort && node ? outputPorts(node).find((p) => p.id === pass.outPort) : undefined;
    const left = pass.outPort ? `left by "${port?.label ?? pass.outPort}" (${pass.outPort})` : 'ended the path here';
    const {events} = pass;
    const {first, last} = EVENTS_KEPT;
    const shown =
        events.length <= first + last
            ? events.flatMap(eventLines)
            : [
                ...events.slice(0, first).flatMap(eventLines),
                `- … ${events.length - first - last} more events …`,
                ...events.slice(-last).flatMap(eventLines),
            ];
    return [
        '',
        `Pass ${pass.seq} · "${pass.nodeName}" (${pass.nodeKind}, id ${pass.nodeId}) · ${pass.status} · ${left} · took ${seconds(pass.startedAt, pass.endedAt)}`,
        `Summary: ${pass.summary}`,
        ...(pass.error ? [`Error: ${pass.error}`] : []),
        ...Object.entries(pass.provided ?? {}).map(
            ([name, value]) => `Filled "${name}": ${truncate(JSON.stringify(value, null, 2), SLOT_CHARS)}`,
        ),
        ...(events.length > 0 ? ['Events:', ...shown] : []),
    ];
}

/** What the monitor is asked: what to look for, the flow, what it draws on, the email, and every pass. */
export function reviewPrompt(run: Run, flow: Flow): string {
    const {email} = run;
    const names = new Map(flow.nodes.map((n) => [n.id, n.name]));
    const ended =
        run.status === 'failed'
            ? `failed: ${run.error ?? 'no reason recorded'}`
            : `completed${run.disposition ? `, disposition "${run.disposition}"` : ''}${run.error ? ` — ${run.error}` : ''}`;
    return [
        INSTRUCTIONS,
        '',
        '--- Flow, as this run read it ---',
        JSON.stringify(flowForReview(flow), null, 2),
        ...references(visited(run, flow)),
        '',
        '--- Email ---',
        ...emailHeader(email, email.ref.account),
        '',
        email.body
            ? `Body:\n${truncate(email.body, BODY_CHARS)}`
            : `Preview (no node read the whole body):\n${email.bodyPreview}`,
        '',
        '--- Run ---',
        `Started by: ${run.trigger === 'poll' ? 'new mail in a watched folder' : 'a test run'}`,
        `Ended: ${ended}`,
        `Path: ${run.path.map((id) => names.get(id) ?? id).join(' → ')}`,
        ...run.passes.flatMap((pass) => passLines(pass, flow)),
    ].join('\n');
}

// ── What it says ─────────────────────────────────────────────────────────

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The review as the model gave it, held to its shape: a node id the flow does not have is about the flow as a whole. */
export function readReview(value: unknown, flow: Flow): Pick<RunMonitor, 'verdict' | 'summary' | 'findings'> {
    const answer = isObject(value) ? value : {};
    const findings = (Array.isArray(answer.findings) ? answer.findings : [])
        .filter(isObject)
        .map((f): MonitorFinding => {
            const node = flow.nodes.find((n) => n.id === text(f.nodeId));
            const severity = MONITOR_SEVERITIES.find((s) => s === f.severity) ?? 'suggestion';
            return {
                nodeId: node?.id ?? null,
                ...(node ? {nodeName: node.name} : {}),
                severity,
                observed: text(f.observed),
                suggestion: text(f.suggestion),
            };
        })
        .filter((f) => f.observed || f.suggestion);
    const verdict: MonitorVerdict =
        MONITOR_VERDICTS.find((v) => v === answer.verdict) ??
        (findings.some((f) => f.severity === 'problem')
            ? 'problem'
            : findings.some((f) => f.severity === 'suggestion')
                ? 'suggestions'
                : 'fine');
    return {verdict, summary: text(answer.summary), findings};
}

/** "1 problem, 2 suggestions", or "nothing to change". */
function tally(findings: MonitorFinding[]): string {
    const counts = MONITOR_SEVERITIES.toReversed().flatMap((severity: MonitorSeverity) => {
        const n = findings.filter((f) => f.severity === severity).length;
        return n === 0 ? [] : [`${n} ${severity}${n === 1 ? '' : 's'}`];
    });
    return counts.join(', ') || 'nothing to change';
}

/** The findings as the console's detail shows them, one paragraph each. */
export function findingsText(findings: MonitorFinding[]): string {
    return findings
        .map((f) =>
            [
                `[${f.severity}] ${f.nodeName ?? 'The flow'}`,
                `  Saw: ${f.observed}`,
                ...(f.suggestion ? [`  Change: ${f.suggestion}`] : []),
            ].join('\n'),
        )
        .join('\n\n');
}

// ── The review ───────────────────────────────────────────────────────────

/** The monitor's model from Settings, then Settings' fallbacks, each once. */
function monitorModels(): Pick<AgentRunRequest, 'model' | 'effort' | 'fallbacks'> {
    const {monitorModel, fallbacks} = getSettings();
    const [first, ...rest] = stepModels({
        models: [{...monitorModel, enabled: true}],
        useFallbacks: true
    }, fallbacks).map(
        ({model, effort}) => ({model, effort}),
    );
    return {model: first?.model ?? monitorModel.model, effort: first?.effort ?? monitorModel.effort, fallbacks: rest};
}

/**
 * Review one ended run and write what the monitor found onto it, into the
 * monitor's log and into the console. Never throws: what went wrong is the
 * monitor's `error`. Aborted with `DROPPED`, it writes nothing at all.
 */
export async function reviewRun({run, flow, skip, signal, onUpdate}: ReviewRequest): Promise<void> {
    const monitor = run.monitor;
    if (!monitor) return;
    const runId = run.id;
    const subject = `"${run.email.subject || '(no subject)'}"`;
    const dropped = (): boolean => signal.aborted && signal.reason === DROPPED;

    // Indexed when the run ended, with the monitor still watching; the line follows
    // it, so a review cut off by Patchbay closing reads as `reviewing` with none under way.
    const write = (): void => {
        saveRun(run);
        reindexRun(run);
        onUpdate(run);
    };
    const end = (outcome: Partial<RunMonitor> & Pick<RunMonitor, 'state'>): void => {
        Object.assign(monitor, outcome, {endedAt: now()});
        write();
    };

    if (skip) {
        end({state: 'skipped', error: skip});
        log.info('monitor', `Did not review ${subject}: ${skip}`, {runId});
        return;
    }

    monitor.state = 'reviewing';
    monitor.startedAt = now();
    write();

    try {
        const result = await agents.run({
            prompt: reviewPrompt(run, flow),
            ...monitorModels(),
            cwd: workspaceRoot(),
            // Nothing to reach for: the trace is in the prompt, and a review only says.
            folders: {read: [], write: []},
            tools: [],
            allowedTools: [],
            jsonSchema: REVIEW_SCHEMA,
            signal,
            onEvent: (event) => monitor.events.push(event),
        });
        if (dropped()) return;
        if (signal.aborted) {
            end({state: 'skipped', error: 'Stopped before it finished.'});
            log.info('monitor', `Stopped reviewing ${subject}`, {runId});
            return;
        }
        if (!result.ok) {
            const error = result.error ?? result.unavailable ?? 'The model gave no review.';
            end({state: 'failed', error});
            log.warn('monitor', `Could not review ${subject}: ${error}`, {runId});
            return;
        }
        const review = readReview(result.structured, flow);
        end({state: 'done', ...review});
        recordReview({
            runId,
            flowId: run.flowId,
            flowName: run.flowName,
            at: monitor.endedAt ?? now(),
            subject: run.email.subject,
            trigger: run.trigger,
            verdict: review.verdict ?? 'fine',
            summary: review.summary ?? '',
            findings: review.findings,
        });
        const say = review.verdict === 'problem' ? log.warn : log.info;
        say('monitor', `Reviewed ${subject}: ${tally(review.findings)}`, {
            runId,
            detail: [review.summary, findingsText(review.findings)].filter(Boolean).join('\n\n') || undefined,
        });
    } catch (e) {
        if (dropped()) return;
        const error = errorMessage(e);
        end({state: 'failed', error});
        log.warn('monitor', `Could not review ${subject}: ${error}`, {runId});
    }
}
