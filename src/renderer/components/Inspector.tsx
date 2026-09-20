import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import {
    type CategorizerConfig,
    type Disposition,
    DISPOSITIONS,
    EFFORT_LEVELS,
    type EffortLevel,
    type FlowNode,
    NODE_KIND_META,
    type NodeConfig,
    type ProcessorConfig,
    shortId,
    type TerminalConfig,
    type TriggerConfig,
} from '@shared/flow';
import type { InboxFolderOption } from '@shared/ipc';
import { SKILL_SCOPES, skillRef, type SkillSummary } from '@shared/settings';

/**
 * Configures the selected node. Each kind gets its own section, handed the
 * narrowed config it understands, so no section casts or reads a field belonging
 * to another kind.
 */

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

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

            <Field label="Folder" hint="Inbox subfolder to watch. Leave on Inbox to watch everything.">
                <select value={config.folder} onChange={(e) => patch({ folder: e.target.value })}>
                    {folders.length === 0 && <option value="">Inbox</option>}
                    {folders.map((f) => (
                        <option key={f.folderPath || 'inbox'} value={f.relativePath}>
                            {f.name}
                        </option>
                    ))}
                </select>
            </Field>

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

            <Field label="Model">
                <select value={config.model} onChange={(e) => patch({ model: e.target.value })}>
                    {MODELS.map((m) => (
                        <option key={m}>{m}</option>
                    ))}
                </select>
            </Field>

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

    // Ticked in the flow file but in neither library — a flow imported from an
    // install whose global shelf held more than this one does. Said out loud,
    // because the checkbox that would have shown it is not there to be unticked.
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

            <div className="row">
                <Field label="Model">
                    <select value={config.model} onChange={(e) => patch({ model: e.target.value })}>
                        {MODELS.map((m) => (
                            <option key={m}>{m}</option>
                        ))}
                    </select>
                </Field>
                <Field label="Effort">
                    <select value={config.effort} onChange={(e) => patch({ effort: e.target.value as EffortLevel })}>
                        {EFFORT_LEVELS.map((v) => (
                            <option key={v}>{v}</option>
                        ))}
                    </select>
                </Field>
            </div>

            <div className="row">
                <Field label="Max turns">
                    <input
                        type="number"
                        min={1}
                        value={config.maxTurns}
                        onChange={(e) => patch({ maxTurns: Math.max(1, Number(e.target.value) || 40) })}
                    />
                </Field>
                <Field label="Budget (USD)">
                    <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={config.maxBudgetUsd}
                        onChange={(e) => patch({ maxBudgetUsd: Math.max(0, Number(e.target.value) || 0) })}
                    />
                </Field>
            </div>

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
