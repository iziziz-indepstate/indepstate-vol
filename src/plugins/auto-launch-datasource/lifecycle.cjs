function parseTimeToMinutes(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatMinutesAsTime(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) return '';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function normalizeTimeValue(value) {
  const minutes = parseTimeToMinutes(value);
  return minutes == null ? '' : formatMinutesAsTime(minutes);
}

function normalizeTimeList(values) {
  const source = Array.isArray(values)
    ? values
    : String(values || '').split(/[,\s]+/);
  return Array.from(new Set(
    source
      .map(normalizeTimeValue)
      .filter(Boolean)
  )).sort((a, b) => parseTimeToMinutes(a) - parseTimeToMinutes(b));
}

function isInsideWindow(currentMinutes, startMinutes, stopMinutes) {
  if (startMinutes === stopMinutes) return false;
  if (startMinutes < stopMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < stopMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < stopMinutes;
}

function localDateKey(date) {
  const dt = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(dt.getTime())) return '';
  return [
    dt.getFullYear(),
    String(dt.getMonth() + 1).padStart(2, '0'),
    String(dt.getDate()).padStart(2, '0')
  ].join('-');
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

function createScheduledRefreshLifecycle() {
  return {
    id: 'scheduled-refresh-datasource',
    title: 'Scheduled refresh',
    controls: [
      { name: 'enabled', type: 'checkbox', label: 'Scheduled refresh', defaultValue: false },
      { name: 'times', type: 'time-list', label: 'Refresh times', defaultValue: [] }
    ],
    create() {
      const firedKeys = new Set();
      return {
        async tick({ dataSource, settings, now }) {
          if (!settings?.enabled) return;
          const times = normalizeTimeList(settings.times);
          if (!times.length) return;

          const dt = now instanceof Date ? now : new Date(now);
          if (Number.isNaN(dt.getTime())) return;
          const currentTime = formatMinutesAsTime(dt.getHours() * 60 + dt.getMinutes());
          if (!times.includes(currentTime)) return;

          const key = `${localDateKey(dt)} ${currentTime}`;
          if (firedKeys.has(key)) return;
          firedKeys.add(key);
          await dataSource.refreshOnce();
        }
      };
    }
  };
}

module.exports = {
  createAutoLaunchLifecycle,
  createScheduledRefreshLifecycle,
  formatMinutesAsTime,
  isInsideWindow,
  normalizeTimeList,
  normalizeTimeValue,
  parseTimeToMinutes
};
