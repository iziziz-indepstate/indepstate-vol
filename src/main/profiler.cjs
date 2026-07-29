const fs = require('fs');
const path = require('path');

const MAX_EVENTS = 1200;
const events = [];
let enabled = false;

function setEnabled(value) {
  enabled = Boolean(value);
}

function isEnabled() {
  return enabled;
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function push(event) {
  if (!enabled) return;
  events.push({
    ts: new Date().toISOString(),
    process: 'main',
    ...event
  });
  while (events.length > MAX_EVENTS) events.shift();
}

async function measure(name, detail, fn) {
  if (!enabled) return fn();
  const start = nowMs();
  try {
    return await fn();
  } finally {
    push({
      name,
      detail: detail || {},
      durationMs: Number((nowMs() - start).toFixed(2))
    });
  }
}

async function exportEvents(userDataPath, rendererEvents = []) {
  const out = {
    exportedAt: new Date().toISOString(),
    main: events,
    renderer: Array.isArray(rendererEvents) ? rendererEvents : []
  };
  const file = path.join(userDataPath, `is-vol-profiler-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.promises.writeFile(file, JSON.stringify(out, null, 2), 'utf-8');
  return { ok: true, file, counts: { main: events.length, renderer: out.renderer.length } };
}

module.exports = {
  events,
  exportEvents,
  isEnabled,
  measure,
  push,
  setEnabled
};
