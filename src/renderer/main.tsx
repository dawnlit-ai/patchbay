import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@xyflow/react/dist/style.css';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('No #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
