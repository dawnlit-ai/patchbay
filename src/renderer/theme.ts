import { useCallback, useEffect, useState } from 'react';

/** Light or dark, chosen once per machine: every window is one origin, so all read the same key. */

export type Theme = 'light' | 'dark';

const KEY = 'patchbay.theme';

/** Light unless the user has chosen otherwise. */
export function readTheme(): Theme {
    try {
        return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
    } catch {
        return 'light';
    }
}

/**
 * Every colour keys off this attribute. Called before React renders, not in an
 * effect, which would leave the canvas a frame behind.
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

    // Follow a change made in another window; `storage` fires everywhere but the writer.
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
