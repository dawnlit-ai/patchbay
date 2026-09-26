import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { NameDialog } from './NameDialog';
import { type GlobalSkillFolder, SKILL_SCOPES, type SkillScope, type SkillSummary, } from '@shared/settings';

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

interface Props {
    /** The open flow, whose own library is one of the two on offer here. */
    flowId: string;
    flowName: string;
    /** Both libraries; each entry says which it came from. */
    skills: SkillSummary[];
    /** How many other flows a skill leaving the global library would abandon. */
    otherFlowCount: number;

    onRefresh(): void;

    /** A skill changed library: the open flow's ticks for it need re-pointing. */
    onMoved(from: SkillScope, to: SkillScope, name: string): void;
}

export function SkillLibrary({
                                 flowId,
                                 flowName,
                                 skills,
                                 otherFlowCount,
                                 onRefresh,
                                 onMoved,
                             }: Props): JSX.Element {
    /** Which library the panel is showing, and everything on it acts on. */
    const [scope, setScope] = useState<SkillScope>('global');
    const [editing, setEditing] = useState<string | null>(null);
    const [content, setContent] = useState('');
    /** One slot for both outcomes; `bad` is the difference between them. */
    const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
    const [busy, setBusy] = useState(false);
    const [naming, setNaming] = useState(false);
    /** Which skill the delete question is about, if it is on screen. */
    const [deleting, setDeleting] = useState<string | null>(null);
    /** The library a dragged skill is hovering over, so the tab can say so. */
    const [dropOn, setDropOn] = useState<SkillScope | null>(null);
    /** A move worth asking about first: it overwrites, or it abandons other flows. */
    const [confirming, setConfirming] = useState<string | null>(null);
    /** The global library's folders, highest first, so the tab can say where a skill lives. */
    const [folders, setFolders] = useState<GlobalSkillFolder[]>([]);

    const shown = skills.filter((s) => s.scope === scope);
    const other: SkillScope = scope === 'global' ? 'flow' : 'global';
    const libraryName = (which: SkillScope): string =>
        which === 'global' ? 'the global library' : `“${flowName}”`;

    // Re-read with the list, which is what refreshes when another window or an agent changes them.
    useEffect(() => {
        void window.api.skills.folders().then(setFolders);
    }, [skills]);

    /** The linked folder a global skill is kept in, or null when it is in the workspace. */
    const whereKept = (name: string): string | null => {
        const folder = folders.find((f) => f.skills.some((s) => s.name === name && !s.shadowed));
        return folder && !folder.workspace ? folder.path : null;
    };
    const linkedCount = folders.filter((f) => !f.workspace).length;

    useEffect(() => {
        if (!editing) return;
        void window.api.skills.get(scope, flowId, editing).then((detail) => {
            if (detail) setContent(detail.content);
        });
    }, [editing, flowId, scope]);

    const say = (text: string): void => setMessage({ text, bad: false });
    const failed = (e: unknown): void => setMessage({ text: (e as Error).message, bad: true });

    /** Leaving a library closes what was open in it: the name means something else there. */
    const switchScope = (next: SkillScope): void => {
        setScope(next);
        setEditing(null);
        setMessage(null);
    };

    const save = async (): Promise<void> => {
        if (!editing) return;
        setBusy(true);
        setMessage(null);
        try {
            await window.api.skills.save(scope, flowId, editing, content);
            onRefresh();
            setEditing(null);
        } catch (e) {
            failed(e);
        } finally {
            setBusy(false);
        }
    };

    /** Whether dropping `name` on the other library needs a question first. */
    const moveWarnings = (name: string): string[] => {
        const warnings: string[] = [];
        if (skills.some((s) => s.scope === other && s.name === name)) {
            warnings.push(`${libraryName(other)} already has a “${name}”, and this one replaces it.`);
        }
        if (scope === 'global' && otherFlowCount > 0) {
            warnings.push(
                `It leaves the global shelf, so the ${otherFlowCount} other flow${otherFlowCount === 1 ? '' : 's'} can no longer tick it. This flow’s own ticks are re-pointed for you.`,
            );
        }
        const kept = scope === 'global' ? whereKept(name) : null;
        if (kept) warnings.push(`Its folder is taken out of ${kept}.`);
        return warnings;
    };

    const move = async (name: string): Promise<void> => {
        setMessage(null);
        try {
            await window.api.skills.move(scope, other, flowId, name);
            onRefresh();
            onMoved(scope, other, name);
            say(`Moved “${name}” to ${libraryName(other)}.`);
        } catch (e) {
            failed(e);
        }
    };

    /** A drop lands on the library the panel is not showing; the rest is asking. */
    const drop = (name: string): void => {
        setDropOn(null);
        if (!name || !shown.some((s) => s.name === name)) return;
        if (moveWarnings(name).length > 0) setConfirming(name);
        else void move(name);
    };

    const create = (name: string): void => {
        const clean = name.toLowerCase();
        setNaming(false);
        setEditing(clean);
        setContent(TEMPLATE(clean));
    };

    const importSkills = async (): Promise<void> => {
        setMessage(null);
        try {
            const result = await window.api.skills.pickAndImport(scope, flowId);
            if (result) {
                onRefresh();
                say(
                    result.imported.length > 0
                        ? `Imported ${result.imported.length}: ${result.imported.join(', ')}`
                        : 'No folders containing a SKILL.md were found there.',
                );
            }
        } catch (e) {
            failed(e);
        }
    };

    if (editing) {
        return (
            <div>
                <div className="panel-head plain">
                    <strong>{editing}</strong>
                    <span className="spacer"/>
                    <button onClick={() => setEditing(null)}>Cancel</button>
                    <button className="primary" onClick={() => void save()} disabled={busy}>
                        Save
                    </button>
                </div>
                {message && <div className={message.bad ? 'err-banner' : 'notice'}>{message.text}</div>}
                <textarea
                    rows={26}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    spellCheck={false}
                />
                <div className="hint">
                    {scope === 'global' && whereKept(editing) ? (
                        <>
                            Saved as <code>{editing}/SKILL.md</code> in <code>{whereKept(editing)}</code>, and
                            offered to every flow.
                        </>
                    ) : scope === 'global' ? (
                        <>
                            Saved as <code>global/skills/{editing}/SKILL.md</code> in the app workspace, and
                            offered to every flow.
                        </>
                    ) : (
                        <>
                            Saved as <code>.claude/skills/{editing}/SKILL.md</code> inside this flow’s own
                            folder, where only its Processors can reach it.
                        </>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div>
            <div className="panel-head plain">
                <strong>Skills</strong>
                <span className="spacer"/>
                <button onClick={() => void importSkills()}>Import…</button>
                {scope === 'global' && (
                    <button
                        onClick={() => void window.api.window.showSettings()}
                        title="Link folders of skills into the global library, in Settings → Global skills"
                    >
                        Folders…
                    </button>
                )}
                <button className="primary" onClick={() => setNaming(true)}>
                    New
                </button>
            </div>

            <div className="scope-switch">
                {SKILL_SCOPES.map((which) => (
                    <button
                        key={which}
                        className={`${scope === which ? 'active' : ''}${dropOn === which ? ' drop-on' : ''}`}
                        title={
                            which === 'global'
                                ? 'Shared by every flow in this install'
                                : `Only “${flowName}” can use these`
                        }
                        onClick={() => switchScope(which)}
                        // The library on show is where a dragged skill came from, so only
                        // the other tab accepts it.
                        onDragOver={(e) => {
                            if (which === scope || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            setDropOn(which);
                        }}
                        onDragLeave={() => setDropOn((current) => (current === which ? null : current))}
                        onDrop={(e) => {
                            if (which === scope) return;
                            e.preventDefault();
                            drop(e.dataTransfer.getData(DRAG_TYPE));
                        }}
                    >
                        {which === 'global' ? 'Global' : 'This flow'}
                    </button>
                ))}
            </div>

            {naming && (
                <NameDialog
                    title={scope === 'global' ? 'New global skill' : 'New skill for this flow'}
                    label="Skill name"
                    initial="my-skill"
                    confirmLabel="Create"
                    hint="Lowercase and hyphens — it becomes the folder name Claude discovers."
                    onCancel={() => setNaming(false)}
                    onConfirm={create}
                />
            )}

            {deleting && (
                <ConfirmDialog
                    title="Delete skill"
                    message={
                        scope === 'global'
                            ? `Delete “${deleting}” from the global library? Every flow that ticks it loses it${whereKept(deleting) ? `, and its folder is deleted from ${whereKept(deleting)}` : ''}.`
                            : `Delete “${deleting}” from “${flowName}”? Its whole folder goes with it.`
                    }
                    confirmLabel="Delete"
                    onCancel={() => setDeleting(null)}
                    onConfirm={() => {
                        void window.api.skills.remove(scope, flowId, deleting).then(onRefresh);
                        setDeleting(null);
                    }}
                />
            )}

            {confirming && (
                <ConfirmDialog
                    title="Move skill"
                    message={`Move “${confirming}” to ${libraryName(other)}? ${moveWarnings(confirming).join(' ')}`}
                    confirmLabel="Move"
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => {
                        void move(confirming);
                        setConfirming(null);
                    }}
                />
            )}

            {message && <div className={message.bad ? 'err-banner' : 'notice'}>{message.text}</div>}

            <div className="hint block">
                {scope === 'global' && linkedCount > 0
                    ? `The shared shelf, including ${linkedCount} linked folder${linkedCount === 1 ? '' : 's'} read in place: editing or deleting a skill from one changes it there, and what changes there shows up here. New skills are saved in the app workspace.`
                    : scope === 'global'
                        ? 'The shared shelf: any flow can tick these, and editing one changes it everywhere.'
                        : `Kept inside this flow’s own folder: only “${flowName}” sees them, and they travel with it when you export.`}
                {' '}
                Drag a skill onto the other tab to move it there.
            </div>

            {shown.length === 0 && (
                <div className="empty">
                    {scope === 'global'
                        ? 'No global skills yet. Create one, import a folder of existing Claude Code skills, or link a folder of them under Folders….'
                        : 'Nothing specific to this flow. Create one here when a skill should not follow every other flow.'}
                </div>
            )}

            {shown.map((skill) => (
                <div
                    key={skill.name}
                    className="list-row"
                    draggable
                    onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_TYPE, skill.name);
                        e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDropOn(null)}
                    onClick={() => setEditing(skill.name)}
                >
                    <div className="grow">
                        <strong>{skill.name}</strong>
                        <div className="desc">{skill.description || 'No description'}</div>
                    </div>
                    <button
                        className="danger"
                        onClick={(e) => {
                            e.stopPropagation();
                            setDeleting(skill.name);
                        }}
                    >
                        ✕
                    </button>
                </div>
            ))}
        </div>
    );
}
