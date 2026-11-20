const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { appConfigPath, ensureAppConfig, readTradingViewCookie } = require('../src/main/app-config.cjs');

async function configFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'is-vol-app-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return appConfigPath({ getPath: (key) => { assert.equal(key, 'documents'); return directory; } });
}

test('creates a configuration next to Data with inactive examples and anonymous default', async (t) => {
  const file = await configFixture(t);
  assert.equal(path.basename(path.dirname(file)), 'IS-VOL');
  assert.equal(await readTradingViewCookie(file), '');
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(config.tradingview.cookie, '');
  assert.match(config._examples['tradingview.cookie'], /sessionid=YOUR_SESSION_ID/);
});

test('preserves existing configuration and reloads cookie edits, including UTF-8 BOM', async (t) => {
  const file = await configFixture(t);
  await ensureAppConfig(file);
  const first = JSON.stringify({ tradingview: { cookie: ' sessionid=test-first; other="value" ' }, other: 123 });
  await fs.writeFile(file, first);
  await ensureAppConfig(file);
  assert.equal(await fs.readFile(file, 'utf8'), first);
  assert.equal(await readTradingViewCookie(file), 'sessionid=test-first; other="value"');
  await fs.writeFile(file, '\uFEFF' + JSON.stringify({ tradingview: { cookie: 'sessionid=test-second' } }));
  assert.equal(await readTradingViewCookie(file), 'sessionid=test-second');
  await fs.writeFile(file, '{}');
  assert.equal(await readTradingViewCookie(file), '');
});

test('rejects corrupt configuration and invalid cookie values without exposing secrets or overwriting', async (t) => {
  const file = await configFixture(t);
  await ensureAppConfig(file);
  for (const content of ['{"tradingview":{"cookie":"SECRET" bad}', JSON.stringify({ tradingview: { cookie: 'SECRET\r\ninjected' } }), JSON.stringify({ tradingview: { cookie: 123 } })]) {
    await fs.writeFile(file, content);
    await assert.rejects(readTradingViewCookie(file), (err) => !err.message.includes('SECRET') && err.message.includes(file));
    assert.equal(await fs.readFile(file, 'utf8'), content);
  }
});
