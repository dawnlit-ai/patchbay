import { createAgents } from './agents';
import { log } from './log';
import { getSettings } from './store/settingsStore';

/** The agents as this app hosts them: the `claude` binary from Settings, warnings into the app's log. */
export const agents = createAgents({
    claudeExecutable: () => getSettings().claudeExecutablePath.trim() || undefined,
    warn: (message, detail) => log.warn('run', message, { detail }),
});
