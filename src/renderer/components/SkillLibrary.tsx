import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { SkillSummary } from '@shared/settings';

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

interface Props {
    skills: SkillSummary[];

    onRefresh(): void;
}

export function SkillLibrary({ skills, onRefresh }: Props): JSX.Element {
    const [editing, setEditing] = useState<string | null>(null);
    const [content, setContent] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!editing) return;
        void window.api.skills.get(editing).then((detail) => {
            if (detail) setContent(detail.content);
        });
    }, [editing]);

    const save = async (): Promise<void> => {
        if (!editing) return;
        setBusy(true);
        setError(null);
        try {
            await window.api.skills.save(editing, content);
            onRefresh();
            setEditing(null);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const create = (): void => {
        const name = window.prompt('Skill name (lowercase, hyphens):', 'my-skill');
        if (!name) return;
        const clean = name.trim().toLowerCase();
        setEditing(clean);
        setContent(TEMPLATE(clean));
    };

    const importSkills = async (): Promise<void> => {
        setError(null);
        try {
            const result = await window.api.skills.pickAndImport();
            if (result) {
                onRefresh();
                setError(
                    result.imported.length > 0
                        ? `Imported ${result.imported.length}: ${result.imported.join(', ')}`
                        : 'No folders containing a SKILL.md were found there.',
                );
            }
        } catch (e) {
            setError((e as Error).message);
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
                {error && <div className="err-banner">{error}</div>}
                <textarea
                    rows={26}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    spellCheck={false}
                />
                <div className="hint" style={{ marginTop: 6 }}>
                    Saved as <code>.claude/skills/{editing}/SKILL.md</code> in the app workspace, which is
                    where Claude discovers it.
                </div>
            </div>
        );
    }

    return (
        <div>
            <div className="panel-head plain">
                <strong>Skill library</strong>
                <span className="spacer"/>
                <button onClick={() => void importSkills()}>Import…</button>
                <button className="primary" onClick={create}>
                    New
                </button>
            </div>

            {error && <div className="err-banner">{error}</div>}

            {skills.length === 0 && (
                <div className="empty">
                    No skills yet. Create one, or import a folder of existing Claude Code skills.
                </div>
            )}

            {skills.map((skill) => (
                <div key={skill.name} className="list-row" onClick={() => setEditing(skill.name)}>
                    <div className="grow">
                        <strong>{skill.name}</strong>
                        <div className="desc">{skill.description || 'No description'}</div>
                    </div>
                    <button
                        className="danger"
                        onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`Delete skill "${skill.name}"?`)) {
                                void window.api.skills.remove(skill.name).then(onRefresh);
                            }
                        }}
                    >
                        ✕
                    </button>
                </div>
            ))}
        </div>
    );
}
