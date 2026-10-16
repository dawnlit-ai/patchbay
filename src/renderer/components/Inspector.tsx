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
    requires,
    shortId,
    SLOT_NAME,
    slotTypeLabel,
    startingModel,
    type TerminalConfig,
    type TriggerConfig,
} from '@shared/flow';
import type { InboxFolderOption, ModelOption } from '@shared/ipc';
import type { McpServerTool } from '@shared/settings';
import { FolderTree } from './FolderTree';
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
function Legend({ label, hint }: { label: string; hint?: string }): JSX.Element {
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
}

/**
 * The models Claude Code and agy offer, and the effort levels each takes — asked
 * of them, so a model released after this build is offered without a new one.
 */
function useModels(): Models {
    const [models, setModels] = useState<ModelOption[] | null>(null);
    const [error, setError] = useState<string | null>(null);

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
        return () => {
            cancelled = true;
        };
    }, []);

    return { models, error };
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
                        onChange,
                    }: Models & { label?: string; value: string; onChange(model: string): void }): JSX.Element {
    const listed = models?.find((m) => m.value === value);
    const sameToday = models?.find((m) => m.resolvedModel === value);
    let hint: string;
    if (error) hint = `Could not ask Claude which models it offers: ${error}`;
    else if (!models) hint = 'Asking Claude…';
    else if (listed) hint = listed.description;
    else if (sameToday) hint = `Pinned to ${value}. ${sameToday.displayName} is that model today, and moves on to each new one.`;
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
        onChange(value.map((c, j) => (j === index ? { ...c, ...choice } : c)));
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
                hint="The step runs on the first one that is on, and goes to the next in turn when the one before is at its usage limit, or its agent is not installed or out of reach — never once the step has changed something. The last one waits for Claude's limit to reset rather than failing. Drag to reorder."
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
                                        onChange={(e) => replace(i, { enabled: e.target.checked })}
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
                                        replace(i, { model, effort: effortAfter(listing.models, model, choice.effort) })
                                    }
                                />
                                <EffortField
                                    value={choice.effort}
                                    model={findModel(listing.models, choice.model)}
                                    loading={!listing.models && !listing.error}
                                    onChange={(effort) => replace(i, { effort })}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>
            <button onClick={() => onChange([...value, { ...startingModel(listing.models, ''), enabled: true }])}>
                + Add a model
            </button>
        </>
    );
}

interface Section<C> {
    config: C;

    patch(partial: Partial<C>): void;
}

function TriggerFields({ config, patch }: Section<TriggerConfig>): JSX.Element {
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

    const { account } = config;
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
                if (!cancelled) setFolders({ account, list });
            },
            (e: Error) => {
                if (!cancelled) setFolderError({ account, message: e.message });
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
                <select value={config.account} onChange={(e) => patch({ account: e.target.value })}>
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
                        onChange={(e) => patch({ pollSeconds: Math.max(15, Number(e.target.value) || 60) })}
                    />
                </Field>
                <Field label="Look back (days)">
                    <input
                        type="number"
                        min={0}
                        value={config.lookbackDays}
                        onChange={(e) => patch({ lookbackDays: Math.max(0, Number(e.target.value) || 1) })}
                    />
                </Field>
                <Field label="Max / poll">
                    <input
                        type="number"
                        min={1}
                        value={config.maxPerPoll}
                        onChange={(e) => patch({ maxPerPoll: Math.max(1, Number(e.target.value) || 10) })}
                    />
                </Field>
            </div>

            <label className="check">
                <input
                    type="checkbox"
                    checked={config.processBacklogOnStart}
                    onChange={(e) => patch({ processBacklogOnStart: e.target.checked })}
                />
                Process mail already in its folders when watching starts
            </label>
        </>
    );
}

function CategorizerFields({ config, patch }: Section<CategorizerConfig>): JSX.Element {
    const { categories } = config;
    const replace = (index: number, category: Partial<CategorizerConfig['categories'][number]>): void =>
        patch({ categories: categories.map((c, j) => (j === index ? { ...c, ...category } : c)) });

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
                            onChange={(e) => replace(i, { label: e.target.value })}
                        />
                        <button
                            className="danger fixed"
                            onClick={() => patch({ categories: categories.filter((_, j) => j !== i) })}
                        >
                            Remove
                        </button>
                    </div>
                    <textarea
                        rows={3}
                        placeholder="Which emails belong in this branch?"
                        value={cat.description}
                        onChange={(e) => replace(i, { description: e.target.value })}
                    />
                </div>
            ))}

            <button
                onClick={() =>
                    patch({
                        categories: [
                            ...categories,
                            { id: shortId(), label: 'New category', description: '' },
                        ],
                    })
                }
            >
                + Add category
            </button>

            <div className="gap"/>

            <ModelsField value={config.models} onChange={(models) => patch({ models })}/>

            <div className="gap"/>
            <label className="check">
                <input
                    type="checkbox"
                    checked={config.includeBody}
                    onChange={(e) => patch({ includeBody: e.target.checked })}
                />
                Read the full body before classifying
            </label>

            {config.includeBody && (
                <Field label="Body characters">
                    <input
                        type="number"
                        min={500}
                        value={config.bodyMaxChars}
                        onChange={(e) => patch({ bodyMaxChars: Math.max(500, Number(e.target.value) || 8_000) })}
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
 * The slot a node fills and the schema of what goes in it. `optional` lets the
 * name be left blank, for a node that hands nothing on.
 */
function OutputFields({
                          config,
                          patch,
                          hint,
                          optional = false,
                      }: Section<{ output: string; schema: JsonSchema }> & {
    hint: string;
    optional?: boolean
}): JSX.Element {
    // Drafts, so a half-typed name or schema is never saved in place of the last good one.
    const [output, setOutput] = useState(config.output);
    const [schema, setSchema] = useState(() => JSON.stringify(config.schema, null, 2));
    const [schemaError, setSchemaError] = useState<string | null>(null);
    const problem = (name: string): string | null => (optional && name === '' ? null : slotNameProblem(name));
    const outputProblem = problem(output);

    const editSchema = (text: string): void => {
        setSchema(text);
        try {
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                setSchemaError('The schema has to be a JSON object.');
                return;
            }
            setSchemaError(null);
            patch({ schema: parsed as Record<string, unknown> });
        } catch (e) {
            setSchemaError((e as Error).message);
        }
    };

    return (
        <>
            <Field label="Output slot" hint={outputProblem ?? hint}>
                <input
                    value={output}
                    placeholder={optional ? '(hands nothing on)' : undefined}
                    onChange={(e) => {
                        setOutput(e.target.value);
                        if (!problem(e.target.value)) patch({ output: e.target.value });
                    }}
                />
            </Field>

            {config.output !== '' && (
                <Field
                    label="Schema"
                    hint={
                        schemaError ??
                        'JSON Schema for the result. Give each field a description: it is what Claude reads to fill it.'
                    }
                >
                    <textarea
                        rows={12}
                        spellCheck={false}
                        value={schema}
                        onChange={(e) => editSchema(e.target.value)}
                    />
                </Field>
            )}
        </>
    );
}

function ExtractorFields({
                             config,
                             patch,
                             library,
                             available,
                         }: Section<ExtractorConfig> & {
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
                hint="Later nodes read the result by this name. It is filled only on Valid."
            />

            <Field label="Instruction"
                   hint="Anything the schema's descriptions leave out, like where in the email to look.">
                <textarea
                    rows={3}
                    value={config.instruction}
                    onChange={(e) => patch({ instruction: e.target.value })}
                />
            </Field>

            <label className="check">
                <input
                    type="checkbox"
                    checked={config.includeAttachments}
                    onChange={(e) => patch({ includeAttachments: e.target.checked })}
                />
                Read the attachments too, not just the body
            </label>

            <ModelsField value={config.models} onChange={(models) => patch({ models })}/>

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

/** The skills a node may invoke, ticked from either library — and the libraries themselves, kept from here. */
function SkillsField({ config, patch, library }: Section<{ skills: string[] }> & { library: Library }): JSX.Element {
    return (
        <>
            <Legend
                label="Skills"
                hint="Claude may invoke any skill you tick, and nothing else. Drag one onto the other library to move it there."
            />
            <SkillShelf library={library} picked={config.skills} onPick={(skills) => patch({ skills })}/>
            <div className="gap"/>
        </>
    );
}

function ProcessorFields({
                             config,
                             patch,
                             library,
                             available,
                         }: Section<ProcessorConfig> & {
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
                    onChange={(e) => patch({ instruction: e.target.value })}
                />
            </Field>

            <OutputFields
                config={config}
                patch={patch}
                optional
                hint="Later nodes read this node's result by this name, filled only on Done. Leave it blank to hand nothing on."
            />

            <ModelsField value={config.models} onChange={(models) => patch({ models })}/>

            <div className="section-title">What this node may do</div>
            <label className="check" title={config.readEmail ? undefined : 'Needs the email ticked under Reads.'}>
                <input
                    type="checkbox"
                    disabled={!config.readEmail}
                    checked={config.readEmail && config.allowSaveAttachments}
                    onChange={(e) => patch({ allowSaveAttachments: e.target.checked })}
                />
                Save attachments to the run folder
            </label>
            <label className="check">
                <input
                    type="checkbox"
                    checked={config.allowFileSystem}
                    onChange={(e) => patch({ allowFileSystem: e.target.checked })}
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
                    onChange={(e) => patch({ allowDraftReply: e.target.checked })}
                />
                Leave a reply as an unsent draft
            </label>
            <label className="check">
                <input
                    type="checkbox"
                    checked={config.allowMoveEmail}
                    onChange={(e) => patch({ allowMoveEmail: e.target.checked })}
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

/** A server from Settings, and the tools it offered when asked. */
interface ServerListing {
    name: string;
    tools: McpServerTool[] | null;
    error: string | null;
}

/**
 * The tools a node takes from the MCP servers in Settings, ticked one by one:
 * the run is handed those and no others. Each server is asked for its list only
 * while such a node is open here.
 */
function McpToolsField({
                           config,
                           patch,
                           hint = 'The run gets only what is ticked; a server with nothing ticked is not started for it.',
                       }: Section<{ mcpTools: string[] }> & { hint?: string }): JSX.Element {
    const [servers, setServers] = useState<ServerListing[] | null>(null);
    const [query, setQuery] = useState('');

    useEffect(() => {
        let cancelled = false;
        const update = (name: string, change: Partial<ServerListing>): void => {
            if (!cancelled) setServers((all) => all?.map((s) => (s.name === name ? { ...s, ...change } : s)) ?? null);
        };
        void window.api.settings.get().then((settings) => {
            if (cancelled) return;
            const names = settings.mcpServers.filter((s) => s.enabled && s.name.trim()).map((s) => s.name);
            setServers(names.map((name) => ({ name, tools: null, error: null })));
            for (const name of names) {
                window.api.settings.serverTools(name).then(
                    (tools) => update(name, { tools }),
                    (e: Error) => update(name, { error: e.message }),
                );
            }
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const picked = config.mcpTools;
    const set = (ref: string, on: boolean): void =>
        patch({ mcpTools: on ? [...picked, ref] : picked.filter((t) => t !== ref) });
    const offered = new Set(
        (servers ?? []).flatMap((s) => [`mcp__${s.name}`, ...(s.tools ?? []).map((t) => `mcp__${s.name}__${t.name}`)]),
    );
    // Ticked but offered by no server here: shown, so the tick can be taken off.
    const stranded = servers?.every((s) => s.tools || s.error) ? picked.filter((t) => !offered.has(t)) : [];

    return (
        <>
            <Legend
                label="Tools from MCP servers"
                hint={servers?.length === 0 ? 'No MCP servers are set up. Add them in Settings.' : hint}
            />
            <PickFilter
                value={query}
                total={(servers ?? []).reduce((sum, server) => sum + (server.tools?.length ?? 0), 0)}
                noun="tools"
                onChange={setQuery}
            />
            {servers?.map((server) => {
                const whole = `mcp__${server.name}`;
                const takesAll = picked.includes(whole);
                return (
                    <PickGroup
                        key={server.name}
                        title={server.name}
                        // Taking the whole server leaves nothing to pick one by one.
                        items={takesAll ? [] : (server.tools ?? [])}
                        isTicked={(tool) => picked.includes(`${whole}__${tool.name}`)}
                        query={query}
                        text={(tool) => `${tool.name} ${tool.description}`}
                        count={takesAll ? 'every tool' : server.tools ? undefined : ''}
                        note={
                            takesAll
                                ? undefined
                                : server.error
                                    ? `Could not ask ${server.name} for its tools: ${server.error}`
                                    : !server.tools
                                        ? `Asking ${server.name} for its tools…`
                                        : undefined
                        }
                        actions={
                            <label className="check" title="Every tool it offers, including any it adds later">
                                <input
                                    type="checkbox"
                                    checked={takesAll}
                                    onChange={(e) => set(whole, e.target.checked)}
                                />
                                All
                            </label>
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
        patch({ inputs: on ? [...config.inputs, name] : config.inputs.filter((n) => n !== name) });

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
                    onChange={(e) => patch({ readEmail: e.target.checked })}
                />
                The email — its body, and its attachments if allowed below
            </label>
            {[...offered, ...stranded].map((name) => (
                <label className="check" key={name}>
                    <input
                        type="checkbox"
                        checked={config.inputs.includes(name)}
                        onChange={(e) => toggle(name, e.target.checked)}
                    />
                    {name}
                    {stranded.includes(name) && <span className="hint"> — not filled on every path here</span>}
                </label>
            ))}
            <div className="gap"/>
        </>
    );
}

function TerminalFields({ config, patch }: Section<TerminalConfig>): JSX.Element {
    return (
        <Field label="Disposition" hint="Recorded on the run, and shown in the runs list.">
            <select
                value={config.disposition}
                onChange={(e) => patch({ disposition: e.target.value as Disposition })}
            >
                {DISPOSITIONS.map((v) => (
                    <option key={v}>{v}</option>
                ))}
            </select>
        </Field>
    );
}

/** One slot as a row: its name in its colour, and its type or why there is none. */
function SlotRow({ name, token, type, problem }: {
    name: string;
    token?: string;
    type?: string;
    problem?: string
}): JSX.Element {
    return (
        <div className="slot-row">
            <span className={`slot-chip ${tint(token)}`}>{name}</span>
            <span className={problem ? 'slot-problem' : 'slot-type'}>{problem ?? type}</span>
        </div>
    );
}

/** What the node reads, what reaches it, and what leaves by each port. */
function DataSection({ node, available, tokens }: {
    node: FlowNode;
    available: Available | undefined;
    tokens: DataTokens
}): JSX.Element {
    const reads = requires(node);
    const ports = outputPorts(node);
    const arriving = [...(available ?? new Map())];

    return (
        <>
            <div className="section-title">Data</div>

            {hasInput(node.kind) && (
                <>
                    {reads.length > 0 && <Legend label="Reads"/>}
                    {reads.map((name) => {
                        const type = available?.get(name);
                        let problem: string | undefined;
                        if (!available) problem = 'not known until a trigger reaches this node';
                        else if (!type) problem = 'not filled on every path here';
                        // Coloured only once it is sure to arrive; the problem says why not.
                        return (
                            <SlotRow
                                key={name}
                                name={name}
                                token={type && tokens.get(name)}
                                type={type && slotTypeLabel(type)}
                                problem={problem}
                            />
                        );
                    })}

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
    /** The open flow's skills, ticked by a node and kept from here. */
    library: Library;
    /** Slots every path into this node fills. Undefined when no trigger reaches it. */
    available: Available | undefined;
    issues: FlowIssue[];
    /** Each slot's colour, as the canvas draws it. */
    tokens: DataTokens;

    onChange(node: FlowNode): void;

    onDelete(nodeId: string): void;
}

export function Inspector({ node, library, available, issues, tokens, onChange, onDelete }: Props): JSX.Element {
    if (!node) {
        return (
            <div>
                <div className="empty">
                    Select a node to configure it, or drag one in from the palette on the left.
                </div>
                <div className="section-title">Skills</div>
                <div className="hint block">
                    Processors and Extractors tick the ones they may use. Drag one onto the other library to move it
                    there.
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
        onChange({ ...node, config: { ...config, ...partial } as NodeConfig });

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
                <input value={node.name} onChange={(e) => onChange({ ...node, name: e.target.value })}/>
            </Field>

            {config.kind === 'trigger.outlook' && <TriggerFields key={node.id} config={config} patch={patch}/>}
            {config.kind === 'categorizer' && <CategorizerFields config={config} patch={patch}/>}
            {config.kind === 'extractor' && (
                <ExtractorFields key={node.id} config={config} patch={patch} library={library} available={available}/>
            )}
            {config.kind === 'processor' && (
                <ProcessorFields key={node.id} config={config} patch={patch} library={library} available={available}/>
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
