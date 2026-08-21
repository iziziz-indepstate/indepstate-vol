function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeControls(controls) {
  return (Array.isArray(controls) ? controls : [])
    .filter((control) => control && typeof control.name === 'string' && control.name.trim())
    .map((control) => ({
      name: control.name.trim(),
      type: ['checkbox', 'time', 'time-list', 'number', 'text'].includes(control.type) ? control.type : 'text',
      label: control.label || control.name.trim(),
      defaultValue: cloneJson(control.defaultValue),
      min: control.min,
      max: control.max,
      options: Array.isArray(control.options) ? cloneJson(control.options) : undefined
    }));
}

function defaultSettingsForControls(controls) {
  const settings = {};
  for (const control of controls) {
    if (control.defaultValue !== undefined) settings[control.name] = cloneJson(control.defaultValue);
  }
  return settings;
}

function readLifecycleSettings(tab, lifecycleId, controls = []) {
  const allSettings = tab?.providerConfig?.lifecycleSettings;
  const saved = allSettings && typeof allSettings === 'object' ? allSettings[lifecycleId] : null;
  return {
    ...defaultSettingsForControls(controls),
    ...(saved && typeof saved === 'object' ? cloneJson(saved) : {})
  };
}

function createDataSourceRuntime(tab, callbacks = {}) {
  let currentTab = tab;
  let running = Boolean(callbacks.isRunning?.(tab.id));

  return {
    get tabId() { return currentTab.id; },
    get providerKey() { return currentTab.providerKey; },
    get title() { return currentTab.title; },
    get providerConfig() { return currentTab.providerConfig || {}; },
    update(nextTab) {
      currentTab = nextTab;
      running = Boolean(callbacks.isRunning?.(currentTab.id));
    },
    snapshot() {
      return {
        tabId: currentTab.id,
        providerKey: currentTab.providerKey,
        title: currentTab.title,
        providerConfig: cloneJson(currentTab.providerConfig || {}),
        running: this.isRunning()
      };
    },
    getConfig() {
      return cloneJson(currentTab.providerConfig || {});
    },
    patchConfig(partial) {
      return callbacks.patchConfig?.(currentTab.id, partial || {});
    },
    isRunning() {
      running = Boolean(callbacks.isRunning?.(currentTab.id));
      return running;
    },
    async start() {
      const result = await callbacks.command?.(currentTab.id, 'start');
      running = result?.running ?? true;
      return result;
    },
    async stop() {
      const result = await callbacks.command?.(currentTab.id, 'stop');
      running = result?.running ?? false;
      return result;
    },
    async refreshOnce() {
      const result = await callbacks.command?.(currentTab.id, 'refresh');
      running = result?.running ?? this.isRunning();
      return result;
    }
  };
}

function createDataSourceLifecycleRegistry({ command, patchConfig, isRunning, now = () => new Date() } = {}) {
  const descriptors = new Map();
  const runtimes = new Map();
  const instances = new Map();

  function instanceKey(tabId, lifecycleId) {
    return `${tabId}::${lifecycleId}`;
  }

  function dataSourceForApply(runtime) {
    return runtime.snapshot();
  }

  function cleanupInstance(key) {
    const instance = instances.get(key);
    instances.delete(key);
    if (typeof instance?.cleanup === 'function') instance.cleanup();
  }

  function ensureInstance(runtime, descriptor) {
    const key = instanceKey(runtime.tabId, descriptor.id);
    if (instances.has(key)) return instances.get(key);
    const factory = typeof descriptor.create === 'function'
      ? descriptor.create
      : () => ({ tick: descriptor.tick });
    const instance = factory({ dataSource: runtime }) || {};
    instances.set(key, instance);
    return instance;
  }

  return {
    registerLifecycle(descriptor) {
      if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id.trim()) {
        throw new Error('Lifecycle descriptor id is required');
      }
      const id = descriptor.id.trim();
      descriptors.set(id, {
        ...descriptor,
        id,
        controls: normalizeControls(descriptor.controls)
      });
      return () => {
        descriptors.delete(id);
        for (const key of Array.from(instances.keys())) {
          if (key.endsWith(`::${id}`)) cleanupInstance(key);
        }
      };
    },
    syncDataSources(tabs) {
      const seenTabIds = new Set();
      for (const tab of Array.isArray(tabs) ? tabs : []) {
        if (!tab?.id) continue;
        seenTabIds.add(tab.id);
        const existing = runtimes.get(tab.id);
        if (existing) existing.update(tab);
        else {
          runtimes.set(tab.id, createDataSourceRuntime(tab, {
            command,
            patchConfig,
            isRunning
          }));
        }
      }

      for (const tabId of Array.from(runtimes.keys())) {
        if (seenTabIds.has(tabId)) continue;
        runtimes.delete(tabId);
        for (const key of Array.from(instances.keys())) {
          if (key.startsWith(`${tabId}::`)) cleanupInstance(key);
        }
      }
    },
    getUiExtensions() {
      const result = {};
      for (const runtime of runtimes.values()) {
        const extensions = [];
        for (const descriptor of descriptors.values()) {
          const applies = typeof descriptor.appliesTo === 'function'
            ? descriptor.appliesTo(dataSourceForApply(runtime))
            : true;
          if (!applies) continue;
          extensions.push({
            id: descriptor.id,
            title: descriptor.title || descriptor.id,
            controls: cloneJson(descriptor.controls),
            values: readLifecycleSettings(runtime.snapshot(), descriptor.id, descriptor.controls)
          });
        }
        result[runtime.tabId] = extensions;
      }
      return result;
    },
    async tick() {
      for (const runtime of runtimes.values()) {
        for (const descriptor of descriptors.values()) {
          const dataSource = dataSourceForApply(runtime);
          const applies = typeof descriptor.appliesTo === 'function' ? descriptor.appliesTo(dataSource) : true;
          if (!applies) continue;
          const settings = readLifecycleSettings(dataSource, descriptor.id, descriptor.controls);
          const instance = ensureInstance(runtime, descriptor);
          if (typeof instance?.tick !== 'function') continue;
          await instance.tick({
            dataSource: runtime,
            settings,
            now: now()
          });
        }
      }
    },
    cleanup() {
      for (const key of Array.from(instances.keys())) cleanupInstance(key);
      runtimes.clear();
      descriptors.clear();
    },
    descriptors,
    runtimes,
    instances
  };
}

module.exports = {
  createDataSourceLifecycleRegistry,
  createDataSourceRuntime,
  readLifecycleSettings
};
