import type { JSX } from 'react';
import { useEffect, useState } from 'react';

/** Minimise, maximise and close, drawn by the app because the window is frameless. */

/** Drawn rather than typed: the glyph characters for these differ per font. */
const ICON = {
    minimize: 'M1 6.5 H11',
    maximize: 'M1.5 1.5 H10.5 V10.5 H1.5 Z',
    // The front pane, plus the top-right corner of the one behind it.
    restore: 'M1.5 3.5 H8.5 V10.5 H1.5 Z M3.5 3.5 V1.5 H10.5 V8.5 H8.5',
    close: 'M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5',
} as const;

function Glyph({d}: { d: string }): JSX.Element {
    return (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d={d} fill="none" stroke="currentColor" strokeWidth="1"/>
        </svg>
    );
}

interface Props {
    /** False where the window has a size of its own to keep — the welcome and settings windows. */
    maximize?: boolean;
}

export function WindowControls({maximize = true}: Props): JSX.Element {
    const [maximized, setMaximized] = useState(false);

    // The window can be maximised without these buttons (edge drag, Win+Up), so
    // main reports the state.
    useEffect(() => {
        void window.api.window.isMaximized().then(setMaximized);
        return window.api.on.windowMaximized(setMaximized);
    }, []);

    return (
        <div className="window-controls">
            <button title="Minimise" aria-label="Minimise" onClick={() => void window.api.window.minimize()}>
                <Glyph d={ICON.minimize}/>
            </button>
            {maximize && (
                <button
                    title={maximized ? 'Restore' : 'Maximise'}
                    aria-label={maximized ? 'Restore' : 'Maximise'}
                    onClick={() => void window.api.window.toggleMaximize()}
                >
                    <Glyph d={maximized ? ICON.restore : ICON.maximize}/>
                </button>
            )}
            <button className="close" title="Close" aria-label="Close" onClick={() => void window.api.window.close()}>
                <Glyph d={ICON.close}/>
            </button>
        </div>
    );
}
