import lifecycleModule from './lifecycle.cjs';

const { createAutoLaunchLifecycle } = lifecycleModule;

const manifest = {
  id: 'auto-launch-datasource',
  title: 'Auto Launch DataSource',
  activateMain(context) {
    return context?.dataSources?.registerLifecycle?.(createAutoLaunchLifecycle());
  }
};

export default manifest;
