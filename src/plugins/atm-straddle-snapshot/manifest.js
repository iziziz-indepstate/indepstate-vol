import {
  ATM_STRADDLE_SNAPSHOT_PLUGIN_ID,
  ATM_STRADDLE_POINT_EVENT,
  subscribeAtmStraddleSnapshot
} from './listener.js';
import { atmStraddleSnapshotWidgets } from './widgets.js';

const manifest = {
  id: ATM_STRADDLE_SNAPSHOT_PLUGIN_ID,
  title: 'ATM Straddle Snapshot',
  widgets: atmStraddleSnapshotWidgets,
  eventSubscriptions: [ATM_STRADDLE_POINT_EVENT],
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
      eventBus: context?.eventBus,
      appBridge: context?.appBridge
    });
  }
};

export default manifest;
