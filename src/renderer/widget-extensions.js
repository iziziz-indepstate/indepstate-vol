function noop() {}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function normalizeControls(controls) {
  return (Array.isArray(controls) ? controls : [])
    .filter((control) => control && typeof control === 'object' && control.name);
}

export function widgetPluginSettings(widget, pluginId) {
  if (!widget || !pluginId) return {};
  widget.config ||= {};
  widget.config.plugins ||= {};
  widget.config.plugins[pluginId] ||= {};
  return widget.config.plugins[pluginId];
}

export function normalizeWidgetPluginConfig(widget, manifests = []) {
  if (!widget || typeof widget !== 'object') return widget;
  widget.config ||= {};
  widget.config.plugins ||= {};

  for (const manifest of Array.isArray(manifests) ? manifests : []) {
    for (const extension of Array.isArray(manifest?.widgetExtensions) ? manifest.widgetExtensions : []) {
      if (typeof extension?.migrateConfig !== 'function') continue;
      try {
        extension.migrateConfig({ widget, pluginId: manifest.id });
      } catch (err) {
        console.warn(`Failed to migrate widget extension config for ${manifest.id || 'unknown'}`, err);
      }
    }
  }

  return widget;
}

export function applicableWidgetExtensions(manifests = [], widget, definition) {
  const extensions = [];
  for (const manifest of Array.isArray(manifests) ? manifests : []) {
    const pluginId = manifest?.id;
    if (!pluginId) continue;
    for (const extension of Array.isArray(manifest?.widgetExtensions) ? manifest.widgetExtensions : []) {
      const appliesTo = typeof extension?.appliesTo === 'function' ? extension.appliesTo : noop;
      let applies = false;
      try {
        applies = Boolean(appliesTo(widget, definition));
      } catch (err) {
        console.warn(`Failed to evaluate widget extension ${pluginId}`, err);
      }
      if (!applies) continue;
      extensions.push({
        pluginId,
        pluginTitle: manifest.title || pluginId,
        settingsKey: extension.settingsKey || pluginId,
        controls: normalizeControls(extension.controls)
      });
    }
  }
  return extensions;
}

export function createWidgetExtensionControlsHtml(widget, extensions = []) {
  const chunks = [];
  for (const extension of Array.isArray(extensions) ? extensions : []) {
    const settings = widgetPluginSettings(widget, extension.pluginId);
    for (const control of normalizeControls(extension.controls)) {
      const label = control.label || control.name;
      const value = settings[control.name] ?? control.defaultValue;
      const dataset = `data-widget-extension-widget-id="${esc(widget?.id || '')}" data-widget-extension-plugin-id="${esc(extension.pluginId)}" data-widget-extension-settings-key="${esc(extension.settingsKey || extension.pluginId)}" data-widget-extension-control="${esc(control.name)}"`;
      if (control.type === 'checkbox') {
        chunks.push(`<label class="widget-control widget-control-checkbox widget-extension-control" title="${esc(control.title || label)}">
          <input type="checkbox" ${dataset} ${value ? 'checked' : ''} />
          <span>${esc(label)}</span>
        </label>`);
        continue;
      }
      chunks.push(`<label class="widget-control widget-extension-control">${esc(label)}
        <input type="${esc(control.type || 'text')}" ${dataset} value="${esc(value ?? '')}" />
      </label>`);
    }
  }
  return chunks.join('');
}

export function normalizeWidgetExtensionControlValue(control, value) {
  if (control?.type === 'checkbox') return Boolean(value);
  if (control?.type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : '';
  }
  return value == null ? '' : String(value);
}

export function findWidgetExtensionControl(extensions = [], pluginId, controlName) {
  for (const extension of Array.isArray(extensions) ? extensions : []) {
    if (extension?.pluginId !== pluginId) continue;
    const control = normalizeControls(extension.controls).find((item) => item.name === controlName);
    if (control) return control;
  }
  return null;
}

export function writeWidgetExtensionControlValue(widget, extension, controlName, rawValue) {
  const control = normalizeControls(extension?.controls).find((item) => item.name === controlName);
  if (!widget || !extension?.pluginId || !control) return false;
  const settings = widgetPluginSettings(widget, extension.pluginId);
  settings[controlName] = normalizeWidgetExtensionControlValue(control, rawValue);
  return true;
}
