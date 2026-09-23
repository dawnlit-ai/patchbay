import type { JSX } from 'react';

/**
 * The gear in a window's top bar, which raises the settings window. An icon
 * rather than a word: it sits beside the window's own buttons, and a gear is
 * what that corner is read for.
 */

/**
 * Eight teeth round a hub. Drawn, like the window buttons, so that no font gets
 * to decide what it looks like.
 */
const GEAR =
    'M6.74 2.95 L6.89 0.99 L9.11 0.99 L9.26 2.95 A5.2 5.2 0 0 1 10.68 3.54 L12.17 2.26 L13.74 3.83 ' +
    'L12.46 5.32 A5.2 5.2 0 0 1 13.05 6.74 L15.01 6.89 L15.01 9.11 L13.05 9.26 A5.2 5.2 0 0 1 12.46 10.68 ' +
    'L13.74 12.17 L12.17 13.74 L10.68 12.46 A5.2 5.2 0 0 1 9.26 13.05 L9.11 15.01 L6.89 15.01 L6.74 13.05 ' +
    'A5.2 5.2 0 0 1 5.32 12.46 L3.83 13.74 L2.26 12.17 L3.54 10.68 A5.2 5.2 0 0 1 2.95 9.26 L0.99 9.11 ' +
    'L0.99 6.89 L2.95 6.74 A5.2 5.2 0 0 1 3.54 5.32 L2.26 3.83 L3.83 2.26 L5.32 3.54 A5.2 5.2 0 0 1 6.74 2.95 Z ' +
    'M10.2 8 A2.2 2.2 0 1 0 5.8 8 A2.2 2.2 0 1 0 10.2 8 Z';

export function SettingsButton(): JSX.Element {
    return (
        <button
            className="ghost icon"
            title="Settings"
            aria-label="Settings"
            onClick={() => void window.api.window.showSettings()}
        >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d={GEAR} fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
            </svg>
        </button>
    );
}
