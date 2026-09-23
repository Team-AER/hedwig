// Renders the registered view for a pane (or the overlay, a pop-out, a phone screen), with a
// quiet placeholder when the view is missing or its feature is off, and an error boundary so a
// failing view never takes the rest of the layout down with it.
import { Component } from 'react';
import { getView } from '../registry.js';
import { useHedwig } from '../store.js';
import { Icon } from '../icons.jsx';
import { ui } from '../theme/styles.js';
import { useShell } from './state.js';
import { useRegistryVersion } from './useRegistry.js';
import { viewMenuItems } from './viewMenu.js';
import { MenuButton } from './Menu.jsx';
import { tr } from './tr.js';

const FEATURE_LABELS = { triage: 'Triage', context: 'Context', insights: 'Insights', agent: 'Agent' };

class PaneBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`[hedwig] view ${this.props.viewId} failed:`, error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Notice icon="close" title={`${this.props.title} hit an error`}>
        <p style={{ margin: 0, fontFamily: 'var(--hw-font-mono)', fontSize: 12, color: 'var(--hw-muted)', wordBreak: 'break-word' }}>
          {this.state.error.message || String(this.state.error)}
        </p>
        <button type="button" className="hw-btn" style={ui.button} onClick={() => this.setState({ error: null })}>
          Reload view
        </button>
      </Notice>
    );
  }
}

function Notice({ icon, title, children }) {
  return (
    <div role="status" style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 12, padding: 24, textAlign: 'center', color: 'var(--hw-muted)', fontSize: 13, background: 'transparent',
    }}>
      <span style={{ color: 'var(--hw-faint)' }}><Icon name={icon} size={22} /></span>
      <div style={{ color: 'var(--hw-ink)', fontWeight: 500, maxWidth: 360 }}>{title}</div>
      {children}
    </div>
  );
}

function ChangeView({ currentId, onChangeView }) {
  if (!onChangeView) return null;
  return (
    <MenuButton label={tr('view.change', 'Change view')} items={() => viewMenuItems(currentId, onChangeView)} buttonStyle={ui.button}>
      <Icon name="grid" size={14} /> {tr('view.change', 'Change view')}
    </MenuButton>
  );
}

export function ViewHost({ paneKey, viewId, props, follows, onChangeView }) {
  useRegistryVersion();
  const settled = useShell((s) => s.pluginsSettled);
  const status = useHedwig((s) => s.status);
  const view = getView(viewId);

  let body;
  if (!view) {
    // Plugin bundles register their views after first paint; stay blank until they have had
    // their chance rather than flashing "not available".
    body = settled
      ? (
        <Notice icon="plugin" title={<><code style={{ fontFamily: 'var(--hw-font-mono)', fontSize: 12 }}>{viewId}</code> {tr('view.unavailable', 'is not available — the plugin or feature may be off')}</>}>
          <ChangeView currentId={viewId} onChangeView={onChangeView} />
        </Notice>
      )
      : <div aria-busy="true" style={{ flex: 1 }} />;
  } else if (view.requires && status && !(status.ready && status.enabled && status.features?.[view.requires])) {
    const feature = FEATURE_LABELS[view.requires] || view.requires;
    const why = status.error ? 'Hedwig failed to start (an admin can see why under Models and pipeline)'
      : !status.ready ? 'Hedwig is still starting up'
        : !status.enabled ? 'Hedwig is turned off'
          : `${feature} is turned off`;
    body = (
      <Notice icon="spark" title={`${view.title || viewId} is unavailable — ${why}.`}>
        <ChangeView currentId={viewId} onChangeView={onChangeView} />
      </Notice>
    );
  } else {
    const ViewComponent = view.component;
    body = (
      <PaneBoundary key={viewId} viewId={viewId} title={view.title || viewId}>
        <ViewComponent paneId={paneKey} props={props || EMPTY} follows={follows} />
      </PaneBoundary>
    );
  }

  return (
    <div className="hw-view-host" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {body}
    </div>
  );
}

const EMPTY = Object.freeze({});
