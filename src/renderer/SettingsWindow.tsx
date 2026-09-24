import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { AboutInfo, AgentControlStatus, Settings } from '@shared/settings';
import { SettingsPanel } from './components/SettingsPanel';
import { WindowControls } from './components/WindowControls';
import { useErrorBanner } from './errorBanner';
import { useTheme } from './theme';

/** The settings window: install-wide settings, raised from any other window. */
export function SettingsWindow(): JSX.Element {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [about, setAbout] = useState<AboutInfo | null>(null);
    /** The app's own MCP server, so the panel can show whether it is listening. */
    const [agentControl, setAgentControl] = useState<AgentControlStatus | null>(null);
    const { error, attempt } = useErrorBanner();
    // Nothing here switches the theme, but a switch made in another window has to
    // reach this one, and the hook is what listens for it.
    useTheme();

    useEffect(() => {
        void window.api.settings.get().then(setSettings);
        void window.api.about().then(setAbout);
        void window.api.agentControl.status().then(setAgentControl);
    }, []);

    useEffect(() => window.api.on.agentControl(setAgentControl), []);

    return (
        <div className="app">
            <div className="topbar">
                <span className="window-title">Settings</span>
                <span className="spacer"/>
                <WindowControls maximize={false}/>
            </div>

            {error && <div className="err-banner inset">{error}</div>}

            {settings ? (
                <SettingsPanel
                    settings={settings}
                    about={about}
                    agentControl={agentControl}
                    onSave={(next) => void attempt(async () => setSettings(await window.api.settings.save(next)))}
                    onRegenerateToken={() =>
                        void attempt(async () => setAgentControl(await window.api.agentControl.regenerateToken()))
                    }
                />
            ) : (
                <div className="empty loading">Loading…</div>
            )}
        </div>
    );
}
