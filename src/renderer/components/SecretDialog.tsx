import type { JSX } from 'react';
import { useState } from 'react';
import type { McpVariable } from '@shared/settings';
import { Modal } from './Modal';

/**
 * Asks for a value a workspace server looks up — a token, usually — in a field
 * that shows dots, since a window gets screen-shared. What is typed goes to main
 * once and is never shown again: a set value can be replaced or cleared, not read.
 */

interface Props {
    server: string;
    variable: McpVariable;

    onCancel(): void;

    onSave(value: string): void;
}

export function SecretDialog({server, variable, onCancel, onSave}: Props): JSX.Element {
    const [value, setValue] = useState('');
    const submit = (): void => {
        if (value) onSave(value);
    };

    return (
        <Modal
            title={`${variable.source === 'set' ? 'Change' : 'Set'} ${variable.name} for ${server}`}
            onClose={onCancel}
            footer={
                <>
                    <button onClick={onCancel}>Cancel</button>
                    <button className="primary" disabled={!value} onClick={submit}>
                        Save
                    </button>
                </>
            }
        >
            <label className="field">
                <span>{variable.description ?? variable.name}</span>
                <input
                    type="password"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') submit();
                    }}
                />
                <div className="hint">
                    Kept encrypted on this computer, for {server} in this workspace alone, and handed to it each time
                    it starts. It comes before Patchbay’s environment and the definition’s own default. It is not
                    written into the workspace, and Patchbay does not show it again.
                </div>
            </label>
        </Modal>
    );
}
