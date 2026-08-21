const test = require('node:test');
const assert = require('node:assert/strict');
const { createDataSourceLifecycleRegistry } = require('../src/main/data-source-lifecycle.cjs');

function tab(id, providerKey = 'tradingview') {
  return {
    id,
    title: id,
    providerKey,
    providerConfig: {
      lifecycleSettings: {
        matching: { enabled: true }
      }
    }
  };
}

test('registers lifecycle descriptors and creates matching tab instances', async () => {
  const ticks = [];
  const registry = createDataSourceLifecycleRegistry();
  registry.registerLifecycle({
    id: 'matching',
    title: 'Matching',
    appliesTo: (dataSource) => dataSource.providerKey === 'tradingview',
    controls: [{ name: 'enabled', type: 'checkbox', defaultValue: false }],
    create: ({ dataSource }) => ({
      tick: ({ settings }) => ticks.push({ tabId: dataSource.tabId, settings })
    })
  });

  registry.syncDataSources([tab('tab-1'), tab('tab-2', 'theblock')]);
  await registry.tick();

  assert.deepEqual(ticks, [{ tabId: 'tab-1', settings: { enabled: true } }]);
});

test('ui extensions include default and persisted lifecycle settings', () => {
  const registry = createDataSourceLifecycleRegistry();
  registry.registerLifecycle({
    id: 'matching',
    title: 'Matching',
    controls: [
      { name: 'enabled', type: 'checkbox', defaultValue: false },
      { name: 'startTime', type: 'time', defaultValue: '' },
      { name: 'times', type: 'time-list', defaultValue: [] }
    ]
  });

  registry.syncDataSources([tab('tab-1')]);
  const ui = registry.getUiExtensions();

  assert.equal(ui['tab-1'][0].id, 'matching');
  assert.equal(ui['tab-1'][0].controls[2].type, 'time-list');
  assert.deepEqual(ui['tab-1'][0].values, { enabled: true, startTime: '', times: [] });
});

test('removing a datasource cleans up its lifecycle instance', async () => {
  let cleanupCount = 0;
  const registry = createDataSourceLifecycleRegistry();
  registry.registerLifecycle({
    id: 'cleanup-test',
    create: () => ({
      tick: () => {},
      cleanup: () => { cleanupCount += 1; }
    })
  });

  registry.syncDataSources([tab('tab-1')]);
  await registry.tick();
  registry.syncDataSources([]);

  assert.equal(cleanupCount, 1);
});

test('runtime commands use the configured command bridge and running state', async () => {
  const calls = [];
  const running = new Set();
  const registry = createDataSourceLifecycleRegistry({
    command: async (tabId, command) => {
      calls.push({ tabId, command });
      if (command === 'start') running.add(tabId);
      if (command === 'stop') running.delete(tabId);
      return { ok: true, running: running.has(tabId) };
    },
    isRunning: (tabId) => running.has(tabId)
  });
  registry.registerLifecycle({
    id: 'runner',
    create: () => ({
      tick: async ({ dataSource }) => {
        if (!dataSource.isRunning()) await dataSource.start();
      }
    })
  });

  registry.syncDataSources([tab('tab-1')]);
  await registry.tick();
  await registry.tick();

  assert.deepEqual(calls, [{ tabId: 'tab-1', command: 'start' }]);
});
