import type { JSX } from 'react';
import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { NameDialog } from './NameDialog';
import { PickFilter, PickGroup } from './PickGroup';
import type { SkillSummary } from '@shared/settings';

/** A new skill's SKILL.md, to be filled in. */
export const skillTemplate = (name: string): string => `---
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

/** The open workspace's library, and what the list does to it. */
export interface Library {
    /** What the workspace is called, for saying where a skill lives. */
    workspaceName: string;
    skills: SkillSummary[];

    /** Re-read the library; settles once the list holds what is on disk. */
    onRefresh(): Promise<void>;
}

interface ShelfProps {
    library: Library;
    /** The selected node's ticks. Without them the list only keeps the library. */
    picked?: string[];

    onPick?(names: string[]): void;
}

/**
 * The workspace's skills: where a node ticks its own, and where they are
 * created, imported and deleted. Editing happens in the system's app for `.md`
 * files; the list follows the folder.
 */
export function SkillShelf({library, picked, onPick}: ShelfProps): JSX.Element {
    const {workspaceName, skills, onRefresh} = library;
    /** One slot for both outcomes; `bad` is the difference between them. */
    const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
    /** While the New dialog is up. */
    const [naming, setNaming] = useState(false);
    /** The skill a right-click menu is up for, and where. */
    const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);
    const [query, setQuery] = useState('');

    const say = (text: string): void => setMessage({text, bad: false});
    const failed = (e: unknown): void => setMessage({text: (e as Error).message, bad: true});

    const toggle = (name: string, on: boolean): void => {
        if (!picked || !onPick) return;
        onPick(on ? [...picked, name] : picked.filter((s) => s !== name));
    };

    const isTicked = picked && ((skill: SkillSummary): boolean => picked.includes(skill.name));
    const skillText = (skill: SkillSummary): string => `${skill.name} ${skill.description}`;

    // Ticked but not in the library (deleted or renamed since, or a flow imported
    // from elsewhere). There is no skill to show it by, so it is listed on its own to be unticked.
    const offered = new Set(skills.map((skill) => skill.name));
    const missing = picked?.filter((name) => !offered.has(name)) ?? [];

    /**
     * Open its SKILL.md in the system's app for it, or show its folder. One gone
     * since the list was read is refused by name, and the list catches up.
     */
    const handOff = async (how: 'open' | 'reveal', name: string): Promise<void> => {
        setMessage(null);
        try {
            await window.api.skills[how](name);
        } catch (e) {
            failed(e);
            void onRefresh();
        }
    };

    /** Written from the template, ticked on the node it was made from, then opened to be filled in. */
    const create = async (name: string): Promise<void> => {
        const clean = name.toLowerCase();
        setNaming(false);
        setMessage(null);
        try {
            await window.api.skills.create(clean, skillTemplate(clean));
        } catch (e) {
            failed(e);
            return;
        }
        // Ticked once listed, so it never shows as a tick with no skill behind it.
        await onRefresh();
        toggle(clean, true);
        say(`Created “${clean}” from a template and opened it. Save it there, and this list follows.`);
        try {
            await window.api.skills.open(clean);
        } catch (e) {
            failed(e);
        }
    };

    const remove = async (name: string): Promise<void> => {
        setMessage(null);
        try {
            await window.api.skills.remove(name);
            say(`Deleted “${name}”.`);
        } catch (e) {
            failed(e);
        }
        void onRefresh();
    };

    const menuItems = (name: string): MenuItem[] => [
        {label: 'Edit SKILL.md', onSelect: () => void handOff('open', name)},
        {label: 'Show in folder', onSelect: () => void handOff('reveal', name)},
        {label: 'Delete…', separator: true, danger: true, onSelect: () => setDeleting(name)},
    ];

    const importSkills = async (): Promise<void> => {
        setMessage(null);
        try {
            const result = await window.api.skills.pickAndImport();
            if (result) {
                void onRefresh();
                const said =
                    result.imported.length > 0
                        ? `Imported ${result.imported.length}: ${result.imported.join(', ')}.`
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

            <PickGroup
                title={workspaceName}
                items={skills}
                isTicked={isTicked}
                query={query}
                text={skillText}
                tip={`Kept in “${workspaceName}”’s skills folder and shared by every flow in it: editing one changes it for all of them.`}
                empty="None yet. Write one, or import SKILL.md files."
                actions={
                    <>
                        <button className="ghost compact" onClick={() => void importSkills()}>
                            Import…
                        </button>
                        <button className="ghost compact" onClick={() => setNaming(true)}>
                            New
                        </button>
                    </>
                }
                row={(skill) => (
                    <div
                        key={skill.name}
                        className="pick-row"
                        title={skill.description || undefined}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            setMenu({name: skill.name, x: e.clientX, y: e.clientY});
                        }}
                    >
                        {picked ? (
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={picked.includes(skill.name)}
                                    onChange={(e) => toggle(skill.name, e.target.checked)}
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
                            onClick={() => void handOff('open', skill.name)}
                        >
                            Edit
                        </button>
                    </div>
                )}
            />

            {missing.length > 0 && (
                <PickGroup
                    title="Not in this workspace"
                    items={missing}
                    isTicked={() => true}
                    query=""
                    text={(name) => name}
                    row={(name) => (
                        <div key={name} className="pick-row">
                            <label className="check">
                                <input type="checkbox" checked onChange={() => toggle(name, false)}/>
                                {name}
                            </label>
                        </div>
                    )}
                />
            )}

            {naming && (
                <NameDialog
                    title="New skill"
                    label="Skill name"
                    initial="my-skill"
                    confirmLabel="Create"
                    hint="Lowercase and hyphens — it becomes the folder name Claude discovers."
                    onCancel={() => setNaming(false)}
                    onConfirm={(name) => void create(name)}
                />
            )}

            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    label={menu.name}
                    items={menuItems(menu.name)}
                    onClose={() => setMenu(null)}
                />
            )}

            {deleting && (
                <ConfirmDialog
                    title="Delete skill"
                    message={
                        `Delete “${deleting}” ` +
                        `from “${workspaceName}”? Its whole folder goes with it, ` +
                        'and every flow here that ticks it loses it.'
                    }
                    confirmLabel="Delete"
                    onCancel={() => setDeleting(null)}
                    onConfirm={() => {
                        void remove(deleting);
                        setDeleting(null);
                    }}
                />
            )}
        </>
    );
}
