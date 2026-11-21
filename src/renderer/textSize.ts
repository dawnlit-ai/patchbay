import { useCallback, useState } from 'react';

/**
 * How large every window's text is, chosen once per machine and kept beside the
 * theme: every window is one origin, so all read the same key, and each can apply
 * it before React renders rather than a frame late.
 */

/** In steps of 20: one below 100, where smaller text starts to be hard to read, and three above. */
export const TEXT_SIZES = [80, 100, 120, 140, 160] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

const KEY = 'patchbay.textSize';

/** 100% unless the user has chosen otherwise. A size no longer offered, such as 110, reads as the nearest one that is. */
export function readTextSize(): TextSize {
    try {
        const stored = localStorage.getItem(KEY);
        const wanted = stored === null ? NaN : Number(stored);
        if (!Number.isFinite(wanted)) return 100;
        return TEXT_SIZES.reduce((best, size) => (Math.abs(size - wanted) < Math.abs(best - wanted) ? size : best));
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
