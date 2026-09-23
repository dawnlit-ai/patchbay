import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SettingsWindow } from './SettingsWindow';
import { Welcome } from './Welcome';
import { applyTheme, readTheme } from './theme';
import '@xyflow/react/dist/style.css';
import './styles.css';

/**
 * One renderer build serves every window. Which one this is arrives in the hash
 * main loaded it with — `#welcome`, `#settings`, or `#flow=<id>` for a canvas —
 * so it is known before the first render rather than a round trip later, and no
 * window paints another's layout first.
 */
const opened = /^#flow=(.+)$/.exec(location.hash);

const container = document.getElementById('root');
if (!container) throw new Error('No #root element');

applyTheme(readTheme());

createRoot(container).render(
    <StrictMode>
        {opened?.[1] ? (
            <App initialFlowId={decodeURIComponent(opened[1])}/>
        ) : location.hash === '#settings' ? (
            <SettingsWindow/>
        ) : (
            <Welcome/>
        )}
    </StrictMode>,
);
