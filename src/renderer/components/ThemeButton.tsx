import type { JSX } from 'react';
import { useTheme } from '../theme';

/** Switches every window between light and dark, and follows a switch made in another. */
export function ThemeButton(): JSX.Element {
    const [theme, setTheme] = useTheme();
    const light = theme === 'light';
    return (
        <button
            className="ghost"
            title={light ? 'Switch to dark' : 'Switch to light'}
            onClick={() => setTheme(light ? 'dark' : 'light')}
        >
            {light ? '◐ Dark' : '◑ Light'}
        </button>
    );
}
