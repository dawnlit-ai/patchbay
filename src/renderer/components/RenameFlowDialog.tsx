import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { toFolderName } from '@shared/naming';
import { Modal } from './Modal';

/**
 * Rename a flow, and optionally its file. Renaming the file is offered ticked
 * only while it still has the name the app chose.
 */

export interface RenameResult {
    name: string;
    /** The file name to move to, without `.json`, or null to leave it as it is. */
    fileName: string | null;
}

/** A flow file's name without its folder or `.json`. */
export const fileStem = (file: string): string => (file.split(/[\\/]/).pop() ?? file).replace(/\.json$/i, '');

interface Props {
    name: string;
    /** The flow's file, shown so what is being renamed is on screen. */
    file: string;

    onCancel(): void;

    onConfirm(result: RenameResult): void;
}

export function RenameFlowDialog({name, file, onCancel, onConfirm}: Props): JSX.Element {
    const current = fileStem(file);
    const [value, setValue] = useState(name);
    // Ticked when the file is still what the name gave it. A file someone has
    // since renamed by hand is one they chose, so it is left alone by default.
    const [renameFile, setRenameFile] = useState(current === toFolderName(name));
    const [fileValue, setFileValue] = useState(current);
    /** Until it is, the file field follows what is typed into the name. */
    const fileEdited = useRef(false);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        input.current?.select();
    }, []);

    const trimmed = value.trim();
    // What the store will actually call it, shown rather than sprung afterwards.
    const resolved = toFolderName(fileValue.trim() || trimmed);
    const moving = renameFile && resolved !== current;

    const submit = (): void => {
        if (trimmed) onConfirm({name: trimmed, fileName: renameFile ? resolved : null});
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
                        if (!fileEdited.current) setFileValue(toFolderName(e.target.value));
                    }}
                    onKeyDown={onEnter}
                />
            </label>

            <label className="check">
                <input type="checkbox" checked={renameFile} onChange={(e) => setRenameFile(e.target.checked)}/>
                <span>Rename the flow’s file to match</span>
            </label>

            {renameFile && (
                <label className="field">
                    <span>File name</span>
                    <input
                        value={fileValue}
                        onChange={(e) => {
                            fileEdited.current = true;
                            setFileValue(e.target.value);
                        }}
                        onKeyDown={onEnter}
                    />
                    <div className="hint">
                        {moving ? (
                            <>
                                Becomes <code>{resolved}.json</code>. Letters, numbers and dashes only — anything
                                else is folded into one. The flow keeps its runs and its place in the watcher;
                                only the file name changes.
                            </>
                        ) : (
                            <>Already called <code>{current}.json</code>, so nothing moves.</>
                        )}
                    </div>
                </label>
            )}

            <div className="hint block">
                <code>{file}</code>
            </div>
        </Modal>
    );
}
