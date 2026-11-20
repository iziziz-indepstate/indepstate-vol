import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTradingViewModes, tradingViewStatusNotice } from '../src/shared/tradingview-data-status.mjs';

test('delayed contracts take precedence over streaming or unknown, with maximum declared delay', () => {
  const result = summarizeTradingViewModes(['streaming', 'delayed_streaming_900', null, 'delayed_streaming_1200']);
  assert.equal(result.status, 'delayed');
  assert.equal(result.delaySeconds, 1200);
  assert.match(tradingViewStatusNotice({ marketData: result }).text, /20 min/);
  const unspecified = summarizeTradingViewModes(['delayed_streaming']);
  assert.equal(unspecified.status, 'delayed');
  assert.equal(unspecified.delaySeconds, null);
});

test('real-time requires all modes to be streaming; absent and unknown modes never confirm access', () => {
  assert.equal(summarizeTradingViewModes(['streaming', 'streaming']).status, 'realtime');
  for (const modes of [[], [null], ['streaming', null], ['streaming', 'endofday']]) {
    const status = summarizeTradingViewModes(modes);
    assert.equal(status.status, 'unknown');
    assert.match(tradingViewStatusNotice({ marketData: status }).text, /not confirmed/);
  }
});

test('notice changes from unchecked to delayed to real-time and identifies last observation', () => {
  assert.match(tradingViewStatusNotice(null).text, /not checked/);
  const time = '2026-11-20T15:00:00.000Z';
  const delayed = tradingViewStatusNotice({ time, marketData: summarizeTradingViewModes(['delayed_streaming_900']) });
  assert.equal(delayed.level, 'warning');
  assert.match(delayed.text, /15 min/);
  assert.ok(delayed.text.includes(time));
  assert.match(delayed.text, /tradingview.cookie/);
  const realtime = tradingViewStatusNotice({ time, marketData: summarizeTradingViewModes(['streaming']) });
  assert.equal(realtime.level, 'success');
  assert.match(realtime.text, /real-time/);
  assert.ok(!realtime.text.includes('delayed'));
});
