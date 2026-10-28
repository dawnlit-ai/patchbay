import type { JSX } from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';
import {
    type Available,
    type CategorizerConfig,
    type Disposition,
    DISPOSITIONS,
    EMAIL_SLOT,
    type ExtractorConfig,
    type FlowIssue,
    type FlowNode,
    hasInput,
    isAgyModel,
    type JsonSchema,
    type ModelChoice,
    NODE_KIND_META,
    type NodeConfig,
    outputPorts,
    type ProcessorConfig,
    provides,
    refName,
    schemaRef,
    type Schemas,
    shortId,
    SLOT_NAME,
    slotTypeLabel,
    startingModel,
    type TerminalConfig,
    type TriggerConfig,
} from '@shared/flow';
import type { InboxFolderOption, ModelOption } from '@shared/ipc';
import { AGENT_NAMES, type AgentId, type McpListing, type McpServerEntry, type McpServerTool } from '@shared/settings';
import { FolderTree } from './FolderTree';
import { NameDialog } from './NameDialog';
import { SchemaEditor } from './SchemaEditor';
import { PickFilter, PickGroup } from './PickGroup';
import { type Library, SkillShelf } from './SkillLibrary';
import { type DataTokens, tint } from '../slotColors';

/** Configures the selected node: one section per kind, each handed its narrowed config. */

/** A labelled control. */
function Field({
                   label,
                   hint,
                   children,
               }: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}): JSX.Element {
    return (
        <label className="field">
            <span>{label}</span>
            {children}
            {hint && <div className="hint">{hint}</div>}
        </label>
    );
}

/** The same heading, for a group of controls that is not one input. */
function Legend({label, hint}: { label: string; hint?: string }): JSX.Element {
    return (
        <div className="field">
            <span>{label}</span>
            {hint && <div className="hint">{hint}</div>}
        </div>
    );
}

interface Models {
    /** Null until the agents have answered. */
    models: ModelOption[] | null;
    error: string | null;
    /** The agents switched off in Settings, whose models are left out of the list. */
    off: AgentId[];
}

/**
 * The models Claude Code and agy offer, and the effort levels each takes — asked
 * of them, so a model released after this build is offered without a new one.
 */
function useModels(): Models {
    const [models, setModels] = useState<ModelOption[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [off, setOff] = useState<AgentId[]>([]);

    useEffect(() => {
        let cancelled = false;
        window.api.agents
            .models()
            .then((list) => {
                if (!cancelled) setModels(list);
            })
            .catch((e: Error) => {
                if (!cancelled) setError(e.message);
            });
        void window.api.settings.get().then((settings) => {
            if (!cancelled) setOff(settings.agents.filter((a) => !a.enabled).map((a) => a.id));
        });
        return () => {
            cancelled = true;
        };
    }, []);

    return {models, error, off};
}

/** The list's entry for a node's model: by its own name, or a pinned id an alias stands for today. */
function findModel(models: ModelOption[] | null, value: string): ModelOption | undefined {
    return models?.find((m) => m.value === value) ?? models?.find((m) => m.resolvedModel === value);
}

/** A node keeps a model the list does not name, and says so, rather than showing another in its place. */
function ModelField({
                        label = 'Model',
                        value,
                        models,
                        error,
                        off,
                        onChange,
                    }: Models & { label?: string; value: string; onChange(model: string): void }): JSX.Element {
    const listed = models?.find((m) => m.value === value);
    const sameToday = models?.find((m) => m.resolvedModel === value);
    const agent: AgentId = isAgyModel(value) ? 'agy' : 'claude';
    let hint: string;
    if (error) hint = `Could not ask Claude which models it offers: ${error}`;
    else if (!models) hint = 'Asking Claude…';
    else if (listed) hint = listed.description;
    else if (sameToday) hint = `Pinned to ${value}. ${sameToday.displayName} is that model today, and moves on to each new one.`;
    else if (off.includes(agent)) {
        hint = `${AGENT_NAMES[agent]} is switched off in Settings → Agents, so the step passes ${value} over. The node keeps it meanwhile.`;
    }
    // Claude lists nothing at all while Claude Code is missing; any model no other agent claims is its.
    else if (models.every((m) => isAgyModel(m.value))) {
        hint = `Claude Code was not found on this computer, so its models cannot be listed: Settings → Agents says how to install it. The node keeps ${value} meanwhile.`;
    } else hint = `${value} is not among the models your Claude account offers. The node keeps it until you pick another.`;

    return (
        <Field label={label} hint={hint}>
            <select value={value} onChange={(e) => onChange(e.target.value)}>
                {!listed && <option value={value}>{value}</option>}
                {models?.map((m) => (
                    <option key={m.value} value={m.value} title={m.description}>
                        {m.displayName}
                    </option>
                ))}
            </select>
        </Field>
    );
}

/**
 * A node's level once its model changes. A level the new model does not take goes
 * back to that model's default, or to its top level where it has none. A model
 * that takes none leaves the level alone, for the next one that does.
 */
function effortAfter(models: ModelOption[] | null, model: string, effort: string): string {
    const picked = findModel(models, model);
    const levels = picked?.effortLevels ?? [];
    if (levels.length === 0 || levels.includes(effort)) return effort;
    return picked?.effortRequired ? (levels.at(-1) ?? '') : '';
}

/** The chosen model's effort levels. A saved level it doesn't take is kept, with a note. */
function EffortField({
                         value,
                         model,
                         loading,
                         onChange,
                     }: {
    value: string;
    /** Undefined while the list is on its way, or when the node's model is not in it. */
    model: ModelOption | undefined;
    loading: boolean;
    onChange(effort: string): void;
}): JSX.Element {
    if (model && model.effortLevels.length === 0) {
        return (
            <Field label="Effort" hint={`${model.displayName} takes no effort level.`}>
                <select disabled>
                    <option>—</option>
                </select>
            </Field>
        );
    }

    const levels = model?.effortLevels ?? [];
    const required = model?.effortRequired ?? false;
    const offered = (value === '' && !required) || levels.includes(value);
    let hint: string | undefined;
    if (!model && !loading) hint = 'The levels come from the chosen model, which is not in the list above.';
    else if (model && !offered) {
        hint = value === ''
            ? `${model.displayName} has no default level. Pick one.`
            : `${model.displayName} does not take ${value}. Pick one of the levels it does.`;
    }

    return (
        <Field label="Effort" hint={hint}>
            <select value={value} onChange={(e) => onChange(e.target.value)}>
                {!required && <option value="">Model default</option>}
                {!offered && <option value={value}>{value || '—'}</option>}
                {levels.map((level) => (
                    <option key={level}>{level}</option>
                ))}
            </select>
        </Field>
    );
}

/** What a model card carries while it is dragged into order. */
const MODEL_DRAG_TYPE = 'application/patchbay-model';

/** The list with the entry at `from` moved into the gap before `gap`, counted as the list stands. */
function moveTo<T>(list: T[], from: number, gap: number): T[] {
    const to = gap > from ? gap - 1 : gap;
    if (to === from) return list;
    const moved = [...list];
    const [item] = moved.splice(from, 1);
    moved.splice(to, 0, item as T);
    return moved;
}

/**
 * The models a step runs on, in the order it tries them, each with its own level:
 * dragged into order, switched off to be passed over, removed or added. One is
 * always on, since the step needs a model to run on.
 */
function ModelsField({
                         value,
                         onChange,
                     }: {
    value: ModelChoice[];
    onChange(models: ModelChoice[]): void;
}): JSX.Element {
    const listing = useModels();
    // The entry being dragged, and the gap it would drop into: 0 is above the first, `value.length` below the last.
    const [dragging, setDragging] = useState<number | null>(null);
    const [dropAt, setDropAt] = useState<number | null>(null);
    // Where an entry moved by the keyboard went, for its grip to keep the focus.
    const [movedTo, setMovedTo] = useState<number | null>(null);
    const list = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (movedTo === null) return;
        list.current?.querySelectorAll<HTMLElement>(':scope > .model-card .grip')[movedTo]?.focus();
        setMovedTo(null);
    }, [movedTo]);

    const replace = (index: number, choice: Partial<ModelChoice>): void =>
        onChange(value.map((c, j) => (j === index ? {...c, ...choice} : c)));
    const move = (from: number, gap: number): void => onChange(moveTo(value, from, gap));
    const on = value.filter((c) => c.enabled).length;
    let turn = 0;
    const roles = value.map((c) => (!c.enabled ? 'Off' : turn++ === 0 ? 'Main' : `Fallback ${turn - 1}`));
    // A drop that would leave the entry where it is shows no line.
    const shownAt = dragging !== null && dropAt !== dragging && dropAt !== dragging + 1 ? dropAt : null;

    return (
        <>
            <Legend
                label="Models"
                hint="The step runs on the first one that is on, and goes to the next in turn when the one before is at its usage limit, or its agent is switched off, not installed or out of reach — never once the step has changed something. The last one waits for Claude's limit to reset rather than failing. Drag to reorder."
            />
            <div
                ref={list}
                className="model-list"
                onDragOver={(e) => {
                    if (dragging === null || !e.dataTransfer.types.includes(MODEL_DRAG_TYPE)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const cards = [...e.currentTarget.querySelectorAll(':scope > .model-card')];
                    const below = cards.findIndex((card) => {
                        const box = card.getBoundingClientRect();
                        return e.clientY < box.top + box.height / 2;
                    });
                    setDropAt(below === -1 ? cards.length : below);
                }}
                onDragLeave={(e) => {
                    // Leaving for one of its own cards is still over it.
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
                }}
                onDrop={(e) => {
                    if (dragging === null || dropAt === null) return;
                    e.preventDefault();
                    if (shownAt !== null) move(dragging, shownAt);
                }}
            >
                {value.map((choice, i) => {
                    const role = roles[i] ?? '';
                    const last = choice.enabled && on === 1;
                    return (
                        <div
                            key={i}
                            className={[
                                'card model-card',
                                choice.enabled ? '' : 'off',
                                dragging === i ? 'dragging' : '',
                                shownAt === i ? 'drop-before' : '',
                                shownAt === value.length && i === value.length - 1 ? 'drop-after' : '',
                            ].filter(Boolean).join(' ')}
                        >
                            <div className="model-head">
                                <span
                                    className="grip"
                                    role="button"
                                    tabIndex={0}
                                    draggable
                                    title="Drag to reorder, or use the arrow keys"
                                    aria-label={`Move ${choice.model}`}
                                    onDragStart={(e) => {
                                        e.dataTransfer.setData(MODEL_DRAG_TYPE, choice.model);
                                        e.dataTransfer.effectAllowed = 'move';
                                        // The whole card goes with the pointer, not just the grip.
                                        const card = e.currentTarget.closest('.model-card');
                                        if (card) e.dataTransfer.setDragImage(card, 16, 16);
                                        setDragging(i);
                                    }}
                                    onDragEnd={() => {
                                        setDragging(null);
                                        setDropAt(null);
                                    }}
                                    onKeyDown={(e) => {
                                        const to = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : null;
                                        if (to === null) return;
                                        e.preventDefault();
                                        if (to < 0 || to >= value.length) return;
                                        move(i, to > i ? to + 1 : to);
                                        setMovedTo(to);
                                    }}
                                >
                                    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
                                        {[2, 7, 12].flatMap((y) => [
                                            <circle key={`l${y}`} cx="2.5" cy={y} r="1.3"/>,
                                            <circle key={`r${y}`} cx="7.5" cy={y} r="1.3"/>,
                                        ])}
                                    </svg>
                                </span>
                                <label
                                    className="check"
                                    title={
                                        last
                                            ? 'A step needs one model on.'
                                            : choice.enabled
                                                ? 'Turn it off to pass it over, keeping its place'
                                                : 'Turn it back on'
                                    }
                                >
                                    <input
                                        type="checkbox"
                                        checked={choice.enabled}
                                        disabled={last}
                                        onChange={(e) => replace(i, {enabled: e.target.checked})}
                                    />
                                    {role}
                                </label>
                                <button
                                    className="danger compact"
                                    disabled={last}
                                    title={last ? 'A step needs one model on.' : undefined}
                                    onClick={() => onChange(value.filter((_, j) => j !== i))}
                                >
                                    Remove
                                </button>
                            </div>
                            {/* Not side by side: the model's hint says which version it is, and wants the width. */}
                            <div className="model-body">
                                <ModelField
                                    {...listing}
                                    value={choice.model}
                                    onChange={(model) =>
                                        replace(i, {model, effort: effortAfter(listing.models, model, choice.effort)})
                                    }
                                />
                                <EffortField
                                    value={choice.effort}
                                    model={findModel(listing.models, choice.model)}
                                    loading={!listing.models && !listing.error}
                                    onChange={(effort) => replace(i, {effort})}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>
            <button onClick={() => onChange([...value, {...startingModel(listing.models, ''), enabled: true}])}>
                + Add a model
            </button>
        </>
    );
}

interface Section<C> {
    config: C;

    patch(partial: Partial<C>): void;
}

function TriggerFields({config, patch}: Section<TriggerConfig>): JSX.Element {
    const [accounts, setAccounts] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Reading the mailbox drives Outlook over COM and takes a moment, so it only
    // happens while a trigger node is open in the inspector.
    useEffect(() => {
        let cancelled = false;
        window.api.outlook
            .accounts()
            .then((list) => {
                if (!cancelled) setAccounts(list);
            })
            .catch((e: Error) => {
                if (!cancelled) setError(e.message);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const {account} = config;
    // Tagged with the account they were listed for, so another mailbox's folders are never ticked.
    const [folders, setFolders] = useState<{ account: string; list: InboxFolderOption[] } | null>(null);
    const [folderError, setFolderError] = useState<{ account: string; message: string } | null>(null);
    const [reread, setReread] = useState(0);
    useEffect(() => {
        if (!account) return;
        let cancelled = false;
        setFolderError(null);
        window.api.outlook.folders(account).then(
            (list) => {
                if (!cancelled) setFolders({account, list});
            },
            (e: Error) => {
                if (!cancelled) setFolderError({account, message: e.message});
            },
        );
        return () => {
            cancelled = true;
        };
    }, [account, reread]);
    const listed = folders?.account === account ? folders.list : null;
    const failed = folderError?.account === account ? folderError.message : null;

    return (
        <>
            {error && <div className="err-banner">{error}</div>}

            <Field
                label="Mailbox"
                hint={loading ? 'Asking Outlook…' : 'Accounts come from the Outlook client on this machine.'}
            >
                <select value={config.account} onChange={(e) => patch({account: e.target.value})}>
                    <option value="">— choose an account —</option>
                    {accounts.map((a) => (
                        <option key={a} value={a}>
                            {a}
                        </option>
                    ))}
                </select>
            </Field>

            <FolderTree
                choice={config}
                listed={listed}
                note={
                    !account
                        ? 'Choose a mailbox to list its folders.'
                        : failed
                            ? `Could not list the folders: ${failed}`
                            : 'Asking Outlook for the folders…'
                }
                onChange={patch}
            />
            {failed && (
                <button className="compact" onClick={() => setReread((n) => n + 1)}>
                    Try again
                </button>
            )}

            <div className="row">
                <Field label="Poll every (s)">
                    <input
                        type="number"
                        min={15}
                        value={config.pollSeconds}
                        onChange={(e) => patch({pollSeconds: Math.max(15, Number(e.target.value) || 60)})}
                    />
                </Field>
                <Field label="Look back (days)">
                    <input
                        type="number"
                        min={0}
                        value={config.lookbackDays}
                        onChange={(e) => patch({lookbackDays: Math.max(0, Number(e.target.value) || 1)})}
                    />
                </Field>
                <Field label="Max / poll">
                    <input
                        type="number"
                        min={1}
                        value={config.maxPerPoll}
                        onChange={(e) => patch({maxPerPoll: Math.max(1, Number(e.target.value) || 10)})}
                    />
                </Field>
            </div>

            <label className="check">
                <input
                    type="checkbox"
                    checked={config.processBacklogOnStart}
                    onChange={(e) => patch({processBacklogOnStart: e.target.checked})}
                />
                Process mail already in its folders when watching starts
            </label>
        </>
    );
}

function CategorizerFields({config, patch}: Section<CategorizerConfig>): JSX.Element {
    const {categories} = config;
    const replace = (index: number, category: Partial<CategorizerConfig['categories'][number]>): void =>
        patch({categories: categories.map((c, j) => (j === index ? {...c, ...category} : c))});

    return (
        <>
            <Legend
                label="Categories"
                hint="Claude picks one branch by matching the email against these descriptions. Write them the way you would explain the difference to a new colleague."
            />

            {categories.map((cat, i) => (
                <div key={cat.id} className="card">
                    <div className="row">
                        <input
                            value={cat.label}
                            placeholder="Label"
                            onChange={(e) => replace(i, {label: e.target.value})}
                        />
                        <button
                            className="danger fixed"
                            onClick={() => patch({categories: categories.filter((_, j) => j !== i)})}
                        >
                            Remove
                        </button>
                    </div>
                    <textarea
                        rows={3}
                        placeholder="Which emails belong in this branch?"
                        value={cat.description}
                        onChange={(e) => replace(i, {description: e.target.value})}
                    />
                </div>
            ))}

            <button
                onClick={() =>
                    patch({
                        categories: [
                            ...categories,
                            {id: shortId(), label: 'New category', description: ''},
                        ],
                    })
                }
            >
                + Add category
            </button>

            <div className="gap"/>

            <ModelsField value={config.models} onChange={(models) => patch({models})}/>

            <div className="gap"/>
            <label className="check">
                <input
                    type="checkbox"
                    checked={config.includeBody}
                    onChange={(e) => patch({includeBody: e.target.checked})}
                />
                Read the full body before classifying
            </label>

            {config.includeBody && (
                <Field label="Body characters">
                    <input
                        type="number"
                        min={500}
                        value={config.bodyMaxChars}
                        onChange={(e) => patch({bodyMaxChars: Math.max(500, Number(e.target.value) || 8_000)})}
                    />
                </Field>
            )}
        </>
    );
}

/** Why a slot name will not do, or null when it will. */
function slotNameProblem(name: string): string | null {
    if (!SLOT_NAME.test(name)) return 'Letters, digits and _ only, not starting with a digit.';
    if (name === EMAIL_SLOT.name) return '"email" is the slot every run starts with.';
    return null;
}

/**
 * The workspace's named schemas, as a node's Schema field picks, edits, names
 * and renames them. Every flow in the workspace shares them, so the window that
 * holds the flow does the work. Deleting one is the start window's, since it is
 * refused while any node names it, this one included.
 */
export interface SchemaShelf {
    /** The ones a node can pick, by name. */
    schemas: Schemas;

    /** How many nodes in this flow use it, and which of the workspace's other flows do. */
    users(name: string): { here: number; elsewhere: string[] };

    /** An edit to its JSON. Written to its file a moment later, so typing is not a write per key. */
    save(name: string, schema: JsonSchema): void;

    /** Each resolves to whether it went through; one refused says why in the window's banner. */
    create(name: string, schema: JsonSchema): Promise<boolean>;

    rename(from: string, to: string): Promise<boolean>;
}

interface SchemaProps {
    shelf: SchemaShelf;
}

/**
 * The slot a node fills and the schema of what goes in it. `optional` lets the
 * name be left blank, for a node that hands nothing on.
 */
function OutputFields({
                          config,
                          patch,
                          hint,
                          optional = false,
                          shelf,
                      }: Section<{ output: string; schema: JsonSchema }> & SchemaProps & {
    hint: string;
    optional?: boolean
}): JSX.Element {
    // A draft, so a half-typed name is never saved in place of the last good one.
    const [output, setOutput] = useState(config.output);
    const problem = (name: string): string | null => (optional && name === '' ? null : slotNameProblem(name));
    const outputProblem = problem(output);

    return (
        <>
            <Field label="Output slot" hint={outputProblem ?? hint}>
                <input
                    value={output}
                    placeholder={optional ? '(hands nothing on)' : undefined}
                    onChange={(e) => {
                        setOutput(e.target.value);
                        if (!problem(e.target.value)) patch({output: e.target.value});
                    }}
                />
            </Field>

            {config.output !== '' && (
                <SchemaField
                    schema={config.schema}
                    output={config.output}
                    patch={patch}
                    shelf={shelf}
                />
            )}
        </>
    );
}

/** The schema of that name in another case, if any: two of the three filesystems we run on ignore case. */
const sameName = (schemas: Schemas, name: string, own?: string): string | undefined =>
    Object.keys(schemas).find((other) => other !== own && other.toLowerCase() === name.toLowerCase());

/** Why a schema name will not do, or null when it will. `own` is the name being renamed, which may stay. */
function schemaNameProblem(schemas: Schemas, name: string, own?: string): string | null {
    if (!SLOT_NAME.test(name)) return 'Letters, digits and _ only, not starting with a digit.';
    const taken = sameName(schemas, name, own);
    if (taken) return `This workspace already has a schema called ${taken}.`;
    return null;
}

/** A free name for a new schema, after the slot it describes: `shipment` suggests `Shipment`. */
function suggestSchemaName(schemas: Schemas, output: string): string {
    const stem = SLOT_NAME.test(output) ? output[0]!.toUpperCase() + output.slice(1) : 'Schema';
    let name = stem;
    for (let n = 2; sameName(schemas, name); n++) name = `${stem}${n}`;
    return name;
}

const BLANK_SCHEMA: JsonSchema = {type: 'object', properties: {}, required: []};

/** Who else an edit to a named schema reaches. */
function sharedWith({here, elsewhere}: { here: number; elsewhere: string[] }): string {
    const nodes = here === 1 ? 'this node' : `${here} nodes in this flow`;
    if (elsewhere.length === 0) return `Used by ${nodes} only`;
    return `Used by ${nodes}, and in ${elsewhere.length === 1 ? 'the flow' : 'the flows'} ${elsewhere.join(', ')}`;
}

/**
 * The workspace schema a node's result has to match. A node only ever names
 * one and never keeps one of its own, so the fields below are the shared ones:
 * an edit reaches every node, in any flow, that picks the same.
 */
function SchemaField({
                         schema,
                         output,
                         patch,
                         shelf,
                     }: SchemaProps & {
    schema: JsonSchema;
    /** The slot it fills, which a new name starts from. */
    output: string;

    patch(partial: { schema: JsonSchema }): void;
}): JSX.Element {
    const {schemas} = shelf;
    const named = refName(schema);
    const shown = named === null ? undefined : schemas[named];
    const [naming, setNaming] = useState<'new' | 'rename' | null>(null);
    const [nameError, setNameError] = useState<string | null>(null);

    const closeNaming = (): void => {
        setNaming(null);
        setNameError(null);
    };

    const confirmName = (name: string): void => {
        const problem = schemaNameProblem(schemas, name, naming === 'rename' ? (named ?? undefined) : undefined);
        if (problem) {
            setNameError(problem);
            return;
        }
        closeNaming();
        if (naming === 'new') {
            // From a copy of the one it names, or nothing yet.
            void shelf.create(name, shown ?? BLANK_SCHEMA).then((made) => {
                if (made) patch({schema: schemaRef(name)});
            });
        } else if (named !== null && name !== named) {
            void shelf.rename(named, name);
        }
    };

    const names = Object.keys(schemas);

    return (
        <>
            <Legend
                label="Schema"
                hint="Every schema is the workspace’s: pick one, or make one with New…. Each node that picks the same fills the same shape, and its ports say so."
            />
            <div className="row schema-pick">
                <select value={named ?? ''} onChange={(e) => patch({schema: schemaRef(e.target.value)})}>
                    {named === null && (
                        <option value="" disabled>
                            Pick a schema…
                        </option>
                    )}
                    {named !== null && !shown && <option value={named}>{named} (missing)</option>}
                    {names.map((name) => (
                        <option key={name} value={name}>
                            {name}
                        </option>
                    ))}
                </select>
                <button
                    className="fixed"
                    onClick={() => setNaming('new')}
                    title={
                        shown
                            ? `Make a new schema from a copy of ${named}, and pick it here`
                            : 'Make a new schema in the workspace, and pick it here'
                    }
                >
                    New…
                </button>
                {named !== null && shown && (
                    <button className="fixed" onClick={() => setNaming('rename')}>
                        Rename…
                    </button>
                )}
            </div>

            {named !== null && shown ? (
                <SchemaEditor
                    // Remounted with each schema picked, so one's drafts never land on another.
                    key={named}
                    value={shown}
                    // Any of the workspace's but the one shown: a schema cannot hold itself.
                    named={names.filter((name) => name !== named)}
                    hint={`${sharedWith(shelf.users(named))}. It is the workspace’s, in schemas/${named}.json, so an edit here changes it for every node that picks it.`}
                    onChange={(next) => shelf.save(named, next)}
                />
            ) : (
                <div className="hint block">
                    {named !== null
                        ? `The workspace has no schema called ${named}. Pick another, or make one with New….`
                        : names.length > 0
                            ? 'Pick the schema its result fills, or make one with New….'
                            : 'The workspace has no schemas yet. New… makes one, and this node picks it.'}
                </div>
            )}

            {naming && (
                <NameDialog
                    title={naming === 'new' ? 'New schema' : `Rename ${named}`}
                    label="Schema name"
                    initial={naming === 'new' ? suggestSchemaName(schemas, output) : (named ?? '')}
                    confirmLabel={naming === 'new' ? 'Create' : 'Rename'}
                    hint={
                        nameError ??
                        (naming === 'new'
                            ? 'Letters, digits and _. Saved in the workspace’s schemas folder for any flow here to ' +
                            `use, and this node picks it at once${shown ? `, starting from a copy of ${named}` : ''}.`
                            : 'Its file is renamed, and every node and schema using it, in every flow here, follows.')
                    }
                    onCancel={closeNaming}
                    onConfirm={confirmName}
                />
            )}
        </>
    );
}

function ExtractorFields({
                             config,
                             patch,
                             library,
                             available,
                             shelf,
                         }: Section<ExtractorConfig> & SchemaProps & {
    library: Library;
    available: Available | undefined;
}): JSX.Element {
    return (
        <>
            <SkillsField config={config} patch={patch} library={library}/>
            <InputsField config={config} patch={patch} available={available}/>

            <OutputFields
                config={config}
                patch={patch}
                shelf={shelf}
                hint="Later nodes read the result by this name. It is filled only on Valid."
            />

            <Field label="Instruction"
                   hint="Anything the schema's descriptions leave out, like where in the email to look.">
                <textarea
                    rows={3}
                    value={config.instruction}
                    onChange={(e) => patch({instruction: e.target.value})}
                />
            </Field>

            <label className="check">
                <input
                    type="checkbox"
                    checked={config.includeAttachments}
                    onChange={(e) => patch({includeAttachments: e.target.checked})}
                />
                Read the attachments too, not just the body
            </label>

            <ModelsField value={config.models} onChange={(models) => patch({models})}/>

            <div className="gap"/>
            <McpToolsField
                config={config}
                patch={patch}
                hint="The run gets only what is ticked. Tick tools that look things up: an Extractor is meant to change nothing."
            />

            <div className="gap"/>
            <div className="hint">
                Leaves by Valid when every required field is in the email and the result matches the schema, and by
                Incomplete when something is missing or wrong. Nothing is filled on Incomplete.
            </div>
        </>
    );
}

/** The skills a node loads first, ticked from the workspace's library — and the library itself, kept from here. */
function SkillsField({config, patch, library}: Section<{ skills: string[] }> & { library: Library }): JSX.Element {
    return (
        <>
            <Legend
                label="Skills"
                hint="Every skill in the workspace is this step’s to use, and none from anywhere else. The ones you tick it loads before anything else."
            />
            <SkillShelf library={library} picked={config.skills} onPick={(skills) => patch({skills})}/>
            <div className="gap"/>
        </>
    );
}

function ProcessorFields({
                             config,
                             patch,
                             library,
                             available,
                             shelf,
                         }: Section<ProcessorConfig> & SchemaProps & {
    library: Library;
    available: Available | undefined;
}): JSX.Element {
    return (
        <>
            <SkillsField config={config} patch={patch} library={library}/>
            <InputsField config={config} patch={patch} available={available}/>

            <Field label="Instruction" hint="Prepended to the email. Say what a good outcome looks like.">
                <textarea
                    rows={5}
                    value={config.instruction}
                    onChange={(e) => patch({instruction: e.target.value})}
                />
            </Field>

            <OutputFields
                config={config}
                patch={patch}
                shelf={shelf}
                optional
                hint="Later nodes read this node's result by this name, filled only on Done. Leave it blank to hand nothing on."
            />

            <ModelsField value={config.models} onChange={(models) => patch({models})}/>

            <div className="section-title">What this node may do</div>
            <label className="check" title={config.readEmail ? undefined : 'Needs the email ticked under Reads.'}>
                <input
                    type="checkbox"
                    disabled={!config.readEmail}
                    checked={config.readEmail && config.allowSaveAttachments}
                    onChange={(e) => patch({allowSaveAttachments: e.target.checked})}
                />
                Save attachments to the run folder
            </label>
            <label className="check">
                <input
                    type="checkbox"
                    checked={config.allowFileSystem}
                    onChange={(e) => patch({allowFileSystem: e.target.checked})}
                />
                Read and write files anywhere, and run commands (Read, Write, Edit, Bash)
            </label>
            {!config.allowFileSystem && (
                <div className="hint">
                    Off, it still reads its run folder — saved attachments — and saves files there, with no shell.
                </div>
            )}
            <label className="check">
                <input
                    type="checkbox"
                    checked={config.allowDraftReply}
                    onChange={(e) => patch({allowDraftReply: e.target.checked})}
                />
                Leave a reply as an unsent draft
            </label>
            <label className="check">
                <input
                    type="checkbox"
                    checked={config.allowMoveEmail}
                    onChange={(e) => patch({allowMoveEmail: e.target.checked})}
                />
                Move the email to another folder
            </label>
            <div className="hint">
                Nothing here can send mail. A drafted reply waits in Outlook for a person.
            </div>

            <div className="gap"/>
            <McpToolsField config={config} patch={patch}/>
        </>
    );
}

/** A server from Settings or the workspace, and the tools it offered when asked. */
interface ServerListing {
    entry: McpServerEntry;
    tools: McpServerTool[] | null;
    error: string | null;
}

/**
 * The tools a node takes from the MCP servers in Settings or the workspace,
 * ticked one by one: the run is handed those and no others. Each allowed server
 * is asked for its list only while such a node is open here; a workspace server
 * that has not been allowed yet waits on its button first.
 */
function McpToolsField({
                           config,
                           patch,
                           hint = 'The run gets only what is ticked; a server with nothing ticked is not started for it.',
                       }: Section<{ mcpTools: string[] }> & { hint?: string }): JSX.Element {
    const [servers, setServers] = useState<ServerListing[] | null>(null);
    const [unreadable, setUnreadable] = useState<McpListing['unreadable']>([]);
    /** Why allowing a server failed: this window has no banner to say it in. */
    const [trustError, setTrustError] = useState<string | null>(null);
    const [query, setQuery] = useState('');

    useEffect(() => {
        let cancelled = false;
        let round = 0;
        const apply = (listing: McpListing): void => {
            if (cancelled) return;
            const mine = ++round;
            const update = (name: string, change: Partial<ServerListing>): void => {
                if (!cancelled && round === mine) {
                    setServers((all) => all?.map((s) => (s.entry.name === name ? {...s, ...change} : s)) ?? null);
                }
            };
            const shown = listing.servers.filter((s) => s.state !== 'shadowed');
            setUnreadable(listing.unreadable);
            setServers(shown.map((entry) => ({entry, tools: null, error: null})));
            for (const entry of shown) {
                if (entry.state !== 'allowed') continue;
                window.api.settings.serverTools(entry.name).then(
                    (tools) => update(entry.name, {tools}),
                    (e: Error) => update(entry.name, {error: e.message}),
                );
            }
        };
        const refresh = (): void => {
            void window.api.settings.servers().then(apply);
        };
        refresh();
        const off = window.api.on.workspaceChanged((change) => {
            if (change.mcp) refresh();
        });
        window.addEventListener('focus', refresh);
        return () => {
            cancelled = true;
            off();
            window.removeEventListener('focus', refresh);
        };
    }, []);

    // The listing comes back through workspaceChanged, as it does to every window.
    const trust = (name: string): void => {
        setTrustError(null);
        window.api.settings.trustServer(name, true).catch((e: Error) => setTrustError(e.message));
    };

    const picked = config.mcpTools;
    const set = (ref: string, on: boolean): void =>
        patch({mcpTools: on ? [...picked, ref] : picked.filter((t) => t !== ref)});
    const offered = new Set(
        (servers ?? []).flatMap(({entry, tools}) => [
            `mcp__${entry.name}`,
            ...(tools ?? []).map((t) => `mcp__${entry.name}__${t.name}`),
        ]),
    );
    const settled = servers?.every(({entry, tools, error}) => entry.state !== 'allowed' || tools || error) ?? false;
    // Ticked but offered by no server here: shown, so the tick can be taken off.
    const stranded =
        settled
            ? picked.filter(
                (t) =>
                    !offered.has(t) &&
                    !(servers ?? []).some(
                        ({entry}) => entry.state !== 'allowed' && t.startsWith(`mcp__${entry.name}__`),
                    ),
            )
            : [];

    return (
        <>
            <Legend
                label="Tools from MCP servers"
                hint={
                    servers?.length === 0 && unreadable.length === 0
                        ? 'No MCP servers found. Add them in Settings or in .mcp.json in this workspace.'
                        : hint
                }
            />
            {unreadable.map((u) => (
                <p key={u.source} className="hint err">
                    Could not read <code>{u.source}</code>: {u.problem}
                </p>
            ))}
            {trustError && <p className="hint err">{trustError}</p>}
            <PickFilter
                value={query}
                total={(servers ?? []).reduce((sum, server) => sum + (server.tools?.length ?? 0), 0)}
                noun="tools"
                onChange={setQuery}
            />
            {servers?.map(({entry, tools, error}) => {
                const whole = `mcp__${entry.name}`;
                const takesAll = picked.includes(whole);
                const allowed = entry.state === 'allowed';
                const from = entry.source === 'settings' ? 'Settings' : entry.source;
                return (
                    <PickGroup
                        key={`${entry.source}:${entry.name}`}
                        title={entry.name}
                        tip={entry.summary ? `From ${from} · ${entry.summary}` : `From ${from}`}
                        // Taking the whole server leaves nothing to pick one by one.
                        items={allowed && !takesAll ? (tools ?? []) : []}
                        isTicked={(tool) => picked.includes(`${whole}__${tool.name}`)}
                        query={query}
                        text={(tool) => `${tool.name} ${tool.description}`}
                        count={
                            !allowed
                                ? from
                                : takesAll
                                    ? 'every tool'
                                    : tools
                                        ? entry.source !== 'settings'
                                            ? `${tools.length} · ${from}`
                                            : undefined
                                        : ''
                        }
                        note={
                            entry.state === 'new' ? (
                                <>
                                    Found in <code>{entry.source}</code>: <code>{entry.summary}</code>. Allow it to
                                    start it and list its tools.
                                </>
                            ) : entry.state === 'changed' ? (
                                <>
                                    <code>{entry.source}</code> changed what this starts: <code>{entry.summary}</code>.
                                    Allow it again to use it.
                                </>
                            ) : entry.state === 'blocked' ? (
                                <>
                                    From <code>{entry.source}</code>, blocked in this workspace.
                                </>
                            ) : entry.state === 'invalid' ? (
                                <>
                                    From <code>{from}</code>: {entry.problem}
                                </>
                            ) : takesAll ? undefined : error ? (
                                `Could not ask ${entry.name} for its tools: ${error}`
                            ) : !tools ? (
                                `Asking ${entry.name} for its tools…`
                            ) : undefined
                        }
                        actions={
                            allowed ? (
                                <label className="check" title="Every tool it offers, including any it adds later">
                                    <input
                                        type="checkbox"
                                        checked={takesAll}
                                        onChange={(e) => set(whole, e.target.checked)}
                                    />
                                    All
                                </label>
                            ) : entry.state === 'new' || entry.state === 'changed' || entry.state === 'blocked' ? (
                                <button className="compact" onClick={() => trust(entry.name)}>
                                    Allow
                                </button>
                            ) : undefined
                        }
                        row={(tool) => {
                            const ref = `${whole}__${tool.name}`;
                            return (
                                <div key={ref} className="pick-row" title={tool.description}>
                                    <label className="check">
                                        <input
                                            type="checkbox"
                                            checked={picked.includes(ref)}
                                            onChange={(e) => set(ref, e.target.checked)}
                                        />
                                        {tool.name}
                                    </label>
                                </div>
                            );
                        }}
                    />
                );
            })}
            {stranded.length > 0 && (
                <PickGroup
                    title="No server here offers"
                    items={stranded}
                    isTicked={() => true}
                    query=""
                    text={(ref) => ref}
                    row={(ref) => (
                        <div key={ref} className="pick-row">
                            <label className="check">
                                <input type="checkbox" checked onChange={() => set(ref, false)}/>
                                {ref}
                            </label>
                        </div>
                    )}
                />
            )}
        </>
    );
}

/**
 * What goes into the prompt: the email, slots an earlier node filled, or both.
 * A node without `readEmail` always reads the email.
 */
function InputsField({
                         config,
                         patch,
                         available,
                     }: Section<{ inputs: string[]; readEmail?: boolean }> & {
    available: Available | undefined
}): JSX.Element {
    const offered = [...(available?.keys() ?? [])].filter((name) => name !== EMAIL_SLOT.name);
    // Ticked but not sure to arrive: shown, so the tick can be taken off.
    const stranded = config.inputs.filter((name) => !offered.includes(name));
    const toggle = (name: string, on: boolean): void =>
        patch({inputs: on ? [...config.inputs, name] : config.inputs.filter((n) => n !== name)});

    let hint: string;
    if (!available) hint = 'Connect this node to a trigger to see which data reaches it.';
    else if (offered.length === 0)
        hint = 'No data from earlier nodes yet — an Extractor, or a Processor with an output slot, before this one fills one.';
    else hint = 'Data goes into the prompt as JSON. Only slots every path here fills are offered.';

    return (
        <>
            <Legend label="Reads" hint={hint}/>
            <label className="check">
                <input
                    type="checkbox"
                    disabled={config.readEmail === undefined}
                    checked={config.readEmail ?? true}
                    onChange={(e) => patch({readEmail: e.target.checked})}
                />
                The email — its body, and its attachments if allowed below
            </label>
            {[...offered, ...stranded].map((name) => {
                const type = available?.get(name);
                return (
                    <label className="check" key={name}>
                        <input
                            type="checkbox"
                            checked={config.inputs.includes(name)}
                            onChange={(e) => toggle(name, e.target.checked)}
                        />
                        {name}
                        {type ? (
                            <span className="slot-type">{slotTypeLabel(type)}</span>
                        ) : (
                            <span className="hint"> — not filled on every path here</span>
                        )}
                    </label>
                );
            })}
            <div className="gap"/>
        </>
    );
}

function TerminalFields({config, patch}: Section<TerminalConfig>): JSX.Element {
    return (
        <Field label="Disposition" hint="Recorded on the run, and shown in the runs list.">
            <select
                value={config.disposition}
                onChange={(e) => patch({disposition: e.target.value as Disposition})}
            >
                {DISPOSITIONS.map((v) => (
                    <option key={v}>{v}</option>
                ))}
            </select>
        </Field>
    );
}

/** One slot as a row: its name in its colour, and its type. */
function SlotRow({name, token, type}: { name: string; token?: string; type: string }): JSX.Element {
    return (
        <div className="slot-row">
            <span className={`slot-chip ${tint(token)}`}>{name}</span>
            <span className="slot-type">{type}</span>
        </div>
    );
}

/** What reaches the node, and what leaves by each port. */
function DataSection({node, available, tokens}: {
    node: FlowNode;
    available: Available | undefined;
    tokens: DataTokens
}): JSX.Element {
    const ports = outputPorts(node);
    const arriving = [...(available ?? new Map())];

    return (
        <>
            <div className="section-title">Data</div>

            {hasInput(node.kind) && (
                <>
                    <Legend
                        label="Arrives with"
                        hint={available ? 'Every path here fills these.' : 'No trigger reaches this node yet.'}
                    />
                    {arriving.map(([name, type]) => (
                        <SlotRow key={name} name={name} token={tokens.get(name)} type={slotTypeLabel(type)}/>
                    ))}
                </>
            )}

            <Legend
                label="Leaves with"
                hint={
                    ports.length === 0
                        ? 'Nothing: the path ends here.'
                        : hasInput(node.kind)
                            ? 'Everything it arrived with, plus what a port adds.'
                            : undefined
                }
            />
            {ports.map((port) => {
                const added = provides(node, port.id);
                return (
                    <div key={port.id} className="slot-row">
                        <span className={`port-name ${port.tone}`}>{port.label}</span>
                        {added.length === 0 && <span className="slot-type">nothing new</span>}
                        {added.map((slot) => (
                            <Fragment key={slot.name}>
                                <span className={`slot-chip ${tint(tokens.get(slot.name))}`}>+ {slot.name}</span>
                                <span className="slot-type">{slotTypeLabel(slot.type)}</span>
                            </Fragment>
                        ))}
                    </div>
                );
            })}
        </>
    );
}

interface Props {
    node: FlowNode | null;
    /** The workspace's skills, ticked by a node and kept from here. */
    library: Library;
    /** Slots every path into this node fills. Undefined when no trigger reaches it. */
    available: Available | undefined;
    issues: FlowIssue[];
    /** Each slot's colour, as the canvas draws it. */
    tokens: DataTokens;
    /** The workspace's named schemas, which a node's schema can be. */
    shelf: SchemaShelf;

    onChange(node: FlowNode): void;

    onDelete(nodeId: string): void;
}

export function Inspector({
                              node,
                              library,
                              available,
                              issues,
                              tokens,
                              onChange,
                              shelf,
                              onDelete,
                          }: Props): JSX.Element {
    if (!node) {
        return (
            <div>
                <div className="empty">
                    Select a node to configure it, or drag one in from the palette on the left.
                </div>
                <div className="section-title">Skills</div>
                <div className="hint block">
                    Every flow in the workspace shares these, and every Processor and Extractor can use any of them. A
                    node’s ticks are the ones it loads first.
                </div>
                <div className="library-alone">
                    <SkillShelf library={library}/>
                </div>
            </div>
        );
    }

    const meta = NODE_KIND_META[node.kind];
    const config = node.config;
    const patch = (partial: Partial<NodeConfig>): void =>
        onChange({...node, config: {...config, ...partial} as NodeConfig});

    return (
        <div>
            <div className={`section-title accented kind-${meta.token}`}>{meta.label}</div>

            {issues.map((issue) => (
                <div key={issue.message} className={issue.severity === 'error' ? 'err-banner' : 'warn-banner'}>
                    {issue.message}
                    {issue.severity === 'error' && ' The flow cannot be watched until it is fixed.'}
                </div>
            ))}

            <Field label="Name">
                <input value={node.name} onChange={(e) => onChange({...node, name: e.target.value})}/>
            </Field>

            {config.kind === 'trigger.outlook' && <TriggerFields key={node.id} config={config} patch={patch}/>}
            {config.kind === 'categorizer' && <CategorizerFields config={config} patch={patch}/>}
            {config.kind === 'extractor' && (
                <ExtractorFields key={node.id} config={config} patch={patch} library={library}
                                 available={available} shelf={shelf}/>
            )}
            {config.kind === 'processor' && (
                <ProcessorFields key={node.id} config={config} patch={patch} library={library}
                                 available={available} shelf={shelf}/>
            )}
            {config.kind === 'terminal' && <TerminalFields config={config} patch={patch}/>}

            <DataSection node={node} available={available} tokens={tokens}/>

            <div className="gap"/>
            <button className="danger" onClick={() => onDelete(node.id)}>
                Delete node
            </button>
        </div>
    );
}
