import {
  ATM_STRADDLE_SNAPSHOT_PLUGIN_ID,
  subscribeAtmStraddleSnapshot
} from './listener.js';

const manifest = {
  id: ATM_STRADDLE_SNAPSHOT_PLUGIN_ID,
  title: 'ATM Straddle Snapshot',
  widgetExtensions: [
    {
      settingsKey: ATM_STRADDLE_SNAPSHOT_PLUGIN_ID,
      appliesTo(widget, definition) {
        return widget?.type === 'atm-straddle' && definition?.type === 'atm-straddle';
      },
      controls: [
        {
          name: 'enabled',
          type: 'checkbox',
          label: 'Save snapshot',
          defaultValue: false
        }
      ],
      migrateConfig({ widget, pluginId }) {
        if (!widget?.config || widget.config.saveSnapshot !== true) {
          if (widget?.config && Object.prototype.hasOwnProperty.call(widget.config, 'saveSnapshot')) {
            delete widget.config.saveSnapshot;
          }
          return;
        }

        widget.config.plugins ||= {};
        widget.config.plugins[pluginId] ||= {};
        widget.config.plugins[pluginId].enabled = true;
        delete widget.config.saveSnapshot;
      }
    }
  ],
  activate(context) {
    return subscribeAtmStraddleSnapshot({
      widgetDataEvents: context?.widgetDataEvents,
      appBridge: context?.appBridge
    });
  }
};

export default manifest;
