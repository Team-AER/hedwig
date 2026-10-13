// hedwig.settings.mail — the mail settings (accounts, rules, appearance, security, the assistant…)
// as pages of the settings panel, instead of upstream's dialog. The page is the store's adminTab,
// so a link inside one that switches tab (setAdminTab) keeps working. The pages themselves are
// AdminPanel.jsx's, loaded the first time one opens.
import { lazy, Suspense } from 'react';
import { useStore } from '../../../store/index.js';
import SettingsFrame, { openSettingsPage } from './SettingsFrame.jsx';
import { Loading } from '../ui.jsx';
import { tv } from '../../v2/i18n.js';
import { MAIL_SETTINGS_VIEW, activeKey, pageFor } from '../../settingsTabs.js';

const AdminTabContent = lazy(() => import('../../../components/AdminPanel.jsx').then((m) => ({ default: m.AdminTabContent })));

export default function MailSettings({ props }) {
  const adminTab = useStore((s) => s.adminTab) || 'accounts';
  const page = pageFor(activeKey(MAIL_SETTINGS_VIEW, adminTab));
  const title = page ? tv(page.labelKey, page.label) : tv('admin.title', 'Settings');
  const navigate = (tab, subTab) => openSettingsPage(pageFor(`mail:${tab}`), { subTab: subTab || null });
  return (
    <SettingsFrame active={MAIL_SETTINGS_VIEW} title={title}>
      {/* admin-panel: the retro themes style these pages as they do the dialog (index.css). */}
      <div className="admin-panel" data-mail-settings={adminTab} style={{ maxWidth: 720, color: 'var(--text-primary)' }}>
        <Suspense fallback={<Loading label={tv('hedwig.v2.loading', 'Loading…')} />}>
          <AdminTabContent tab={adminTab} subTab={props?.subTab || null} onNavigate={navigate} />
        </Suspense>
      </div>
    </SettingsFrame>
  );
}
