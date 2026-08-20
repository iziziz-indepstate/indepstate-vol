function parseTimeToMinutes(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function isInsideWindow(currentMinutes, startMinutes, stopMinutes) {
  if (startMinutes === stopMinutes) return false;
  if (startMinutes < stopMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < stopMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < stopMinutes;
}

function createAutoLaunchLifecycle() {
  return {
    id: 'auto-launch-datasource',
    title: 'Auto launch',
    controls: [
      { name: 'enabled', type: 'checkbox', label: 'Auto launch', defaultValue: false },
      { name: 'startTime', type: 'time', label: 'Start after', defaultValue: '' },
      { name: 'stopTime', type: 'time', label: 'Stop after', defaultValue: '' }
    ],
    create() {
      return {
        async tick({ dataSource, settings, now }) {
          if (!settings?.enabled) return;
          const startMinutes = parseTimeToMinutes(settings.startTime);
          const stopMinutes = parseTimeToMinutes(settings.stopTime);
          if (startMinutes == null || stopMinutes == null) return;

          const dt = now instanceof Date ? now : new Date(now);
          const currentMinutes = dt.getHours() * 60 + dt.getMinutes();
          const shouldRun = isInsideWindow(currentMinutes, startMinutes, stopMinutes);
          const running = dataSource.isRunning();
          if (shouldRun && !running) await dataSource.start();
          if (!shouldRun && running) await dataSource.stop();
        }
      };
    }
  };
}

module.exports = {
  createAutoLaunchLifecycle,
  isInsideWindow,
  parseTimeToMinutes
};
