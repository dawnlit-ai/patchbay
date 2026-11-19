import type { JSX, ReactNode } from 'react';
import { Fragment, useEffect, useState } from 'react';
import {
    type Available,
    type CategorizerConfig,
    type CreateEmailConfig,
    type Disposition,
    DISPOSITIONS,
    draftSlots,
    EMAIL_SLOT,
    type EmailMode,
    type ExtractorConfig,
    FILES_ANYWHERE_LABEL,
    type FlowIssue,
    type FlowNode,
    type FolderGrant,
    hasInput,
    type JsonSchema,
    type ModelChoice,
    type MoveEmailConfig,
    NODE_KIND_META,
    type NodeConfig,
    type NodeKind,
    offeredTo,
    outputPorts,
    type Placeholder,
    type ProcessorConfig,
    provides,
    refName,
    RETIRED_TOOLS,
    routeLabel,
    ruleFields,
    schemaRef,
    type Schemas,
    type SendConfig,
    shortId,
    SLOT_NAME,
    slotTypeLabel,
    stepModels,
    type SwitchConfig,
    type SwitchRoute,
    type SwitchRule,
    takesJev,
    type TerminalConfig,
    type TriggerConfig,
} from '@shared/flow';
import type { InboxFolderOption } from '@shared/ipc';
import {
    findFolder,
    type FolderAccess,
    type FolderSetting,
    type McpListing,
    type McpServerEntry,
    type McpServerTool,
    type McpVariable,
    nodeTools,
    skillGrants,
} from '@shared/settings';
import { FolderTree } from './FolderTree';
import { effortAfter, EffortField, Field, findModel, ModelField, modelName, useModels } from './ModelPickers';
import { SchemaDialog } from './SchemaDialog';
import { SecretDialog } from './SecretDialog';
import { PickFilter, PickGroup, StrandedGroup } from './PickGroup';
import { type Library, SkillShelf } from './SkillLibrary';
import { type DataTokens, tint } from '../slotColors';
import { fieldsOf } from '../schemaShape';

/** Configures the selected node: one section per kind, each handed its narrowed config. */

/** The same heading, for a group of controls that is not one input. */
function Legend({label, hint}: { label: string; hint?: string }): JSX.Element {
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

/** Names joined as a sentence says them: a, b and c. */
function spoken(names: string[]): string {
    return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The model a step runs on, and whether it goes on to Settings → Agents'
 * fallback models when that one is at its limit or out of reach. Models a node
 * listed before Settings had fallbacks stay, tried first, until each is removed:
 * none is added here any more.
 */
function ModelSection({kind, config, patch}: {
    /** The node's kind, which decides the models it is offered: Jev's to a Categorizer alone. */
    kind: NodeKind;
    config: { models: ModelChoice[]; useFallbacks: boolean };

    patch(partial: { models?: ModelChoice[]; useFallbacks?: boolean }): void;
}): JSX.Element {
    const offered = useModels();
    const listing = {...offered, models: offered.models && offeredTo(kind, offered.models)};
    // The model it runs on is the first one on; parseFlow keeps one on.
    const at = Math.max(0, config.models.findIndex((c) => c.enabled));
    const main = config.models[at] ?? {model: '', effort: '', enabled: true};
    const own = config.models.filter((_, i) => i !== at);
    const setMain = (choice: Partial<ModelChoice>): void =>
        patch({models: config.models.map((c, i) => (i === at ? {...c, ...choice} : c))});
    const name = (choice: ModelChoice): string => modelName(offered.models, choice);

    // What the step goes on to now, in turn, as the run would.
    const after = stepModels(config, offered.fallbacks ?? []).slice(1);
    const settingsHas = (offered.fallbacks ?? []).some((c) => c.enabled);
    let hint: string;
    if (offered.fallbacks === null) hint = 'Reading Settings…';
    else if (after.length === 0) {
        hint = `The step waits for ${name(main)}'s usage limit to lift.` +
            (!config.useFallbacks
                ? ''
                : settingsHas
                    ? ' Settings → Agents lists no other model to go on to.'
                    : ' Settings → Agents lists no fallback models yet.');
    } else {
        hint = `When ${name(main)} is at its usage limit, or its agent is switched off or out of reach, the step goes on to ` +
            (after.length === 1
                ? `${name(after[0]!)} — never once it has changed something — and waits for that one's limit to lift.`
                : `${spoken(after.map(name))} in turn — never once it has changed something. The last one waits for its limit to lift.`) +
            (config.useFallbacks ? '' : ' It does not go on to Settings’ fallback models.');
    }

    return (
        <>
            <ModelField
                {...listing}
                jev={takesJev(kind)}
                value={main.model}
                onChange={(model) => setMain({model, effort: effortAfter(listing.models, model, main.effort)})}
            />
            <EffortField
                value={main.effort}
                model={findModel(listing.models, main.model)}
                loading={!listing.models && !listing.error}
                onChange={(effort) => setMain({effort})}
            />
            {own.length > 0 && (
                <>
                    <Legend
                        label="Its own fallbacks"
                        hint="Listed on this node before Settings had fallback models. The step tries them, in turn, before Settings’ list. Remove one to leave it to Settings: it cannot be added back here."
                    />
                    {own.map((choice, i) => (
                        <div key={i} className="pick-row">
                            <span className="grow">{name(choice)}{choice.enabled ? '' : ' — off, passed over'}</span>
                            <button
                                className="ghost compact"
                                onClick={() => patch({models: config.models.filter((c) => c !== choice)})}
                            >
                                Remove
                            </button>
                        </div>
                    ))}
                    <div className="gap"/>
                </>
            )}
            <label className="check">
                <input
                    type="checkbox"
                    checked={config.useFallbacks}
                    onChange={(e) => patch({useFallbacks: e.target.checked})}
                />
                Fall back to the models in Settings → Agents
            </label>
            <div className="hint">{hint}</div>
            {config.useFallbacks && (
                <button className="field-link" onClick={() => void window.api.window.showSettings()}>
                    {settingsHas ? 'Change them in Settings' : 'Set them in Settings'}
                </button>
            )}
            <div className="gap"/>
        </>
    );
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
                hint="The model picks one branch by matching the email against these descriptions. Write them the way you would explain the difference to a new colleague."
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

            <ModelSection kind="categorizer" config={config} patch={patch}/>

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

    /** Each resolves to null once it went through, or to why it did not, for the schema window to say. */
    create(name: string, schema: JsonSchema): Promise<string | null>;

    save(name: string, schema: JsonSchema): Promise<string | null>;

    rename(from: string, to: string): Promise<string | null>;
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
    return (
        <>
            <SlotField value={config.output} optional={optional} hint={hint} onChange={(output) => patch({output})}/>

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

/** Whether the workspace has a schema of that name in any case: two of the three filesystems we run on ignore case. */
const hasName = (schemas: Schemas, name: string): boolean =>
    Object.keys(schemas).some((other) => other.toLowerCase() === name.toLowerCase());

/** A free name for a new schema, after the slot it describes: `shipment` suggests `Shipment`. */
function suggestSchemaName(schemas: Schemas, output: string): string {
    const stem = SLOT_NAME.test(output) ? output[0]!.toUpperCase() + output.slice(1) : 'Schema';
    let name = stem;
    for (let n = 2; hasName(schemas, name); n++) name = `${stem}${n}`;
    return name;
}

/** How many fields a schema has, in a few words. */
function fieldCount(schema: JsonSchema): string {
    const n = Object.keys(fieldsOf(schema)).length;
    return n === 0 ? 'No fields yet' : `${n} field${n === 1 ? '' : 's'}`;
}

/** Who else an edit to a named schema reaches. */
function sharedWith({here, elsewhere}: { here: number; elsewhere: string[] }): string {
    const nodes = here === 1 ? 'this node' : `${here} nodes in this flow`;
    if (elsewhere.length === 0) return `Used by ${nodes} only`;
    return `Used by ${nodes}, and in ${elsewhere.length === 1 ? 'the flow' : 'the flows'} ${elsewhere.join(', ')}`;
}

/** The same, said in the schema window, where a change goes out to every one of them on Save. */
function changeReaches(users: { here: number; elsewhere: string[] }): string {
    const alone = users.here <= 1 && users.elsewhere.length === 0;
    return `${sharedWith(users)}.${alone ? '' : ' A change here reaches every one of them.'}`;
}

/**
 * The workspace schema a node's result has to match. A node only ever names
 * one and never keeps one of its own, so its fields are the shared ones: they
 * are looked at and changed in the schema window, where an edit reaches every
 * node, in any flow, that picks the same.
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
    /** The schema open in the window, by name, or null there for a new one, and whether it opened to look at. */
    const [editing, setEditing] = useState<{ name: string | null; viewing: boolean } | null>(null);

    const names = Object.keys(schemas);

    /** Written on the window's Save: the name first, should it have changed, then the fields. */
    const save = async (from: string | null, to: string, next: JsonSchema | null): Promise<string | null> => {
        if (from === null) {
            // From a copy of the one it names, or nothing yet, and this node picks it at once.
            const failed = await shelf.create(to, next ?? {type: 'object', properties: {}, required: []});
            if (failed !== null) return failed;
            patch({schema: schemaRef(to)});
        } else {
            if (to !== from) {
                const failed = await shelf.rename(from, to);
                if (failed !== null) return failed;
                // Should the rest fail, the window edits it under the name it has now.
                setEditing({name: to, viewing: false});
            }
            if (next) {
                const failed = await shelf.save(to, next);
                if (failed !== null) return failed;
            }
        }
        setEditing(null);
        return null;
    };

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
                    onClick={() => setEditing({name: null, viewing: false})}
                    title={
                        shown
                            ? `Make a new schema from a copy of ${named}, and pick it here`
                            : 'Make a new schema in the workspace, and pick it here'
                    }
                >
                    New…
                </button>
            </div>
            {named !== null && shown && (
                <div className="row schema-pick">
                    <button onClick={() => setEditing({name: named, viewing: true})} title={`See ${named}’s fields`}>
                        View…
                    </button>
                    <button onClick={() => setEditing({name: named, viewing: false})}
                            title={`Change ${named}’s fields, or rename it`}>
                        Edit…
                    </button>
                </div>
            )}

            <div className="hint block">
                {named !== null && shown
                    ? `${fieldCount(shown)}. ${sharedWith(shelf.users(named))}.`
                    : named !== null
                        ? `The workspace has no schema called ${named}. Pick another, or make one with New….`
                        : names.length > 0
                            ? 'Pick the schema its result fills, or make one with New….'
                            : 'The workspace has no schemas yet. New… makes one, and this node picks it.'}
            </div>

            {editing && (
                <SchemaDialog
                    name={editing.name}
                    suggested={suggestSchemaName(schemas, output)}
                    // A new one starts from a copy of the one picked, if any.
                    schema={editing.name === null ? shown : schemas[editing.name]}
                    taken={names}
                    named={names}
                    usage={
                        editing.name === null
                            ? `This node picks it once it is made${shown ? `, and it starts from a copy of ${named}` : ''}.`
                            : changeReaches(shelf.users(editing.name))
                    }
                    viewing={editing.viewing}
                    onCancel={() => setEditing(null)}
                    onSave={(to, next) => save(editing.name, to, next)}
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
    const tools = nodeTools(config, library.skills);
    const problems = useServerProblems(tools);
    const own = new Set(config.mcpTools).size;
    return (
        <>
            <SkillsField config={config} patch={patch} library={library}/>
            <InputsField
                config={config}
                patch={patch}
                available={available}
                attachments={{
                    checked: config.includeAttachments,
                    onChange: (includeAttachments) => patch({includeAttachments}),
                }}
            />

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

            <ModelSection kind="extractor" config={config} patch={patch}/>

            <AccessSection
                summary={[...(problems ?? []), toolsSummary(tools, own)].join(' · ')}
                attention={own > 0 || (problems?.length ?? 0) > 0}
            >
                <McpToolsField
                    config={config}
                    patch={patch}
                    grants={grantsOf(config.skills, library)}
                    hint="The run gets what its ticked skills grant and what is ticked here, and nothing else. Give it tools that look things up: an Extractor is meant to change nothing."
                />
            </AccessSection>

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
    const tools = nodeTools(config, library.skills);
    const problems = useServerProblems(tools);
    const own = new Set(config.mcpTools).size;
    const retired = config.retiredTools?.length ?? 0;
    const folders = config.folders.length;
    // What stands in a run's way first, so a summary cut short still says it.
    const summary = [
        ...(problems ?? []),
        toolsSummary(tools, own),
        config.filesAnywhere ? 'files anywhere' : folders > 0 ? `${folders} folder${folders === 1 ? '' : 's'}` : 'run folder only',
        config.allowShell ? 'runs commands' : 'no commands',
        ...(retired > 0 ? [`${retired} retired box${retired === 1 ? '' : 'es'} ticked`] : []),
    ].join(' · ');
    // Open on its own for what a person should see: anything beyond its skills' tools and its run folder.
    const attention =
        config.allowShell || !!config.filesAnywhere || retired > 0 || folders > 0 || own > 0 || (problems?.length ?? 0) > 0;
    return (
        <>
            <SkillsField config={config} patch={patch} library={library}/>
            <InputsField
                config={config}
                patch={patch}
                available={available}
                attachments={{
                    checked: config.allowSaveAttachments,
                    onChange: (allowSaveAttachments) => patch({allowSaveAttachments}),
                }}
            />

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

            <ModelSection kind="processor" config={config} patch={patch}/>

            <AccessSection summary={summary} attention={attention}>
                <Legend label="Folders"/>
                <FoldersField config={config} patch={patch}/>
                <FilesAnywhereField config={config} patch={patch}/>
                <label className="check">
                    <input
                        type="checkbox"
                        checked={config.allowShell}
                        onChange={(e) => patch({allowShell: e.target.checked})}
                    />
                    Run commands (Bash)
                </label>
                {config.allowShell && (
                    <div className="hint">
                        A command reaches every folder this computer’s user can, whatever is ticked above.
                    </div>
                )}
                <RetiredToolsField config={config} patch={patch}/>

                <div className="gap"/>
                <McpToolsField config={config} patch={patch} grants={grantsOf(config.skills, library)}/>
            </AccessSection>
        </>
    );
}

/** Settings → Folders as saved, kept up to date while the inspector is open. Null until it has been read. */
function useSettingsFolders(): FolderSetting[] | null {
    const [folders, setFolders] = useState<FolderSetting[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        void window.api.settings.get().then((settings) => {
            if (!cancelled) setFolders(settings.folders);
        });
        const off = window.api.on.settings((settings) => setFolders(settings.folders));
        return () => {
            cancelled = true;
            off();
        };
    }, []);
    return folders;
}

/**
 * The folders a Processor's run reaches besides its run folder, ticked from
 * Settings → Folders, each read or also written in up to what Settings allows
 * there. A tick naming a folder Settings no longer lists stays, flagged, to be unticked.
 */
function FoldersField({config, patch}: Section<ProcessorConfig>): JSX.Element {
    const folders = useSettingsFolders();
    const named = (name: string) => (grant: FolderGrant): boolean => grant.folder.toLowerCase() === name.toLowerCase();
    const set = (name: string, access: FolderAccess | null): void => {
        const has = config.folders.some(named(name));
        patch({
            folders:
                access === null
                    ? config.folders.filter((g) => !named(name)(g))
                    : has
                        ? config.folders.map((g) => (named(name)(g) ? {...g, access} : g))
                        : [...config.folders, {folder: name, access}],
        });
    };
    const stranded = folders ? config.folders.filter((g) => !findFolder(folders, g.folder)) : [];
    const ticked = config.folders.length > 0;

    return (
        <>
            {folders?.map((folder) => {
                const grant = config.folders.find(named(folder.name));
                const writable = folder.access === 'write';
                return (
                    <div key={folder.name} className="pick-row" title={folder.path}>
                        <label className="check">
                            <input
                                type="checkbox"
                                checked={grant !== undefined}
                                onChange={(e) => set(folder.name, e.target.checked ? 'read' : null)}
                            />
                            {folder.name}
                        </label>
                        {grant && (
                            <select
                                className="compact"
                                aria-label={`What the run may do in ${folder.name}`}
                                value={writable ? grant.access : 'read'}
                                disabled={!writable}
                                title={writable ? undefined : 'Settings → Folders allows reading here, and nothing more.'}
                                onChange={(e) => set(folder.name, e.target.value as FolderAccess)}
                            >
                                <option value="read">Read only</option>
                                <option value="write">Read and write</option>
                            </select>
                        )}
                    </div>
                );
            })}
            {stranded.map((grant) => (
                <div key={grant.folder} className="pick-row">
                    <label className="check">
                        <input type="checkbox" checked onChange={() => set(grant.folder, null)}/>
                        {grant.folder}
                    </label>
                    <span className="dim">not in Settings</span>
                </div>
            ))}
            <div className="hint">
                {!folders
                    ? 'Reading Settings → Folders…'
                    : config.filesAnywhere
                        ? `While “${FILES_ANYWHERE_LABEL}” is ticked below, its file tools reach every folder, ticked or not.`
                        : stranded.length > 0
                            ? `Settings → Folders on this computer lists no ${stranded.map((g) => `“${g.folder}”`).join(' or ')}, so the run stops with an error. Add ${stranded.length === 1 ? 'it' : 'them'} there under the same name, or untick ${stranded.length === 1 ? 'it' : 'each'}.`
                            : folders.length === 0
                                ? 'Its file tools reach its run folder alone, where attachments are saved. Add a folder in Settings → Folders to tick it here.'
                                : ticked
                                    ? 'Its file tools reach these and its run folder, and nowhere else.'
                                    : 'Its file tools reach its run folder alone, where attachments are saved.'}
            </div>
            {folders && (
                <button className="field-link" onClick={() => void window.api.window.showSettings()}>
                    Open Settings
                </button>
            )}
            <div className="gap"/>
        </>
    );
}

/**
 * A Processor's box from before folders were picked in Settings, which gave its
 * run files anywhere. It still does, until it is unticked, which is for good.
 */
function FilesAnywhereField({config, patch}: Section<ProcessorConfig>): JSX.Element | null {
    if (!config.filesAnywhere) return null;
    return (
        <>
            <label className="check">
                <input type="checkbox" checked onChange={() => patch({filesAnywhere: undefined})}/>
                {FILES_ANYWHERE_LABEL}
            </label>
            <div className="hint">
                From before a node picked its folders: the run still reads and writes anywhere. Tick the folders it
                needs above, then untick this. Once unticked it cannot be ticked again.
            </div>
            <div className="gap"/>
        </>
    );
}

/**
 * The boxes a Processor from an older flow still has ticked for work it no
 * longer does, each to be unticked once the node that does it now is in place.
 * Unticked, a box is gone for good: there is nothing to tick it back for.
 */
function RetiredToolsField({config, patch}: Section<ProcessorConfig>): JSX.Element | null {
    const retired = config.retiredTools ?? [];
    if (retired.length === 0) return null;
    const one = retired.length === 1;
    const instead = retired.map((tool) => `a ${RETIRED_TOOLS[tool].node}`).join(' and ');
    return (
        <>
            {retired.map((tool) => (
                <label key={tool} className="check">
                    <input
                        type="checkbox"
                        checked
                        onChange={() => {
                            const left = retired.filter((t) => t !== tool);
                            patch({retiredTools: left.length > 0 ? left : undefined});
                        }}
                    />
                    {RETIRED_TOOLS[tool].label}
                </label>
            ))}
            <div className="hint">
                {`A Processor no longer does ${one ? 'this' : 'these'}, and the run does not get ${one ? 'it' : 'them'}. ` +
                    `Put ${instead} after this node to do ${one ? 'it' : 'them'} with no model, take ` +
                    `${one ? 'it' : 'them'} out of the instruction, then untick ${one ? 'it' : 'each'} here.`}
            </div>
        </>
    );
}

/**
 * What a step may reach beyond the email — its server tools, and a Processor's
 * folders and shell — folded to a line that says what that comes to. It opens on
 * its own when there is something a person should see, and never closes on its own.
 */
function AccessSection({summary, attention, children}: {
    summary: string;
    /** Something beyond its skills' tools and its run folder is granted, or stands in a run's way. */
    attention: boolean;
    children: ReactNode;
}): JSX.Element {
    const [open, setOpen] = useState(attention);
    // A server's state is read after the section first shows, so what needs a look can come later.
    useEffect(() => {
        if (attention) setOpen(true);
    }, [attention]);
    return (
        <div className="access">
            <button className="access-head" aria-expanded={open} onClick={() => setOpen(!open)}>
                <span className="dim">{open ? '▾' : '▸'}</span>
                <span className="access-title">Access</span>
                <span className="access-summary">{summary}</span>
            </button>
            {open && <div className="access-body">{children}</div>}
        </div>
    );
}

/** A node's server tools in a few words: how many, all of which servers, and where they come from. */
function toolsSummary(tools: string[], own: number): string {
    if (tools.length === 0) return 'no server tools';
    const servers = tools.filter((t) => !t.slice('mcp__'.length).includes('__')).map((t) => `all of ${t.slice('mcp__'.length)}`);
    const singles = tools.length - servers.length;
    const what = spoken([...(singles > 0 ? [`${singles} server tool${singles === 1 ? '' : 's'}`] : []), ...servers]);
    if (own === 0) return `${what} from its skills`;
    return own >= tools.length ? `${what} ticked here` : `${what}, ${own} ticked here`;
}

/**
 * What stands in the way of the servers a node's tools come from, one entry a
 * server: not allowed yet, blocked, missing a value, or defined nowhere. Read
 * without starting any of them. Null until the workspace's servers are read.
 */
function useServerProblems(tools: string[]): string[] | null {
    const [servers, setServers] = useState<McpServerEntry[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        const refresh = (): void => {
            void window.api.mcp.servers().then((listing) => {
                if (!cancelled) setServers(listing.servers.filter((s) => s.state !== 'shadowed'));
            });
        };
        refresh();
        const off = window.api.on.workspaceChanged((change) => {
            if (change.mcp) refresh();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, []);
    if (!servers) return null;
    const problems = new Map<string, string>();
    for (const tool of tools) {
        const entry = servers.find((s) => tool === `mcp__${s.name}` || tool.startsWith(`mcp__${s.name}__`));
        const name = entry?.name ?? tool.slice('mcp__'.length).split('__')[0] ?? tool;
        if (problems.has(name)) continue;
        if (!entry) problems.set(name, `no server ${name} here`);
        else if (entry.state === 'new' || entry.state === 'changed') problems.set(name, `${name} not allowed yet`);
        else if (entry.state === 'blocked') problems.set(name, `${name} blocked`);
        else if (entry.state === 'invalid') problems.set(name, `${name} cannot start`);
        else if (entry.variables.some((v) => v.source === 'missing')) problems.set(name, `${name} needs a value`);
    }
    return [...problems.values()];
}

/** What a node's ticked skills grant it: each tool with the skills that do, and what they name that no skill can. */
interface SkillToolGrants {
    tools: Map<string, string[]>;
    ungranted: string[];
}

function grantsOf(skills: string[], library: Library): SkillToolGrants {
    const ticked = library.skills.filter((skill) => skills.includes(skill.name));
    return {
        tools: skillGrants(skills, library.skills),
        ungranted: [...new Set(ticked.flatMap((skill) => skill.ungranted))],
    };
}

/** Names in quotes, joined as a sentence says them: “a”, “b” and “c”. */
function quotedList(names: string[]): string {
    const quoted = names.map((name) => `“${name}”`);
    return quoted.length < 2 ? (quoted[0] ?? '') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

/** One of the workspace's servers, and the tools it offered when asked. */
interface ServerListing {
    entry: McpServerEntry;
    tools: McpServerTool[] | null;
    error: string | null;
}

/**
 * The tools a node takes from the workspace's MCP servers, ticked one by one:
 * the run is handed those and no others. Each allowed server is asked for its
 * list only while such a node is open here; one that has not been allowed yet
 * waits on its button first, and one missing a value it looks up waits on that.
 */
function McpToolsField({
                           config,
                           patch,
                           grants,
                           hint = 'The run gets what its ticked skills grant and what is ticked here, and nothing else. A server with neither is not started for it.',
                       }: Section<{ mcpTools: string[] }> & { grants: SkillToolGrants; hint?: string }): JSX.Element {
    const [servers, setServers] = useState<ServerListing[] | null>(null);
    const [unreadable, setUnreadable] = useState<McpListing['unreadable']>([]);
    /** Why allowing a server, or setting a value for one, failed: this window has no banner to say it in. */
    const [trustError, setTrustError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [setting, setSetting] = useState<{ server: string; variable: McpVariable } | null>(null);
    const missing = (entry: McpServerEntry): McpVariable[] => entry.variables.filter((v) => v.source === 'missing');
    /** Allowed, and with every value it looks up to be had. */
    const startable = (entry: McpServerEntry): boolean => entry.state === 'allowed' && missing(entry).length === 0;

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
                if (entry.state !== 'allowed' || entry.variables.some((v) => v.source === 'missing')) continue;
                window.api.mcp.serverTools(entry.name).then(
                    (tools) => update(entry.name, {tools}),
                    (e: Error) => update(entry.name, {error: e.message}),
                );
            }
        };
        const refresh = (): void => {
            void window.api.mcp.servers().then(apply);
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
        window.api.mcp.trustServer(name, true).catch((e: Error) => setTrustError(e.message));
    };
    const saveSecret = (server: string, variable: string, value: string): void => {
        setTrustError(null);
        window.api.mcp.setServerSecret(server, variable, value).catch((e: Error) => setTrustError(e.message));
    };

    const picked = config.mcpTools;
    const granted = grants.tools;
    /** Whether the run gets it: ticked here, or granted by a skill the node ticks. */
    const gets = (ref: string): boolean => picked.includes(ref) || granted.has(ref);
    /** Granted by a skill and not ticked here, so there is no tick here to take off. */
    const locked = (ref: string): boolean => granted.has(ref) && !picked.includes(ref);
    const set = (ref: string, on: boolean): void =>
        patch({mcpTools: on ? [...picked, ref] : picked.filter((t) => t !== ref)});
    const offered = new Set(
        (servers ?? []).flatMap(({entry, tools}) => [
            `mcp__${entry.name}`,
            ...(tools ?? []).map((t) => `mcp__${entry.name}__${t.name}`),
        ]),
    );
    const settled = servers?.every(({entry, tools, error}) => !startable(entry) || tools || error) ?? false;
    const unoffered = (t: string): boolean =>
        !offered.has(t) && !(servers ?? []).some(({entry}) => !startable(entry) && t.startsWith(`mcp__${entry.name}__`));
    // Ticked but offered by no server here: shown, so the tick can be taken off.
    const stranded = settled ? picked.filter(unoffered) : [];
    // Granted the same way: there is no tick to take off, so the skill is what to change.
    const strandedGrants = settled ? [...granted.keys()].filter((t) => !picked.includes(t) && unoffered(t)) : [];

    return (
        <>
            <Legend
                label="Tools from MCP servers"
                hint={
                    servers?.length === 0 && unreadable.length === 0
                        ? 'No MCP servers in this workspace. Add them to .mcp.json at the top of its folder.'
                        : hint
                }
            />
            {unreadable.map((u) => (
                <p key={u.source} className="hint err">
                    Could not read <code>{u.source}</code>: {u.problem}
                </p>
            ))}
            {trustError && <p className="hint err">{trustError}</p>}
            {grants.ungranted.length > 0 && (
                <p className="hint">
                    {quotedList(grants.ungranted)} in its skills’ <code>allowed-tools</code>{' '}
                    {grants.ungranted.length === 1 ? 'is' : 'are'} left out: a skill grants only tools of the
                    workspace’s MCP servers.
                </p>
            )}
            {strandedGrants.length > 0 && (
                <p className="hint err">
                    {strandedGrants.map((t) => `${t} (from ${granted.get(t)?.join(', ')})`).join('; ')}: no server
                    here offers {strandedGrants.length === 1 ? 'it' : 'them'}. Correct the name in the
                    skill’s <code>allowed-tools</code>, or add the server.
                </p>
            )}
            <PickFilter
                value={query}
                total={(servers ?? []).reduce((sum, server) => sum + (server.tools?.length ?? 0), 0)}
                noun="tools"
                onChange={setQuery}
            />
            {servers?.map(({entry, tools, error}) => {
                const whole = `mcp__${entry.name}`;
                const takesAll = gets(whole);
                const allowed = entry.state === 'allowed';
                const from = entry.source;
                return (
                    <PickGroup
                        key={`${entry.source}:${entry.name}`}
                        title={entry.name}
                        tip={entry.summary ? `From ${from} · ${entry.summary}` : `From ${from}`}
                        // Taking the whole server leaves nothing to pick one by one.
                        items={allowed && !takesAll ? (tools ?? []) : []}
                        isTicked={(tool) => gets(`${whole}__${tool.name}`)}
                        query={query}
                        text={(tool) => `${tool.name} ${tool.description}`}
                        count={
                            !allowed
                                ? from
                                : takesAll
                                    ? 'every tool'
                                    : tools
                                        ? `${tools.length} · ${from}`
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
                            ) : missing(entry).length > 0 ? (
                                <>
                                    Needs a value for{' '}
                                    {missing(entry).map((variable, i) => (
                                        <Fragment key={variable.name}>
                                            {i > 0 && ', '}
                                            <code>{variable.name}</code>{' '}
                                            <button
                                                className="compact"
                                                onClick={() => setSetting({server: entry.name, variable})}
                                            >
                                                Set…
                                            </button>
                                        </Fragment>
                                    ))}{' '}
                                    before it can start. It is kept encrypted on this computer.
                                </>
                            ) : takesAll ? undefined : error ? (
                                `Could not ask ${entry.name} for its tools: ${error}`
                            ) : !tools ? (
                                `Asking ${entry.name} for its tools…`
                            ) : undefined
                        }
                        actions={
                            allowed ? (
                                <label
                                    className="check"
                                    title={
                                        granted.has(whole)
                                            ? `Every tool it offers, granted by ${granted.get(whole)?.join(', ')}`
                                            : 'Every tool it offers, including any it adds later'
                                    }
                                >
                                    <input
                                        type="checkbox"
                                        checked={takesAll}
                                        disabled={locked(whole)}
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
                            const by = granted.get(ref);
                            return (
                                <div
                                    key={ref}
                                    className="pick-row"
                                    title={by ? `${tool.description}\n\nGranted by ${by.join(', ')}.` : tool.description}
                                >
                                    <label className="check">
                                        <input
                                            type="checkbox"
                                            checked={gets(ref)}
                                            disabled={locked(ref)}
                                            onChange={(e) => set(ref, e.target.checked)}
                                        />
                                        {tool.name}
                                    </label>
                                    {by && <span className="from">{`from ${by.join(', ')}`}</span>}
                                </div>
                            );
                        }}
                    />
                );
            })}
            {setting && (
                <SecretDialog
                    server={setting.server}
                    variable={setting.variable}
                    onCancel={() => setSetting(null)}
                    onSave={(value) => {
                        setSetting(null);
                        saveSecret(setting.server, setting.variable.name, value);
                    }}
                />
            )}
            <StrandedGroup title="No server here offers" names={stranded} onUntick={(ref) => set(ref, false)}/>
        </>
    );
}

/**
 * What goes into the prompt: the email, slots an earlier node filled, or both.
 * A node without `readEmail` always reads the email. Its attachments are
 * ticked under the email, as part of reading it.
 */
function InputsField({
                         config,
                         patch,
                         available,
                         attachments,
                     }: Section<{ inputs: string[]; readEmail?: boolean }> & {
    available: Available | undefined;
    attachments: { checked: boolean; onChange(checked: boolean): void };
}): JSX.Element {
    const emailRead = config.readEmail ?? true;
    const offered = [...(available?.keys() ?? [])].filter((name) => name !== EMAIL_SLOT.name);

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
                    checked={emailRead}
                    onChange={(e) => patch({readEmail: e.target.checked})}
                />
                The email — its body
            </label>
            <label className="check sub" title={emailRead ? undefined : 'Needs the email ticked.'}>
                <input
                    type="checkbox"
                    disabled={!emailRead}
                    checked={emailRead && attachments.checked}
                    onChange={(e) => attachments.onChange(e.target.checked)}
                />
                Its attachments, saved to the run folder to read
            </label>
            <SlotTicks
                offered={offered}
                ticked={config.inputs}
                available={available}
                onChange={(inputs) => patch({inputs})}
            />
            <div className="gap"/>
        </>
    );
}

/**
 * Slots to tick, each with its type. One ticked but not sure to arrive is shown
 * too, so the tick can be taken off.
 */
function SlotTicks({offered, ticked, available, onChange}: {
    offered: string[];
    ticked: string[];
    available: Available | undefined;
    onChange(ticked: string[]): void;
}): JSX.Element {
    const stranded = ticked.filter((name) => !offered.includes(name));
    return (
        <>
            {[...offered, ...stranded].map((name) => {
                const type = available?.get(name);
                return (
                    <label className="check" key={name}>
                        <input
                            type="checkbox"
                            checked={ticked.includes(name)}
                            onChange={(e) =>
                                onChange(e.target.checked ? [...ticked, name] : ticked.filter((n) => n !== name))
                            }
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
        </>
    );
}

/** The fields that reach a node, as a datalist a field box offers by its `id`. */
function FieldOptions({id, available, schemas}: {
    id: string;
    available: Available | undefined;
    schemas: Schemas;
}): JSX.Element {
    return (
        <datalist id={id}>
            {(available ? ruleFields(schemas, available) : []).map((f) => (
                <option key={f.field} value={f.field}/>
            ))}
        </datalist>
    );
}

/** What a field's legend says while no trigger reaches the node. */
const NO_FIELDS_YET = 'Connect this node to a trigger to see which fields reach it.';

/**
 * The slot a node fills with a shape of the app's own, by its name. `optional`
 * lets it be left blank, for a node that hands nothing on.
 */
function SlotField({value, onChange, hint, optional = false}: {
    value: string;
    onChange(name: string): void;
    hint: string;
    optional?: boolean;
}): JSX.Element {
    // A draft, so a half-typed name is never saved in place of the last good one.
    const [draft, setDraft] = useState(value);
    const problem = (name: string): string | null => (optional && name === '' ? null : slotNameProblem(name));
    return (
        <Field label="Output slot" hint={problem(draft) ?? hint}>
            <input
                value={draft}
                placeholder={optional ? '(hands nothing on)' : undefined}
                spellCheck={false}
                onChange={(e) => {
                    setDraft(e.target.value);
                    if (!problem(e.target.value)) onChange(e.target.value);
                }}
            />
        </Field>
    );
}

/**
 * A Switch's table of rules, read top to bottom: each a field, the value it is
 * compared with, and the route it leads down. The field box offers the fields
 * that reach the node, and the value box a field's choices.
 */
function RuleTable({
                       nodeId,
                       rules,
                       routes,
                       onChange,
                       available,
                       schemas,
                   }: {
    nodeId: string;
    rules: SwitchRule[];
    routes: SwitchRoute[];
    onChange(rules: SwitchRule[]): void;
    available: Available | undefined;
    schemas: Schemas;
}): JSX.Element {
    const fields = available ? ruleFields(schemas, available) : [];
    const valuesOf = (field: string): string[] | null => fields.find((f) => f.field === field.trim())?.values ?? null;
    const fieldList = `rule-fields-${nodeId}`;

    const replace = (index: number, rule: Partial<SwitchRule>): void =>
        onChange(rules.map((r, j) => (j === index ? {...r, ...rule} : r)));
    const move = (index: number, by: number): void => {
        const next = [...rules];
        const [rule] = next.splice(index, 1);
        if (rule) next.splice(index + by, 0, rule);
        onChange(next);
    };

    return (
        <>
            <FieldOptions id={fieldList} available={available} schemas={schemas}/>
            {rules.map((rule, i) => {
                const values = valuesOf(rule.field);
                const valueList = `${fieldList}-${i}`;
                return (
                    <div key={i} className="card">
                        <div className="row">
                            <input
                                value={rule.field}
                                list={fieldList}
                                placeholder="slot.field"
                                aria-label={`Rule ${i + 1}: field`}
                                spellCheck={false}
                                onChange={(e) => replace(i, {field: e.target.value})}
                            />
                            <span className="field-tools fixed">
                                <button className="ghost icon" title="Move up" disabled={i === 0}
                                        onClick={() => move(i, -1)}>
                                    ↑
                                </button>
                                <button
                                    className="ghost icon"
                                    title="Move down"
                                    disabled={i === rules.length - 1}
                                    onClick={() => move(i, 1)}
                                >
                                    ↓
                                </button>
                                <button
                                    className="ghost icon remove"
                                    title={`Remove rule ${i + 1}`}
                                    onClick={() => onChange(rules.filter((_, j) => j !== i))}
                                >
                                    ✕
                                </button>
                            </span>
                        </div>
                        <div className="row">
                            <span className="rule-word fixed">is</span>
                            <input
                                value={rule.equals}
                                list={values ? valueList : undefined}
                                placeholder={values ? values.join(' / ') : 'value'}
                                aria-label={`Rule ${i + 1}: value`}
                                spellCheck={false}
                                onChange={(e) => replace(i, {equals: e.target.value})}
                            />
                            {values && (
                                <datalist id={valueList}>
                                    {values.map((v) => (
                                        <option key={v} value={v}/>
                                    ))}
                                </datalist>
                            )}
                        </div>
                        <div className="row">
                            <span className="rule-word fixed">→</span>
                            <select
                                value={rule.route}
                                aria-label={`Rule ${i + 1}: route`}
                                onChange={(e) => replace(i, {route: e.target.value})}
                            >
                                {!routes.some((r) => r.id === rule.route) && (
                                    <option value={rule.route}>Pick a route</option>
                                )}
                                {routes.map((r) => (
                                    <option key={r.id} value={r.id}>
                                        {routeLabel(r)}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                );
            })}
            <button onClick={() => onChange([...rules, {field: '', equals: '', route: routes[0]?.id ?? ''}])}>
                + Add rule
            </button>
        </>
    );
}

function SwitchFields({
                          nodeId,
                          config,
                          patch,
                          available,
                          shelf,
                      }: Section<SwitchConfig> & SchemaProps & {
    nodeId: string;
    available: Available | undefined;
}): JSX.Element {
    const {routes, rules} = config;
    const rename = (index: number, label: string): void =>
        patch({routes: routes.map((r, j) => (j === index ? {...r, label} : r))});
    // A rule that led down the route removed is left leading nowhere, which the
    // canvas flags, rather than quietly sent down another.
    const remove = (index: number): void => {
        const gone = routes[index]?.id;
        patch({
            routes: routes.filter((_, j) => j !== index),
            rules: rules.map((rule) => (rule.route === gone ? {...rule, route: ''} : rule)),
        });
    };

    return (
        <>
            <Legend
                label="Routes"
                hint="Each route is a port of its own. The email leaves by the route of the first rule that matches, or by Otherwise when none does."
            />
            {routes.map((route, i) => (
                <div key={route.id} className="row">
                    <input
                        value={route.label}
                        placeholder="Route name"
                        aria-label={`Route ${i + 1}`}
                        onChange={(e) => rename(i, e.target.value)}
                    />
                    <span className="field-tools fixed">
                        <button
                            className="ghost icon remove"
                            title={`Remove ${routeLabel(route)}`}
                            onClick={() => remove(i)}
                        >
                            ✕
                        </button>
                    </span>
                </div>
            ))}
            <button onClick={() => patch({routes: [...routes, {id: shortId(), label: 'New route'}]})}>
                + Add route
            </button>

            <div className="gap"/>
            <Legend
                label="Rules"
                hint={
                    available
                        ? 'Read top to bottom: the first rule whose field holds its value decides. A field is a slot an earlier node filled and the path into it, such as quote.reply.'
                        : NO_FIELDS_YET
                }
            />
            <RuleTable
                nodeId={nodeId}
                rules={rules}
                routes={routes}
                onChange={(next) => patch({rules: next})}
                available={available}
                schemas={shelf.schemas}
            />

            <div className="gap"/>
            <SlotField
                value={config.output}
                optional
                onChange={(output) => patch({output})}
                hint="Later nodes read which route it took, and why, by this name: filled whichever way the email leaves, so a step where the routes meet again can read it. Blank fills nothing."
            />

            <div className="hint">
                It runs no model and does nothing to the email: it only picks the way on. When no rule matches,
                the email leaves by Otherwise.
            </div>
            <div className="gap"/>
        </>
    );
}

/** A template's placeholders, each filled from a field: its name in the template, and the field it takes. */
function PlaceholderTable({nodeId, placeholders, onChange, available, schemas}: {
    nodeId: string;
    placeholders: Placeholder[];
    onChange(placeholders: Placeholder[]): void;
    available: Available | undefined;
    schemas: Schemas;
}): JSX.Element {
    const fieldList = `placeholder-fields-${nodeId}`;
    const replace = (index: number, change: Partial<Placeholder>): void =>
        onChange(placeholders.map((p, j) => (j === index ? {...p, ...change} : p)));
    return (
        <>
            <FieldOptions id={fieldList} available={available} schemas={schemas}/>
            {placeholders.map((placeholder, i) => (
                <div key={i} className="row">
                    <input
                        value={placeholder.name}
                        placeholder="NAME"
                        aria-label={`Placeholder ${i + 1}: name`}
                        spellCheck={false}
                        onChange={(e) => replace(i, {name: e.target.value})}
                    />
                    <span className="rule-word fixed">←</span>
                    <input
                        value={placeholder.field}
                        list={fieldList}
                        placeholder="slot.field"
                        aria-label={`Placeholder ${i + 1}: field`}
                        spellCheck={false}
                        onChange={(e) => replace(i, {field: e.target.value})}
                    />
                    <span className="field-tools fixed">
                        <button
                            className="ghost icon remove"
                            title={`Remove placeholder ${i + 1}`}
                            onClick={() => onChange(placeholders.filter((_, j) => j !== i))}
                        >
                            ✕
                        </button>
                    </span>
                </div>
            ))}
            <button onClick={() => onChange([...placeholders, {name: '', field: ''}])}>+ Add placeholder</button>
        </>
    );
}

function CreateEmailFields({
                               nodeId,
                               config,
                               patch,
                               available,
                               shelf,
                           }: Section<CreateEmailConfig> & SchemaProps & {
    nodeId: string;
    available: Available | undefined;
}): JSX.Element {
    const fresh = config.mode === 'new';
    const fieldsHint = 'A field an earlier node filled, in braces, is written in by the run: {{shipment.agent_email}}.';
    return (
        <>
            <Field label="Drafts">
                <select value={config.mode} onChange={(e) => patch({mode: e.target.value as EmailMode})}>
                    <option value="reply">A reply to this email</option>
                    <option value="new">A new email</option>
                </select>
            </Field>

            {fresh && (
                <>
                    <Field label="To" hint={`Addresses separated by ; or ,. ${fieldsHint}`}>
                        <input
                            value={config.to}
                            placeholder="ops@example.com; {{shipment.agent_email}}"
                            spellCheck={false}
                            onChange={(e) => patch({to: e.target.value})}
                        />
                    </Field>
                    <Field label="Cc">
                        <input
                            value={config.cc}
                            placeholder="(none)"
                            spellCheck={false}
                            onChange={(e) => patch({cc: e.target.value})}
                        />
                    </Field>
                    <Field label="Subject" hint={fieldsHint}>
                        <input
                            value={config.subject}
                            placeholder="Pre-alert received: B/L {{shipment.bl_no}}"
                            onChange={(e) => patch({subject: e.target.value})}
                        />
                    </Field>
                </>
            )}

            <Field
                label="Template"
                hint="The subject of a template email in this mailbox’s Templates folder."
            >
                <input
                    value={config.template}
                    placeholder="RateReply"
                    spellCheck={false}
                    onChange={(e) => patch({template: e.target.value})}
                />
            </Field>
            <Field
                label="Section"
                hint="One template can hold several emails, each between [[SECTION]] and [[/SECTION]]: the one this node drafts. Blank for a template with none."
            >
                <input
                    value={config.section}
                    placeholder="(the whole template)"
                    spellCheck={false}
                    onChange={(e) => patch({section: e.target.value})}
                />
            </Field>

            <Legend
                label="Placeholders"
                hint={
                    available
                        ? 'Each {{NAME}} in the template, filled from a field an earlier node filled, such as quote.total.'
                        : NO_FIELDS_YET
                }
            />
            <PlaceholderTable
                nodeId={nodeId}
                placeholders={config.placeholders}
                onChange={(placeholders) => patch({placeholders})}
                available={available}
                schemas={shelf.schemas}
            />

            <div className="gap"/>
            <Field
                label="Signature"
                hint="An Outlook signature by its name, put in the template’s {{SIGNATURE}}, or below its text. Blank for none."
            >
                <input
                    value={config.signature}
                    placeholder="(none)"
                    onChange={(e) => patch({signature: e.target.value})}
                />
            </Field>
            {!fresh && (
                <label className="check">
                    <input
                        type="checkbox"
                        checked={config.replyAll}
                        onChange={(e) => patch({replyAll: e.target.checked})}
                    />
                    Reply to everyone on the email, not only its sender
                </label>
            )}

            <SlotField
                value={config.output}
                onChange={(output) => patch({output})}
                hint="Later nodes read whether this run drafted it, and the draft’s id, by this name."
            />

            <div className="hint">
                {fresh
                    ? 'It only drafts: the email waits in Outlook’s Drafts for a person, or a Send node after it, to send. Patchbay keeps a record of each draft, so this node drafts one new email per email that reaches it: a later run leaves by Already drafted.'
                    : 'It only drafts: the reply waits in Outlook’s Drafts for a person, or a Send node after it, to send. Patchbay keeps a record of each draft, so an email gets one reply from a flow, whichever of its Create email nodes a later run reaches: that one leaves by Already drafted. Which reply an email gets, if any, is decided before it, by a Switch.'}
            </div>
            <div className="gap"/>
        </>
    );
}

function SendFields({
                        config,
                        patch,
                        available,
                    }: Section<SendConfig> & {
    available: Available | undefined;
}): JSX.Element {
    const offered = draftSlots(available);

    let hint: string;
    if (!available) hint = 'Connect this node to a trigger to see which drafts reach it.';
    else if (offered.length === 0)
        hint = 'No drafts from earlier nodes yet — put a Create email before this node.';
    else hint = 'Only Draft slots every path here fills are offered. A slot whose Create email left by Already drafted holds no draft of this run’s and is passed over.';

    return (
        <>
            <Legend label="Sends" hint={hint}/>
            <SlotTicks
                offered={offered}
                ticked={config.drafts}
                available={available}
                onChange={(drafts) => patch({drafts})}
            />
            <div className="gap"/>

            <label className="check">
                <input
                    type="checkbox"
                    checked={config.sending}
                    onChange={(e) => patch({sending: e.target.checked})}
                />
                Send the drafts when a watched flow runs
            </label>
            <div className="hint">
                {config.sending
                    ? 'On: a polled run sends the drafts this run made, and leaves by Sent. A test run still holds them back and leaves by Held.'
                    : 'Off: the drafts wait in Outlook’s Drafts for a person, and the run leaves by Held, saying who each would have gone to.'}
            </div>

            <SlotField
                value={config.output}
                onChange={(output) => patch({output})}
                hint="Later nodes read who it sent to, who it held back and what failed by this name."
            />

            <div className="hint">
                It sends only the drafts this run made, by the ids in the slots ticked above, and records each send so
                the same draft is never sent twice. A draft held back by an earlier run is not sent by a later one: send
                it by hand in Outlook.
            </div>
            <div className="gap"/>
        </>
    );
}

function MoveEmailFields({
                             nodeId,
                             config,
                             patch,
                             available,
                             shelf,
                             accounts,
                         }: Section<MoveEmailConfig> & SchemaProps & {
    nodeId: string;
    available: Available | undefined;
    accounts: string[];
}): JSX.Element {
    const [folders, setFolders] = useState<string[]>([]);
    const accountKey = accounts.join('\n');

    useEffect(() => {
        if (accounts.length === 0) return;
        let cancelled = false;
        void Promise.all(accounts.map((account) => window.api.outlook.folders(account).catch(() => []))).then(
            (lists) => {
                if (cancelled) return;
                const paths = lists.flat().map((f) => f.relativePath).filter(Boolean);
                setFolders([...new Set(paths)]);
            },
        );
        return () => {
            cancelled = true;
        };
    }, [accountKey]);

    const fields = available ? ruleFields(shelf.schemas, available) : [];
    const openBrace = /^(.*\{\{)[^{}]*$/.exec(config.folder);
    const suggestions = openBrace ? fields.map((f) => `${openBrace[1]}${f.field}}}`) : folders;
    const folderList = `move-folders-${nodeId}`;

    return (
        <>
            <Field
                label="Folder"
                hint="A folder under the Inbox, such as Processed or Clients\Acme; Outlook creates it if it is not there yet. A field an earlier node filled, in braces, is written in by the run: Processed\{{shipment.client}}."
            >
                <input
                    value={config.folder}
                    list={folderList}
                    placeholder="Processed"
                    spellCheck={false}
                    onChange={(e) => patch({folder: e.target.value})}
                />
                <datalist id={folderList}>
                    {suggestions.map((value) => (
                        <option key={value} value={value}/>
                    ))}
                </datalist>
            </Field>

            <SlotField
                value={config.output}
                optional
                onChange={(output) => patch({output})}
                hint="Later nodes read whether it moved the email, and which folder Outlook put it in, by this name. Blank fills nothing."
            />

            <div className="hint">
                It runs no model. Moving an email in Outlook gives it a new id; a trigger watching more than one folder
                knows an email by sender, time and subject, so filing it from one watched folder into another does not
                run it a second time.
            </div>
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
    /** Mailboxes the flow's triggers watch, for offering their folders. */
    accounts?: string[];

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
                              accounts = [],
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
            {config.kind === 'switch' && (
                <SwitchFields key={node.id} nodeId={node.id} config={config} patch={patch}
                              available={available} shelf={shelf}/>
            )}
            {config.kind === 'extractor' && (
                <ExtractorFields key={node.id} config={config} patch={patch} library={library}
                                 available={available} shelf={shelf}/>
            )}
            {config.kind === 'processor' && (
                <ProcessorFields key={node.id} config={config} patch={patch} library={library}
                                 available={available} shelf={shelf}/>
            )}
            {config.kind === 'create-email' && (
                <CreateEmailFields key={node.id} nodeId={node.id} config={config} patch={patch}
                                   available={available} shelf={shelf}/>
            )}
            {config.kind === 'send' && (
                <SendFields key={node.id} config={config} patch={patch} available={available}/>
            )}
            {config.kind === 'move-email' && (
                <MoveEmailFields key={node.id} nodeId={node.id} config={config} patch={patch}
                                 available={available} shelf={shelf} accounts={accounts}/>
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
