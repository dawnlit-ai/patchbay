import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { toFolderName } from '@shared/naming';
import { Modal } from './Modal';

/**
 * Renaming a flow asks a second question, because a flow is also a directory on
 * disk: should the folder follow the name? It usually should — a flow called
 * "Rate quotes" kept in `pre-alerts` is a workspace nobody can read — but the
 * folder is a path, and a path may be somewhere a person has already gone
 * looking. So it is offered, ticked only when the folder is still the one the
 * app chose, and never done behind their back.
 */

export interface RenameResult {
    name: string;
    /** The folder to move to, or null to leave it where it is. */
    folder: string | null;
}

interface Props {
    name: string;
    folder: string;
    /** Shown under the folder field, so what is being moved is on screen. */
    path: string;

    onCancel(): void;

    onConfirm(result: RenameResult): void;
}

export function RenameFlowDialog({ name, folder, path, onCancel, onConfirm }: Props): JSX.Element {
    const [value, setValue] = useState(name);
    // Ticked when the folder is still what the name gave it. A folder someone has
    // since renamed by hand is one they chose, so it is left alone by default.
    const [moveFolder, setMoveFolder] = useState(folder === toFolderName(name));
    const [folderValue, setFolderValue] = useState(folder);
    /** Until it is, the folder field follows what is typed into the name. */
    const folderEdited = useRef(false);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        input.current?.select();
    }, []);

    const trimmed = value.trim();
    // What the store will actually call it, shown rather than sprung afterwards.
    const resolved = toFolderName(folderValue.trim() || trimmed);
    const moving = moveFolder && resolved !== folder;

    const submit = (): void => {
        if (trimmed) onConfirm({ name: trimmed, folder: moveFolder ? resolved : null });
    };

    const onEnter = (e: { key: string }): void => {
        if (e.key === 'Enter') submit();
    };

    return (
        <Modal
            title="Rename flow"
            onClose={onCancel}
            footer={
                <>
                    <button onClick={onCancel}>Cancel</button>
                    <button className="primary" disabled={!trimmed} onClick={submit}>
                        Rename
                    </button>
                </>
            }
        >
            <label className="field">
                <span>Flow name</span>
                <input
                    ref={input}
                    value={value}
                    onChange={(e) => {
                        setValue(e.target.value);
                        if (!folderEdited.current) setFolderValue(toFolderName(e.target.value));
                    }}
                    onKeyDown={onEnter}
                />
            </label>

            <label className="check">
                <input
                    type="checkbox"
                    checked={moveFolder}
                    onChange={(e) => setMoveFolder(e.target.checked)}
                />
                <span>Rename the project folder to match</span>
            </label>

            {moveFolder && (
                <label className="field">
                    <span>Folder name</span>
                    <input
                        value={folderValue}
                        onChange={(e) => {
                            folderEdited.current = true;
                            setFolderValue(e.target.value);
                        }}
                        onKeyDown={onEnter}
                    />
                    <div className="hint">
                        {moving ? (
                            <>
                                Moves to <code>{resolved}</code>. Letters, numbers and dashes only — anything
                                else is folded into one. The flow keeps its runs and its place in the watcher;
                                only the path changes.
                            </>
                        ) : (
                            <>Already called <code>{folder}</code>, so nothing moves.</>
                        )}
                    </div>
                </label>
            )}

            <div className="hint block">
                <code>{path}</code>
            </div>
        </Modal>
    );
}
