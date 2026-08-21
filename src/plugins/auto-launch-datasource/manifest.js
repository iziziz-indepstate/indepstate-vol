import lifecycleModule from './lifecycle.cjs';

const { createAutoLaunchLifecycle } = lifecycleModule;
const { createScheduledRefreshLifecycle } = lifecycleModule;

const manifest = {
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

export default manifest;
