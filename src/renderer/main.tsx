import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Welcome } from './Welcome';
import { applyTheme, readTheme } from './theme';
import '@xyflow/react/dist/style.css';
import './styles.css';

/**
 * One renderer build serves both windows. Which one this is arrives in the hash
 * main loaded it with — `#welcome`, or `#flow=<id>` for the canvas — so it is
 * known before the first render rather than a round trip later, and neither
 * window paints the other's layout first.
 */
const opened = /^#flow=(.+)$/.exec(location.hash);

const container = document.getElementById('root');
if (!container) throw new Error('No #root element');

applyTheme(readTheme());

createRoot(container).render(
    <StrictMode>
        {opened?.[1] ? <App initialFlowId={decodeURIComponent(opened[1])}/> : <Welcome/>}
    </StrictMode>,
);
