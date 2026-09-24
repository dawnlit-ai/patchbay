import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import {
    type CategorizerConfig,
    type Disposition,
    DISPOSITIONS,
    type FlowNode,
    NODE_KIND_META,
    type NodeConfig,
    type ProcessorConfig,
    shortId,
    type TerminalConfig,
    type TriggerConfig,
} from '@shared/flow';
import type { InboxFolderOption, ModelOption } from '@shared/ipc';
import { SKILL_SCOPES, skillRef, type SkillSummary } from '@shared/settings';

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
    /** Null until Claude Code has answered. */
    models: ModelOption[] | null;
    error: string | null;
}

/**
 * The models the Claude login offers, and the effort levels each takes — asked of
 * Claude Code, so a model released after this build is offered without a new one.
 */
function useModels(): Models {
    const [models, setModels] = useState<ModelOption[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        window.api.claude
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
                        value,
                        models,
                        error,
                        onChange,
                    }: Models & { value: string; onChange(model: string): void }): JSX.Element {
    const listed = models?.find((m) => m.value === value);
    const sameToday = models?.find((m) => m.resolvedModel === value);
    let hint: string;
    if (error) hint = `Could not ask Claude which models it offers: ${error}`;
    else if (!models) hint = 'Asking Claude…';
    else if (listed) hint = listed.description;
    else if (sameToday) hint = `Pinned to ${value}. ${sameToday.displayName} is that model today, and moves on to each new one.`;
    else hint = `${value} is not among the models your Claude account offers. The node keeps it until you pick another.`;

    return (
        <Field label="Model" hint={hint}>
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
    const offered = value === '' || levels.includes(value);
    let hint: string | undefined;
    if (!model && !loading) hint = 'The levels come from the chosen model, which is not in the list above.';
    else if (model && !offered) hint = `${model.displayName} does not take ${value}. Pick one of the levels it does.`;

    return (
        <Field label="Effort" hint={hint}>
            <select value={value} onChange={(e) => onChange(e.target.value)}>
                <option value="">Model default</option>
                {!offered && <option value={value}>{value}</option>}
                {levels.map((level) => (
                    <option key={level}>{level}</option>
                ))}
            </select>
        </Field>
    );
}

interface Section<C> {
    config: C;

    patch(partial: Partial<C>): void;
}

function TriggerFields({ config, patch }: Section<TriggerConfig>): JSX.Element {
    const [accounts, setAccounts] = useState<string[]>([]);
    const [folders, setFolders] = useState<InboxFolderOption[]>([]);
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
    useEffect(() => {
        if (!account) {
            setFolders([]);
            return;
        }
        let cancelled = false;
        window.api.outlook
            .folders(account)
            .then((list) => {
                if (!cancelled) setFolders(list);
            })
            .catch((e: Error) => {
                if (!cancelled) setError(e.message);
            });
        return () => {
            cancelled = true;
        };
    }, [account]);

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

            <Field label="Folder" hint="Inbox subfolder to watch.">
                <select value={config.folder} onChange={(e) => patch({ folder: e.target.value })}>
                    {folders.length === 0 && <option value="">Inbox</option>}
                    {folders.map((f) => (
                        <option key={f.folderPath || 'inbox'} value={f.relativePath}>
                            {f.name}
                        </option>
                    ))}
                </select>
            </Field>

            <label className="check">
                <input
                    type="checkbox"
                    checked={config.includeSubfolders}
                    onChange={(e) => patch({ includeSubfolders: e.target.checked })}
                />
                Watch every folder below it too — for mail your rules file away as it arrives
            </label>

            {config.includeSubfolders && (
                <Field
                    label="Leave out"
                    hint="One folder per line, by name or path under the Inbox. Each takes the folders below it along."
                >
                    <textarea
                        rows={3}
                        value={config.excludeFolders.join('\n')}
                        onChange={(e) => patch({ excludeFolders: e.target.value.split('\n') })}
                    />
                </Field>
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
                Process mail already in the folder when watching starts
            </label>
        </>
    );
}

function CategorizerFields({ config, patch }: Section<CategorizerConfig>): JSX.Element {
    const { categories } = config;
    const listing = useModels();

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

            <ModelField {...listing} value={config.model} onChange={(model) => patch({ model })}/>

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

const SCOPE_LABEL = { global: 'Global', flow: 'This flow' } as const;

function ProcessorFields({
                             config,
                             patch,
                             skills,
                         }: Section<ProcessorConfig> & { skills: SkillSummary[] }): JSX.Element {
    const toggle = (ref: string, on: boolean): void =>
        patch({ skills: on ? [...config.skills, ref] : config.skills.filter((s) => s !== ref) });

    const listing = useModels();
    // A level the new model does not take goes back to that model's default. A
    // model that takes none leaves the level alone, for the next one that does.
    const pickModel = (model: string): void => {
        const levels = findModel(listing.models, model)?.effortLevels ?? [];
        const kept = config.effort === '' || levels.length === 0 || levels.includes(config.effort);
        patch(kept ? { model } : { model, effort: '' });
    };

    // Ticked but in neither library (e.g. imported from another install). There is
    // no checkbox to show it, so it is listed.
    const offered = new Set(skills.map((skill) => skillRef(skill.scope, skill.name)));
    const missing = config.skills.filter((ref) => !offered.has(ref));

    return (
        <>
            <Legend
                label="Skills"
                hint={
                    skills.length === 0
                        ? 'No skills yet — add one on the Skills tab.'
                        : 'Claude may invoke any skill you tick, and nothing else.'
                }
            />
            {SKILL_SCOPES.map((scope) => {
                const inScope = skills.filter((skill) => skill.scope === scope);
                if (inScope.length === 0) return null;
                return (
                    <div key={scope}>
                        <div className="hint">{SCOPE_LABEL[scope]}</div>
                        {inScope.map((skill) => {
                            const ref = skillRef(scope, skill.name);
                            return (
                                <label className="check" key={ref} title={skill.description}>
                                    <input
                                        type="checkbox"
                                        checked={config.skills.includes(ref)}
                                        onChange={(e) => toggle(ref, e.target.checked)}
                                    />
                                    {skill.name}
                                </label>
                            );
                        })}
                    </div>
                );
            })}
            {missing.length > 0 && (
                <div className="hint">Ticked but not in either library here: {missing.join(', ')}</div>
            )}

            <div className="gap"/>

            <Field label="Instruction" hint="Prepended to the email. Say what a good outcome looks like.">
                <textarea
                    rows={5}
                    value={config.instruction}
                    onChange={(e) => patch({ instruction: e.target.value })}
                />
            </Field>

            {/* Not side by side: the model's hint says which version it is, and wants the width. */}
            <ModelField {...listing} value={config.model} onChange={pickModel}/>
            <EffortField
                value={config.effort}
                model={findModel(listing.models, config.model)}
                loading={!listing.models && !listing.error}
                onChange={(effort) => patch({ effort })}
            />

            <div className="section-title">What this node may do</div>
            <label className="check">
                <input
                    type="checkbox"
                    checked={config.allowSaveAttachments}
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
                Read and write files (Read, Write, Edit, Bash)
            </label>
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
        </>
    );
}

function TerminalFields({ config, patch }: Section<TerminalConfig>): JSX.Element {
    return (
        <>
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
            <Field
                label="File into folder"
                hint="Inbox subfolder, e.g. Processed/Pre-Alerts. Leave blank to leave the email where it is."
            >
                <input
                    value={config.moveToFolder}
                    placeholder="(leave in place)"
                    onChange={(e) => patch({ moveToFolder: e.target.value })}
                />
            </Field>
        </>
    );
}

interface Props {
    node: FlowNode | null;
    skills: SkillSummary[];

    onChange(node: FlowNode): void;

    onDelete(nodeId: string): void;
}

export function Inspector({ node, skills, onChange, onDelete }: Props): JSX.Element {
    if (!node) {
        return (
            <div className="empty">
                Select a node to configure it, or drag one in from the palette on the left.
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

            <Field label="Name">
                <input value={node.name} onChange={(e) => onChange({ ...node, name: e.target.value })}/>
            </Field>

            {config.kind === 'trigger.outlook' && <TriggerFields config={config} patch={patch}/>}
            {config.kind === 'categorizer' && <CategorizerFields config={config} patch={patch}/>}
            {config.kind === 'processor' && <ProcessorFields config={config} patch={patch} skills={skills}/>}
            {config.kind === 'terminal' && <TerminalFields config={config} patch={patch}/>}

            <div className="gap"/>
            <button className="danger" onClick={() => onDelete(node.id)}>
                Delete node
            </button>
        </div>
    );
}
