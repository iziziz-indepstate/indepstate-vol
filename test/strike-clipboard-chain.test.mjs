import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrikeClipboardChain } from '../src/renderer/widgets/strike-clipboard-chain.js';
import { nDateSkewPutWidget } from '../src/renderer/widgets/ndate-put-skew-widget.js';
import { nDateSkewCallWidget } from '../src/renderer/widgets/ndate-call-skew-widget.js';
import { nDateSkewBidIVRatioWidget } from '../src/renderer/widgets/ndate-bidiv-ratio-widget.js';

test('first strike click starts a pending chain without clipboard text', () => {
  const chain = createStrikeClipboardChain();

  const result = chain.click({
    widgetId: 'put-1',
    prefix: 'sps',
    strike: 7100,
    now: 1000
  });

  assert.equal(result.text, null);
  assert.equal(result.pending, true);
  assert.equal(result.strike, '7100');
  assert.deepEqual(chain.snapshot(), {
    widgetId: 'put-1',
    prefix: 'sps',
    strike: '7100',
    timestamp: 1000
  });
});

test('second strike click in the same widget completes and clears the chain', () => {
  const chain = createStrikeClipboardChain();

  chain.click({ widgetId: 'call-1', prefix: 'lcs', strike: 7100, now: 1000 });
  const result = chain.click({ widgetId: 'call-1', prefix: 'lcs', strike: 7200, now: 5000 });

  assert.equal(result.text, 'lcs 7100 7200');
  assert.equal(result.pending, false);
  assert.equal(chain.snapshot(), null);
});

test('third strike click starts a new chain after completion', () => {
  const chain = createStrikeClipboardChain();

  chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7100, now: 1000 });
  chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7200, now: 2000 });
  const result = chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7300, now: 3000 });

  assert.equal(result.text, null);
  assert.equal(result.pending, true);
  assert.deepEqual(chain.snapshot(), {
    widgetId: 'put-1',
    prefix: 'sps',
    strike: '7300',
    timestamp: 3000
  });
});

test('click in another widget resets the previous pending chain', () => {
  const chain = createStrikeClipboardChain();

  chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7100, now: 1000 });
  const result = chain.click({ widgetId: 'put-2', prefix: 'sps', strike: 7200, now: 2000 });

  assert.equal(result.text, null);
  assert.equal(result.pending, true);
  assert.deepEqual(chain.snapshot(), {
    widgetId: 'put-2',
    prefix: 'sps',
    strike: '7200',
    timestamp: 2000
  });
});

test('click after timeout starts a fresh chain', () => {
  const chain = createStrikeClipboardChain(20000);

  chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7100, now: 1000 });
  const result = chain.click({ widgetId: 'put-1', prefix: 'sps', strike: 7200, now: 21001 });

  assert.equal(result.text, null);
  assert.equal(result.pending, true);
  assert.deepEqual(chain.snapshot(), {
    widgetId: 'put-1',
    prefix: 'sps',
    strike: '7200',
    timestamp: 21001
  });
});

test('clipboard chain is enabled only for side-specific nDate skew widgets', () => {
  assert.equal(nDateSkewPutWidget.clipboardChainPrefix, 'sps');
  assert.equal(nDateSkewCallWidget.clipboardChainPrefix, 'lcs');
  assert.equal(nDateSkewBidIVRatioWidget.clipboardChainPrefix, undefined);
});
