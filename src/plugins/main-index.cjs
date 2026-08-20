const { createAutoLaunchLifecycle } = require('./auto-launch-datasource/lifecycle.cjs');

const autoLaunchDataSourcePlugin = {
  id: 'auto-launch-datasource',
  title: 'Auto Launch DataSource',
  activateMain(context) {
    return context?.dataSources?.registerLifecycle?.(createAutoLaunchLifecycle());
  }
};

const appMainPluginManifests = [
  autoLaunchDataSourcePlugin
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
