import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { isAgyModel, isClaudeModel, isJevModel, type ModelChoice, offeredTo } from '@shared/flow';
import type { ModelOption } from '@shared/ipc';
import { AGENT_NAMES, type AgentId, type Settings } from '@shared/settings';

/**
 * The ⓘ that shows or hides what a field or section is for. A span rather than
 * a button, so a label around it still labels its control; a click on it is
 * kept from reaching that control.
 */
export function InfoToggle({about, open, onToggle}: {
    /** What it explains, for its accessible name. */
    about: string;
    open: boolean;

    onToggle(): void;
}): JSX.Element {
    return (
        <span
            role="button"
            tabIndex={0}
            className={open ? 'info-toggle on' : 'info-toggle'}
            aria-label={`About ${about}`}
            aria-expanded={open}
            title={open ? 'Hide this' : `What is ${about.toLowerCase()} for?`}
            onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggle();
            }}
            onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onToggle();
            }}
        >
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6.8" fill="none" stroke="currentColor" strokeWidth="1.4"/>
                <rect x="7.25" y="7" width="1.5" height="4.6" rx="0.75" fill="currentColor"/>
                <circle cx="8" cy="4.7" r="0.95" fill="currentColor"/>
            </svg>
        </span>
    );
}

/**
 * A labelled control. `hint` is said under it every time, for what depends on
 * the moment: a problem, or what to do next. `info` is what the field is for,
 * which a person needs once, so it waits behind an ⓘ beside the label.
 */
export function Field({
                          label,
                          hint,
                          info,
                          children,
                      }: {
    label: string;
    hint?: ReactNode;
    info?: ReactNode;
    children: ReactNode;
}): JSX.Element {
    const [about, setAbout] = useState(false);
    return (
        <label className="field">
            <span className="field-label">
                {label}
                {info && <InfoToggle about={label} open={about} onToggle={() => setAbout(!about)}/>}
            </span>
            {about && info && <span className="info">{info}</span>}
            {children}
            {hint && <div className="hint">{hint}</div>}
        </label>
    );
}

export interface Models {
    /** Null until the agents have answered. */
    models: ModelOption[] | null;
    error: string | null;
    /** The agents switched off in Settings, whose models are left out of the list. */
    off: AgentId[];
    /** Settings → Agents' fallback models, in turn. Null until Settings has been read. */
    fallbacks: ModelChoice[] | null;
    /** Settings → Runs' model for the AI monitor. Null until Settings has been read. */
    monitorModel: Settings['monitorModel'] | null;
}

/**
 * The models Claude Code, agy and Jev offer, and the effort levels each takes —
 * asked of them, so a model released after this build is offered without a new
 * one — with Settings kept up to date while it is open: asked again when an
 * agent is switched on or off, which changes what is offered.
 */
export function useModels(): Models {
    const [models, setModels] = useState<ModelOption[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [settings, setSettings] = useState<Settings | null>(null);

    useEffect(() => {
        let cancelled = false;
        void window.api.settings.get().then((read) => {
            if (!cancelled) setSettings(read);
        });
        const off = window.api.on.settings(setSettings);
        return () => {
            cancelled = true;
            off();
        };
    }, []);

    const off = settings?.agents.filter((a) => !a.enabled).map((a) => a.id) ?? null;
    const switchedOff = off?.join() ?? null;
    useEffect(() => {
        // Settings first, so the list is asked for once rather than again when it arrives.
        if (switchedOff === null) return;
        let cancelled = false;
        window.api.agents
            .models()
            .then((list) => {
                if (cancelled) return;
                setModels(list);
                setError(null);
            })
            .catch((e: Error) => {
                if (!cancelled) setError(e.message);
            });
        return () => {
            cancelled = true;
        };
    }, [switchedOff]);

    return {
        models,
        error,
        off: off ?? [],
        fallbacks: settings?.fallbacks ?? null,
        monitorModel: settings?.monitorModel ?? null,
    };
}

/** The list's entry for a node's model: by its own name, or a pinned id an alias stands for today. */
export function findModel(models: ModelOption[] | null, value: string): ModelOption | undefined {
    return models?.find((m) => m.value === value) ?? models?.find((m) => m.resolvedModel === value);
}

/** A model as a sentence names it: its name in the list, and its level when it has one set. */
export function modelName(models: ModelOption[] | null, choice: { model: string; effort: string }): string {
    const name = findModel(models, choice.model)?.displayName ?? choice.model;
    return choice.effort ? `${name} (${choice.effort})` : name;
}

/** A node keeps a model the list does not name, and says so, rather than showing another in its place. */
export function ModelField({
                               label = 'Model',
                               value,
                               models,
                               error,
                               off,
                               jev,
                               onChange,
                           }: Pick<Models, 'models' | 'error' | 'off'> & {
    label?: string;
    value: string;
    /** Whether the step is one Jev can take, a Categorizer's: no other is offered its models. */
    jev: boolean;
    onChange(model: string): void;
}): JSX.Element {
    const listed = models?.find((m) => m.value === value);
    const sameToday = models?.find((m) => m.resolvedModel === value);
    const agent: AgentId = isAgyModel(value) ? 'agy' : isJevModel(value) ? 'jev' : 'claude';
    let hint: string;
    if (error) hint = `Could not ask the agents which models they offer: ${error}`;
    else if (!models) hint = 'Asking the agents…';
    else if (agent === 'jev' && !jev) {
        hint = `Jev answers a Categorizer's question and nothing else, so this step passes ${value} over. Pick another model.`;
    } else if (listed) hint = listed.description;
    else if (sameToday) hint = `Pinned to ${value}. ${sameToday.displayName} is that model today, and moves on to each new one.`;
    else if (off.includes(agent)) {
        hint = `${AGENT_NAMES[agent]} is switched off in Settings → Agents, so the step passes ${value} over. The node keeps it meanwhile.`;
    } else if (agent === 'jev') {
        hint = `${value} is not among the models Jev lists now. They are listed once a TypeSafe API key is set in Settings → Agents, and a pinned version once it has answered since Patchbay started. The node keeps ${value} meanwhile.`;
    }
    // Claude lists nothing at all while Claude Code is missing; any model no other agent claims is its.
    else if (models.every((m) => !isClaudeModel(m.value))) {
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
 * A model's level once its model changes. A level the new model does not take
 * goes back to that model's default, or to its top level where it has none. A
 * model that takes none leaves the level alone, for the next one that does.
 */
export function effortAfter(models: ModelOption[] | null, model: string, effort: string): string {
    const picked = findModel(models, model);
    const levels = picked?.effortLevels ?? [];
    if (levels.length === 0 || levels.includes(effort)) return effort;
    return picked?.effortRequired ? (levels.at(-1) ?? '') : '';
}

/** The chosen model's effort levels. A saved level it doesn't take is kept, with a note. */
export function EffortField({
                                value,
                                model,
                                loading,
                                onChange,
                            }: {
    value: string;
    /** Undefined while the list is on its way, or when the model is not in it. */
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

/** The AI monitor's model and level, as Settings → Runs sets them. Jev's are not offered: a review is not a choice. */
export function MonitorModelPicker({value, onChange}: {
    value: Settings['monitorModel'];
    onChange(choice: Settings['monitorModel']): void;
}): JSX.Element {
    const offered = useModels();
    const listing = {...offered, models: offered.models && offeredTo('processor', offered.models)};
    return (
        <div className="card model-card">
            <div className="model-body">
                <ModelField
                    {...listing}
                    jev={false}
                    value={value.model}
                    onChange={(model) => onChange({model, effort: effortAfter(listing.models, model, value.effort)})}
                />
                <EffortField
                    value={value.effort}
                    model={findModel(listing.models, value.model)}
                    loading={!listing.models && !listing.error}
                    onChange={(effort) => onChange({...value, effort})}
                />
            </div>
        </div>
    );
}

/**
 * Settings' fallback models, in the order every step goes on to them, each with
 * its own level: dragged into order, switched off to be passed over, removed or
 * added. It may be empty: a step then waits for its own model's limit to lift.
 * Jev's are not offered, since it answers a Categorizer's question and nothing else.
 */
export function FallbackList({value, onChange}: {
    value: ModelChoice[];
    onChange(models: ModelChoice[]): void;
}): JSX.Element {
    const offered = useModels();
    // Any kind but a Categorizer's is offered every model but Jev's.
    const listing = {...offered, models: offered.models && offeredTo('processor', offered.models)};
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
    let turn = 0;
    const roles = value.map((c) => (c.enabled ? `Fallback ${++turn}` : 'Off'));
    // A drop that would leave the entry where it is shows no line.
    const shownAt = dragging !== null && dropAt !== dragging && dropAt !== dragging + 1 ? dropAt : null;
    // One not listed yet, else the first: listing one twice gains nothing, as a step tries each model once.
    const next = listing.models?.find((m) => !value.some((c) => c.model === m.value)) ?? listing.models?.[0];

    return (
        <>
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
                {value.map((choice, i) => (
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
                                title={choice.enabled ? 'Turn it off to pass it over, keeping its place' : 'Turn it back on'}
                            >
                                <input
                                    type="checkbox"
                                    checked={choice.enabled}
                                    onChange={(e) => replace(i, {enabled: e.target.checked})}
                                />
                                {roles[i]}
                            </label>
                            <button className="danger compact"
                                    onClick={() => onChange(value.filter((_, j) => j !== i))}>
                                Remove
                            </button>
                        </div>
                        {/* Not side by side: the model's hint says which version it is, and wants the width. */}
                        <div className="model-body">
                            <ModelField
                                {...listing}
                                jev={false}
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
                ))}
            </div>
            <button
                disabled={!next}
                title={next ? undefined : 'Waiting for the agents to list their models'}
                onClick={() => {
                    if (!next) return;
                    const effort = next.effortRequired ? (next.effortLevels.at(-1) ?? '') : '';
                    onChange([...value, {model: next.value, effort, enabled: true}]);
                }}
            >
                + Add a fallback model
            </button>
        </>
    );
}
