// Hello Hedwig — frontend bundle. A plain ES module the host imports after the user activates the
// plugin. It receives the host API as window.hedwig and never imports anything itself:
//   { React, h, registerView, registerCommand, registerSlot, api, stream, useHedwig, tokens, pluginId }
const { React, h, registerView, registerCommand, api, useHedwig, tokens, pluginId } = window.hedwig;

function HelloPanel() {
  const [state, setState] = React.useState({ loading: true });
  const load = React.useCallback(() => {
    setState({ loading: true });
    api.get(`/p/${pluginId}/hello`)
      .then((data) => setState({ data }))
      .catch((err) => setState({ error: err.message }));
  }, []);
  React.useEffect(load, [load]);

  return h('section', { style: { padding: 16, color: `var(${tokens.ink})`, fontFamily: `var(${tokens.fontBody})` } },
    h('h2', { style: { fontFamily: `var(${tokens.fontDisplay})`, fontSize: 18, margin: '0 0 8px' } }, 'Hello Hedwig'),
    state.loading && h('p', { style: { color: `var(${tokens.muted})` } }, 'Loading…'),
    state.error && h('p', { role: 'alert', style: { color: `var(${tokens.red})` } }, state.error),
    state.data && h('p', null, state.data.message),
    h('button', { type: 'button', onClick: load, style: { marginTop: 8 } }, 'Refresh'),
  );
}

registerView({ id: `${pluginId}.panel`, title: 'Hello Hedwig', group: 'plugins', component: HelloPanel, description: 'Example plugin panel' });
registerCommand({ id: `${pluginId}.open`, title: 'Open Hello Hedwig', run: () => useHedwig.getState().openView(`${pluginId}.panel`) });
