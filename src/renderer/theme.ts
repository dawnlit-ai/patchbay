import { useCallback, useEffect, useState } from 'react';

/**
 * Light or dark, chosen once per machine and shared by both windows — they are
 * one origin, so the welcome window and the canvas read the same key.
 */

export type Theme = 'light' | 'dark';

const KEY = 'patchbay.theme';

/** Light unless the user has chosen otherwise; the choice is per machine. */
export function readTheme(): Theme {
    try {
        return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
    } catch {
        return 'light';
    }
}

/**
 * The stylesheet keys every colour off this attribute, so setting it is the whole
 * of switching themes. Done before React renders rather than in an effect: the
 * canvas reads the same tokens as it draws, and an effect would leave it a frame
 * behind.
 */
export function applyTheme(theme: Theme): void {
    document.documentElement.dataset.theme = theme;
}

/** The current theme and the one call that changes it, stores it and applies it. */
export function useTheme(): [Theme, (next: Theme) => void] {
    const [theme, setState] = useState<Theme>(readTheme);
    const set = useCallback((next: Theme) => {
        applyTheme(next);
        setState(next);
        try {
            localStorage.setItem(KEY, next);
        } catch {
            // A machine that refuses storage still themes correctly for this session.
        }
    }, []);

    // Both windows are one origin, so the choice made in either reaches the other
    // while both are open: the browser fires this in every document but the one
    // that wrote the key.
    useEffect(() => {
        const onStorage = (event: StorageEvent): void => {
            if (event.key !== null && event.key !== KEY) return;
            const next = readTheme();
            applyTheme(next);
            setState(next);
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    return [theme, set];
}
