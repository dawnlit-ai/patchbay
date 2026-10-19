import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { ContextMenu, type MenuItem } from './ContextMenu';
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

const SCOPE_LABEL = {global: 'Global', flow: 'This flow'} as const;

const otherScope = (scope: SkillScope): SkillScope => (scope === 'global' ? 'flow' : 'global');

/** The open flow's two libraries, and what the list does to them. */
export interface Library {
    /** The open flow, whose own library is one of the two on offer. */
    flowId: string;
    flowName: string;
    /** Both libraries; each entry says which it came from. */
    skills: SkillSummary[];
    /** How many other flows a skill leaving the global library would abandon. */
    otherFlowCount: number;

    /** Re-read both libraries; settles once the list holds what is on disk. */
    onRefresh(): Promise<void>;

    /** A skill changed library: the open flow's ticks for it need re-pointing. */
    onMoved(from: SkillScope, to: SkillScope, name: string): void;
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

/** A skill by where it is kept: what a drag carries, and what a question or menu is about. */
interface SkillKey {
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
 * they are created, imported, moved and deleted. Editing happens in the system's
 * app for `.md` files; the list follows the folder.
 */
export function SkillShelf({library, picked, onPick}: ShelfProps): JSX.Element {
    const {flowId, flowName, skills, otherFlowCount, onRefresh, onMoved} = library;
    /** One slot for both outcomes; `bad` is the difference between them. */
    const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
    /** The library a new skill is being named for, while the dialog is up. */
    const [naming, setNaming] = useState<SkillScope | null>(null);
    /** Held here rather than read off the drag, which hides its data until the drop. */
    const [dragging, setDragging] = useState<SkillKey | null>(null);
    /** The library a dragged skill is hovering over, so it can say so. */
    const [dropOn, setDropOn] = useState<SkillScope | null>(null);
    /** A move worth asking about first: it overwrites, or it abandons other flows. */
    const [confirming, setConfirming] = useState<SkillKey | null>(null);
    /** The skill a right-click menu is up for, and where. */
    const [menu, setMenu] = useState<(SkillKey & { x: number; y: number }) | null>(null);
    const [deleting, setDeleting] = useState<SkillKey | null>(null);
    const [query, setQuery] = useState('');
    const folders = useFolders(skills);
    const linkedCount = folders.filter((f) => !f.workspace).length;

    const libraryName = (which: SkillScope): string =>
        which === 'global' ? 'the global library' : `“${flowName}”`;
    const say = (text: string): void => setMessage({text, bad: false});
    const failed = (e: unknown): void => setMessage({text: (e as Error).message, bad: true});

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
    const moveWarnings = ({scope, name}: SkillKey): string[] => {
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

    const move = async ({scope, name}: SkillKey): Promise<void> => {
        const to = otherScope(scope);
        setMessage(null);
        try {
            await window.api.skills.move(scope, to, flowId, name);
            void onRefresh();
            onMoved(scope, to, name);
            say(`Moved “${name}” to ${libraryName(to)}.`);
        } catch (e) {
            failed(e);
        }
    };

    const drop = (skill: SkillKey): void => {
        setDropOn(null);
        setDragging(null);
        if (moveWarnings(skill).length > 0) setConfirming(skill);
        else void move(skill);
    };

    /**
     * Open its SKILL.md in the system's app for it, or show its folder. One gone
     * since the list was read is refused by name, and the list catches up.
     */
    const handOff = async (how: 'open' | 'reveal', {scope, name}: SkillKey): Promise<void> => {
        setMessage(null);
        try {
            await window.api.skills[how](scope, flowId, name);
        } catch (e) {
            failed(e);
            void onRefresh();
        }
    };

    /** Written from the template, ticked on the node it was made from, then opened to be filled in. */
    const create = async (scope: SkillScope, name: string): Promise<void> => {
        const clean = name.toLowerCase();
        setNaming(null);
        setMessage(null);
        try {
            await window.api.skills.create(scope, flowId, clean, TEMPLATE(clean));
        } catch (e) {
            failed(e);
            return;
        }
        // Ticked once listed, so it never shows as a tick with no skill behind it.
        await onRefresh();
        toggle(skillRef(scope, clean), true);
        say(`Created “${clean}” from a template and opened it. Save it there, and this list follows.`);
        try {
            await window.api.skills.open(scope, flowId, clean);
        } catch (e) {
            failed(e);
        }
    };

    const remove = async ({scope, name}: SkillKey): Promise<void> => {
        setMessage(null);
        try {
            await window.api.skills.remove(scope, flowId, name);
            say(`Deleted “${name}”.`);
        } catch (e) {
            failed(e);
        }
        void onRefresh();
    };

    const deleteQuestion = ({scope, name}: SkillKey): string => {
        if (scope === 'flow') return `Delete
        “
        ${name}
        ” from
        “
        ${flowName}
        ”? Its whole folder goes with it.`;
        const kept = whereKept(folders, name);
        return `Delete
        “
        ${name}
        ” from the global library? Every flow that ticks it loses it
        ${kept ? `, and its folder is deleted from ${kept}` : ''}
        .`;
    };

    const menuItems = (skill: SkillKey): MenuItem[] => [
        {label: 'Edit SKILL.md', onSelect: () => void handOff('open', skill)},
        {label: 'Show in folder', onSelect: () => void handOff('reveal', skill)},
        {label: 'Delete…', separator: true, danger: true, onSelect: () => setDeleting(skill)},
    ];

    const importSkills = async (scope: SkillScope): Promise<void> => {
        setMessage(null);
        try {
            const result = await window.api.skills.pickAndImport(scope, flowId);
            if (result) {
                void onRefresh();
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
                                    : `Only “${flowName}” sees these. They live in its folder and go wherever it does.`
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
                                        setDragging({scope, name: skill.name});
                                    }}
                                    onDragEnd={() => {
                                        setDragging(null);
                                        setDropOn(null);
                                    }}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        setMenu({scope, name: skill.name, x: e.clientX, y: e.clientY});
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
                                        title="Open its SKILL.md in the app your system opens .md files with. Right-click for more."
                                        onClick={() => void handOff('open', {scope, name: skill.name})}
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
                    onConfirm={(name) => void create(naming, name)}
                />
            )}

            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    label={menu.name}
                    items={menuItems(menu)}
                    onClose={() => setMenu(null)}
                />
            )}

            {deleting && (
                <ConfirmDialog
                    title="Delete skill"
                    message={deleteQuestion(deleting)}
                    confirmLabel="Delete"
                    onCancel={() => setDeleting(null)}
                    onConfirm={() => {
                        void remove(deleting);
                        setDeleting(null);
                    }}
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
