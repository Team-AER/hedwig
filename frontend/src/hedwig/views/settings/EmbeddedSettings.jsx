// A Hedwig settings page inside the Settings dialog (AdminPanel). The pages are the same components
// the panes used; SettingsEmbedded drops their own tab bar and full-height scroller, since the
// dialog's sidebar and content area provide both.
import PersonalSettings from './PersonalSettings.jsx';
import TriageSettings from './TriageSettings.jsx';
import PluginSettings from './PluginSettings.jsx';
import RoutingSettings from './RoutingSettings.jsx';
import ModelSettings from './ModelSettings.jsx';
import { SettingsEmbedded } from './SettingsFrame.jsx';
import { settingsViewFor } from '../../settingsTabs.js';

const PAGES = {
  'hedwig.settings.personal': PersonalSettings,
  'hedwig.settings.triage': TriageSettings,
  'hedwig.settings.plugins': PluginSettings,
  'hedwig.settings.routing': RoutingSettings,
  'hedwig.settings.models': ModelSettings,
};

export default function EmbeddedSettings({ tabId }) {
  const Page = PAGES[settingsViewFor(tabId)];
  if (!Page) return null;
  return (
    <SettingsEmbedded.Provider value>
      <Page props={{}} />
    </SettingsEmbedded.Provider>
  );
}
