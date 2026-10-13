const {
  createAutoLaunchLifecycle,
  createScheduledRefreshLifecycle
} = require('./auto-launch-datasource/lifecycle.cjs');
const { activateTapeContractDataSource } = require('./tape-contract-datasource/main.cjs');

const dataSourceLifecycleToolsPlugin = {
  id: 'datasource-lifecycle-tools',
  title: 'DataSource Lifecycle Tools',
  activateMain(context) {
    const cleanups = [
      context?.dataSources?.registerLifecycle?.(createAutoLaunchLifecycle()),
      context?.dataSources?.registerLifecycle?.(createScheduledRefreshLifecycle())
    ].filter((cleanup) => typeof cleanup === 'function');
    return () => {
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }
};

const appMainPluginManifests = [
  dataSourceLifecycleToolsPlugin,
  {
    id: 'tape-contract-datasource',
    title: 'Tape Contract DataSource',
    activateMain: activateTapeContractDataSource
  }
];

function activateMainAppPlugins(manifests, context) {
  const cleanups = [];
  for (const manifest of Array.isArray(manifests) ? manifests : []) {
    if (typeof manifest?.activateMain !== 'function') continue;
    try {
      const cleanup = manifest.activateMain(context);
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    } catch (err) {
      console.warn(`Failed to activate main plugin ${manifest?.id || 'unknown'}`, err);
    }
  }
  return () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (err) {
        console.warn('Failed to deactivate main plugin cleanup', err);
      }
    }
  };
}

module.exports = {
  activateMainAppPlugins,
  appMainPluginManifests
};
