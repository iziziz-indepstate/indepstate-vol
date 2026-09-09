import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExpiryList,
  collectExpiryPlaceholderKeys,
  hasExpiryPlaceholder,
  resolveExpiryPlaceholders,
  resolveExpiryToken
} from '../src/shared/expiry-placeholders.mjs';

test('collects expiry placeholder keys case-insensitively', () => {
  assert.deepEqual(collectExpiryPlaceholderKeys('today, NEXTweek', 'nextMonth'), ['today', 'nextWeek', 'nextMonth']);
  assert.equal(hasExpiryPlaceholder('20260918'), false);
  assert.equal(hasExpiryPlaceholder('20260918,nextWeek'), true);
});

test('resolves expiry placeholders for weekday, weekend, holiday, and monthly Friday', () => {
  assert.deepEqual(
    resolveExpiryPlaceholders({
      now: new Date('2026-09-09T12:00:00Z'),
      marketHolidays: []
    }),
    { today: '20260909', nextWeek: '20260918', nextMonth: '20260925' }
  );

  assert.equal(resolveExpiryPlaceholders({
    now: new Date('2026-09-12T12:00:00Z'),
    marketHolidays: []
  }).today, '20260914');

  assert.equal(resolveExpiryPlaceholders({
    now: new Date('2026-06-10T12:00:00Z'),
    marketHolidays: ['2026-06-19']
  }).nextWeek, '20260618');
});

test('moves nextMonth to next monthly expiry when it equals nextWeek', () => {
  assert.deepEqual(
    resolveExpiryPlaceholders({
      now: new Date('2026-09-17T12:00:00Z'),
      marketHolidays: []
    }),
    { today: '20260917', nextWeek: '20260925', nextMonth: '20261030' }
  );
});

test('buildExpiryList resolves mixed placeholders and requested metadata keys', () => {
  assert.deepEqual(
    buildExpiryList('today, 20260930,nextWeek,nextMonth', '', {
      now: new Date('2026-09-09T12:00:00Z'),
      marketHolidays: []
    }),
    ['20260909', '20260930', '20260918', '20260925']
  );

  assert.deepEqual(
    buildExpiryList('20260930', '', {
      includeMetadata: true,
      placeholderKeys: ['nextWeek'],
      now: new Date('2026-09-09T12:00:00Z'),
      marketHolidays: []
    }),
    {
      expiries: ['20260930'],
      placeholders: { nextWeek: '20260918' }
    }
  );
});

test('resolveExpiryToken leaves placeholders raw when metadata is missing', () => {
  assert.deepEqual(resolveExpiryToken('nextWeek', {}), { value: 'nextWeek', placeholder: 'nextWeek' });
  assert.deepEqual(resolveExpiryToken('nextWeek', { nextWeek: '20260918' }), { value: '20260918', placeholder: 'nextWeek' });
});
