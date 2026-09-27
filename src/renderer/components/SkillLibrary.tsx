import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { NameDialog } from './NameDialog';
import { PickFilter, PickGroup } from './PickGroup';
import { type GlobalSkillFolder, SKILL_SCOPES, skillRef, type SkillScope, type SkillSummary } from '@shared/settings';

const TEMPLATE = (name: string): string => `---
name: ${name}
description: One or two sentences on what this skill does and when Claude should reach for it. This text is how the model decides to use it, so be concrete.
---

# ${name}

Describe the job in steps. The tools under \`mcp__email__\` are scoped to the one
email being processed.

## Steps

1. Call \`read_email\` to get the full body.
2. …
3. Call \`record_note\` with what you concluded, so it lands in the run trace.

## Rules

- Never invent a fact that is not in the email or an attachment you read.
- Ask for nothing; if the email is ambiguous, say so in the note.
`;

/** Marks a drag as one of ours, and carries the name being dragged. */
const DRAG_TYPE = 'application/patchbay-skill';

const SCOPE_LABEL = { global: 'Global', flow: 'This flow' } as const;

const otherScope = (scope: SkillScope): SkillScope => (scope === 'global' ? 'flow' : 'global');

/** A skill open in the editor. */
export interface SkillEdit {
    scope: SkillScope;
    name: string;
    /** What a skill not yet saved starts as; absent for one already on its shelf. */
    template?: string;
}

/** The open flow's two libraries, and what the list does to them. */
export interface Library {
    /** The open flow, whose own library is one of the two on offer. */
    flowId: string;
    flowName: string;
    /** Both libraries; each entry says which it came from. */
    skills: SkillSummary[];
    /** How many other flows a skill leaving the global library would abandon. */
    otherFlowCount: number;

    onRefresh(): void;

    /** A skill changed library: the open flow's ticks for it need re-pointing. */
    onMoved(from: SkillScope, to: SkillScope, name: string): void;

    /** Open one in the editor, which takes the panel over until it is closed. */
    onEdit(edit: SkillEdit): void;
}

/**
 * The global library's folders, highest first. Re-read with the list, which is
 * what refreshes when another window or an agent changes them.
 */
function useFolders(skills: SkillSummary[]): GlobalSkillFolder[] {
    const [folders, setFolders] = useState<GlobalSkillFolder[]>([]);
    useEffect(() => {
        void window.api.skills.folders().then(setFolders);
    }, [skills]);
    return folders;
}

/** The linked folder a global skill is kept in, or null when it is in the workspace. */
function whereKept(folders: GlobalSkillFolder[], name: string): string | null {
    const folder = folders.find((f) => f.skills.some((s) => s.name === name && !s.shadowed));
    return folder && !folder.workspace ? folder.path : null;
}

interface Dragged {
    scope: SkillScope;
    name: string;
}

interface ShelfProps {
    library: Library;
    /** The selected node's ticks. Without them the list only keeps the libraries. */
    picked?: string[];

    onPick?(refs: string[]): void;
}

/**
 * Both libraries, one above the other: where a node ticks its skills, and where
 * they are written, imported and moved between the two.
 */
export function SkillShelf({ library, picked, onPick }: ShelfProps): JSX.Element {
    const { flowId, flowName, skills, otherFlowCount, onRefresh, onMoved, onEdit } = library;
    /** One slot for both outcomes; `bad` is the difference between them. */
    const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
    /** The library a new skill is being named for, while the dialog is up. */
    const [naming, setNaming] = useState<SkillScope | null>(null);
    /** Held here rather than read off the drag, which hides its data until the drop. */
    const [dragging, setDragging] = useState<Dragged | null>(null);
    /** The library a dragged skill is hovering over, so it can say so. */
    const [dropOn, setDropOn] = useState<SkillScope | null>(null);
    /** A move worth asking about first: it overwrites, or it abandons other flows. */
    const [confirming, setConfirming] = useState<Dragged | null>(null);
    const [query, setQuery] = useState('');
    const folders = useFolders(skills);
    const linkedCount = folders.filter((f) => !f.workspace).length;

    const libraryName = (which: SkillScope): string =>
        which === 'global' ? 'the global library' : `“${flowName}”`;
    const say = (text: string): void => setMessage({ text, bad: false });
    const failed = (e: unknown): void => setMessage({ text: (e as Error).message, bad: true });

    const toggle = (ref: string, on: boolean): void => {
        if (!picked || !onPick) return;
        onPick(on ? [...picked, ref] : picked.filter((s) => s !== ref));
    };

    const isTicked = picked && ((skill: SkillSummary): boolean => picked.includes(skillRef(skill.scope, skill.name)));
    const skillText = (skill: SkillSummary): string => `${skill.name} ${skill.description}`;

    // Ticked but in neither library (e.g. imported from another install). There is
    // no skill to show it by, so it is listed on its own to be unticked.
    const offered = new Set(skills.map((skill) => skillRef(skill.scope, skill.name)));
    const missing = picked?.filter((ref) => !offered.has(ref)) ?? [];

    /** Whether moving `skill` to the other library needs a question first. */
    const moveWarnings = ({ scope, name }: Dragged): string[] => {
        const to = otherScope(scope);
        const warnings: string[] = [];
        if (skills.some((s) => s.scope === to && s.name === name)) {
            warnings.push(`${libraryName(to)} already has a “${name}”, and this one replaces it.`);
        }
        if (scope === 'global' && otherFlowCount > 0) {
            warnings.push(
                `It leaves the global shelf, so the ${otherFlowCount} other flow${otherFlowCount === 1 ? '' : 's'} can no longer tick it. This flow’s own ticks are re-pointed for you.`,
            );
        }
        const kept = scope === 'global' ? whereKept(folders, name) : null;
        if (kept) warnings.push(`Its folder is taken out of ${kept}.`);
        return warnings;
    };

    const move = async ({ scope, name }: Dragged): Promise<void> => {
        const to = otherScope(scope);
        setMessage(null);
        try {
            await window.api.skills.move(scope, to, flowId, name);
            onRefresh();
            onMoved(scope, to, name);
            say(`Moved “${name}” to ${libraryName(to)}.`);
        } catch (e) {
            failed(e);
        }
    };

    const drop = (skill: Dragged): void => {
        setDropOn(null);
        setDragging(null);
        if (moveWarnings(skill).length > 0) setConfirming(skill);
        else void move(skill);
    };

    const create = (scope: SkillScope, name: string): void => {
        const clean = name.toLowerCase();
        setNaming(null);
        onEdit({ scope, name: clean, template: TEMPLATE(clean) });
    };

    const importSkills = async (scope: SkillScope): Promise<void> => {
        setMessage(null);
        try {
            const result = await window.api.skills.pickAndImport(scope, flowId);
            if (result) {
                onRefresh();
                const said =
                    result.imported.length > 0
                        ? `Imported ${result.imported.length} into ${libraryName(scope)}: ${result.imported.join(', ')}.`
                        : 'Nothing imported.';
                say(result.skipped.length > 0 ? `${said} Skipped ${result.skipped.join('; ')}.` : said);
            }
        } catch (e) {
            failed(e);
        }
    };

    return (
        <>
            {message && <div className={message.bad ? 'err-banner' : 'notice'}>{message.text}</div>}

            <PickFilter value={query} total={skills.length} noun="skills" onChange={setQuery}/>

            {SKILL_SCOPES.map((scope) => {
                // A skill can only move to the library it is not already in.
                const accepts = dragging !== null && dragging.scope !== scope;
                return (
                    <PickGroup
                        key={scope}
                        title={SCOPE_LABEL[scope]}
                        items={skills.filter((s) => s.scope === scope)}
                        isTicked={isTicked}
                        query={query}
                        text={skillText}
                        className={dropOn === scope ? 'drop-on' : undefined}
                        tip={
                            scope === 'global' && linkedCount > 0
                                ? `Shared by every flow, including ${linkedCount} linked folder${linkedCount === 1 ? '' : 's'} read in place: editing or deleting a skill from one changes it there.`
                                : scope === 'global'
                                    ? 'Shared by every flow: editing one changes it everywhere.'
                                    : `Only “${flowName}” sees these, and they travel with it when you export.`
                        }
                        empty={
                            scope === 'global'
                                ? 'None yet. Write one, import SKILL.md files, or link a folder of them.'
                                : 'None yet. Keep one here when it should not follow every other flow.'
                        }
                        actions={
                            <>
                                {scope === 'global' && (
                                    <button
                                        className="ghost compact"
                                        onClick={() => void window.api.window.showSettings()}
                                        title="Link folders of skills into the global library, in Settings → Global skills"
                                    >
                                        Folders…
                                    </button>
                                )}
                                <button className="ghost compact" onClick={() => void importSkills(scope)}>
                                    Import…
                                </button>
                                <button className="ghost compact" onClick={() => setNaming(scope)}>
                                    New
                                </button>
                            </>
                        }
                        onDragOver={(e) => {
                            if (!accepts) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            setDropOn(scope);
                        }}
                        onDragLeave={(e) => {
                            // Leaving for one of its own rows is still over it.
                            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                            setDropOn((current) => (current === scope ? null : current));
                        }}
                        onDrop={(e) => {
                            if (!accepts) return;
                            e.preventDefault();
                            drop(dragging);
                        }}
                        row={(skill) => {
                            const ref = skillRef(scope, skill.name);
                            return (
                                <div
                                    key={skill.name}
                                    className="pick-row"
                                    title={skill.description || undefined}
                                    draggable
                                    onDragStart={(e) => {
                                        e.dataTransfer.setData(DRAG_TYPE, skill.name);
                                        e.dataTransfer.effectAllowed = 'move';
                                        setDragging({ scope, name: skill.name });
                                    }}
                                    onDragEnd={() => {
                                        setDragging(null);
                                        setDropOn(null);
                                    }}
                                >
                                    {picked ? (
                                        <label className="check">
                                            <input
                                                type="checkbox"
                                                checked={picked.includes(ref)}
                                                onChange={(e) => toggle(ref, e.target.checked)}
                                            />
                                            {skill.name}
                                        </label>
                                    ) : (
                                        <div className="grow">
                                            <strong>{skill.name}</strong>
                                            <div className="desc">{skill.description || 'No description'}</div>
                                        </div>
                                    )}
                                    <button
                                        className="ghost compact"
                                        onClick={() => onEdit({ scope, name: skill.name })}
                                    >
                                        Edit
                                    </button>
                                </div>
                            );
                        }}
                    />
                );
            })}

            {missing.length > 0 && (
                <PickGroup
                    title="In neither library here"
                    items={missing}
                    isTicked={() => true}
                    query=""
                    text={(ref) => ref}
                    row={(ref) => (
                        <div key={ref} className="pick-row">
                            <label className="check">
                                <input type="checkbox" checked onChange={() => toggle(ref, false)}/>
                                {ref}
                            </label>
                        </div>
                    )}
                />
            )}

            {naming && (
                <NameDialog
                    title={naming === 'global' ? 'New global skill' : 'New skill for this flow'}
                    label="Skill name"
                    initial="my-skill"
                    confirmLabel="Create"
                    hint="Lowercase and hyphens — it becomes the folder name Claude discovers."
                    onCancel={() => setNaming(null)}
                    onConfirm={(name) => create(naming, name)}
                />
            )}

            {confirming && (
                <ConfirmDialog
                    title="Move skill"
                    message={`Move “${confirming.name}” to ${libraryName(otherScope(confirming.scope))}? ${moveWarnings(confirming).join(' ')}`}
                    confirmLabel="Move"
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => {
                        void move(confirming);
                        setConfirming(null);
                    }}
                />
            )}
        </>
    );
}

interface EditorProps {
    edit: SkillEdit;
    flowId: string;
    flowName: string;
    /** Both libraries, re-read when they change, to say which folder holds a global skill. */
    skills: SkillSummary[];

    onRefresh(): void;

    /** Back to the node. `saved` when the skill was written. */
    onClose(saved: boolean): void;
}

/** One SKILL.md, frontmatter and all. It has the panel to itself while it is open. */
export function SkillEditor({ edit, flowId, flowName, skills, onRefresh, onClose }: EditorProps): JSX.Element {
    const { scope, name, template } = edit;
    const [content, setContent] = useState(template ?? '');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const kept = whereKept(useFolders(skills), name);

    useEffect(() => {
        if (template !== undefined) return;
        let cancelled = false;
        void window.api.skills.get(scope, flowId, name).then((detail) => {
            if (!cancelled && detail) setContent(detail.content);
        });
        return () => {
            cancelled = true;
        };
    }, [flowId, name, scope, template]);

    const save = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            await window.api.skills.save(scope, flowId, name, content);
            onRefresh();
            onClose(true);
        } catch (e) {
            setError((e as Error).message);
            setBusy(false);
        }
    };

    const remove = async (): Promise<void> => {
        setDeleting(false);
        setError(null);
        try {
            await window.api.skills.remove(scope, flowId, name);
            onRefresh();
            onClose(false);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    return (
        <div>
            <div className="panel-head plain">
                <strong>{name}</strong>
                <span className="spacer"/>
                <button onClick={() => onClose(false)}>Cancel</button>
                <button className="primary" onClick={() => void save()} disabled={busy}>
                    Save
                </button>
            </div>
            {error && <div className="err-banner">{error}</div>}
            <textarea rows={26} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false}/>
            <div className="hint">
                {scope === 'global' && kept ? (
                    <>
                        Saved as <code>{name}/SKILL.md</code> in <code>{kept}</code>, and offered to every flow.
                    </>
                ) : scope === 'global' ? (
                    <>
                        Saved as <code>global/skills/{name}/SKILL.md</code> in the app workspace, and offered to
                        every flow.
                    </>
                ) : (
                    <>
                        Saved as <code>.claude/skills/{name}/SKILL.md</code> inside this flow’s own folder, where
                        only its nodes can reach it.
                    </>
                )}
            </div>

            {template === undefined && (
                <>
                    <div className="gap"/>
                    <button className="danger" onClick={() => setDeleting(true)}>
                        Delete skill
                    </button>
                </>
            )}

            {deleting && (
                <ConfirmDialog
                    title="Delete skill"
                    message={
                        scope === 'global'
                            ? `Delete “${name}” from the global library? Every flow that ticks it loses it${kept ? `, and its folder is deleted from ${kept}` : ''}.`
                            : `Delete “${name}” from “${flowName}”? Its whole folder goes with it.`
                    }
                    confirmLabel="Delete"
                    onCancel={() => setDeleting(false)}
                    onConfirm={() => void remove()}
                />
            )}
        </div>
    );
}
