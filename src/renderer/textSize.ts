import { useCallback, useState } from 'react';

/**
 * How large every window's text is, chosen once per machine and kept beside the
 * theme: every window is one origin, so all read the same key, and each can apply
 * it before React renders rather than a frame late.
 */

export const TEXT_SIZES = [90, 100, 110, 120, 130] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

const KEY = 'patchbay.textSize';

/** 100% unless the user has chosen otherwise, or a size this build no longer offers. */
export function readTextSize(): TextSize {
    try {
        const stored = Number(localStorage.getItem(KEY));
        return TEXT_SIZES.find((size) => size === stored) ?? 100;
    } catch {
        return 100;
    }
}

/** Every font size in the stylesheet is multiplied by this; the rest of the layout keeps its size. */
export function applyTextSize(size: TextSize): void {
    document.documentElement.style.setProperty('--text-scale', String(size / 100));
}

/**
 * Follow a change made in another window; `storage` fires everywhere but the
 * writer. Set up once per window, whatever it shows, since every window has text.
 */
export function followTextSize(): void {
    window.addEventListener('storage', (event) => {
        if (event.key === null || event.key === KEY) applyTextSize(readTextSize());
    });
}

/**
 * The current size and the one call that changes it, stores it and applies it.
 * Only the settings window changes it, and there is only ever one of those.
 */
export function useTextSize(): [TextSize, (next: TextSize) => void] {
    const [size, setState] = useState<TextSize>(readTextSize);
    const set = useCallback((next: TextSize) => {
        applyTextSize(next);
        setState(next);
        try {
            localStorage.setItem(KEY, String(next));
        } catch {
            // A machine that refuses storage still shows the size for this session.
        }
    }, []);
    return [size, set];
}
