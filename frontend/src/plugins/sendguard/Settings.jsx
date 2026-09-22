// Send guard settings (view 'aer.sendguard.settings').
import { SettingsForm } from '../runtimeLoader.js';
import { Card, T, Title, ViewFrame } from '../../hedwig/views/ui.jsx';
import { tr } from '../../hedwig/views/i18n.js';

export default function Settings() {
  return (
    <ViewFrame label={tr('plugins.sendguard.title', 'Send guard')}>
      <Title>{tr('plugins.sendguard.title', 'Send guard')}</Title>
      <p style={{ fontSize: 13, color: T.muted, maxWidth: 560 }}>
        {tr('plugins.sendguard.help', 'Checks every message just before it is sent. A rule set to warn lets the message go and tells you afterwards; set it to block to stop the send until you fix it.')}
      </p>
      <Card>
        <SettingsForm pluginId="aer.sendguard" />
      </Card>
    </ViewFrame>
  );
}
