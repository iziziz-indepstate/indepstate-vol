import { POINT_CLICK_EVENT, subscribeNDateStrikeClipboard } from './listener.js';

const manifest = {
  id: 'ndate-strike-clipboard',
  title: 'nDate Strike Clipboard',
  eventSubscriptions: [POINT_CLICK_EVENT],
  activate(context) {
    return subscribeNDateStrikeClipboard({
      eventBus: context?.eventBus,
      getWidgetDefinition: context?.getWidgetDefinition,
      writeText: context?.clipboard?.writeText,
      setStatus: context?.setStatus
    });
  }
};

export default manifest;
