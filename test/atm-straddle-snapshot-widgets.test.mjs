import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateDailyPriceWidgetConfig } from '../src/shared/straddle-daily-config.mjs';
import atmStraddleSnapshotPlugin from '../src/plugins/atm-straddle-snapshot/manifest.js';
import {
  addSnapshotWidgetLine,
  buildDailyPriceSeries,
  buildDynamicsSeries,
  normalizeChartValue,
  normalizeDailyLines,
  removeSnapshotWidgetLine,
  straddleDailyPriceWidget,
  straddleDynamicsWidget,
  writeSnapshotWidgetConfigValue,
  writeSnapshotWidgetLineConfigValue
} from '../src/plugins/atm-straddle-snapshot/widgets.js';

function localIso(year, month, day, hour, minute, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

function document(date, points, tenor = '0DTE') {
  return {
    kind: 'atm-straddle-daily-snapshot',
    version: 1,
    date,
    identity: { tenor },
    source: { filename: `${date}-${tenor}.json` },
    points: points.map((point) => ({
      atmStrike: 6500,
      spot: 6501,
      ...point
    }))
  };
}

test('ATM straddle snapshot plugin manifest exposes display widgets', () => {
  assert.deepEqual(atmStraddleSnapshotPlugin.widgets.map((widget) => widget.type), [
    'straddle-daily-price',
    'straddle-dynamics'
  ]);
  assert.deepEqual(straddleDailyPriceWidget.defaultConfig.lines, [{ tenor: '0DTE', offsetMinutes: 15 }]);
  assert.equal(straddleDynamicsWidget.defaultConfig.tenor, '0DTE');
});

test('snapshot chart value normalization keeps missing values as gaps', () => {
  assert.equal(normalizeChartValue(null), null);
  assert.equal(normalizeChartValue(undefined), null);
  assert.equal(normalizeChartValue(''), null);
  assert.equal(normalizeChartValue(Number.NaN), null);
  assert.equal(normalizeChartValue(0), 0);
  assert.equal(normalizeChartValue('12.3'), 12.3);
});

test('Straddle Daily Price matches minutes from New York open and ignores seconds', () => {
  const docs = [
    document('2026-08-25', [
      { time: '2026-08-25T13:45:59.999Z', straddlePts: 12.4 },
      { time: '2026-08-25T13:45:59.999Z', straddlePts: 99 }
    ]),
    document('2026-08-26', [
      { time: '2026-08-26T13:45:01Z', straddlePts: 13.8 }
    ])
  ];

  const series = buildDailyPriceSeries(docs, { lines: [{ tenor: '0DTE', offsetMinutes: 15 }] });

  assert.deepEqual(series.labels, ['2026-08-25', '2026-08-26']);
  assert.deepEqual(series.datasets[0].data, [12.4, 13.8]);
  assert.equal(series.datasets[0].pointMeta[0].sessionTime, '09:45');
  assert.equal(series.datasets[0].pointMeta[0].sessionTimezone, 'America/New_York');
  assert.equal(series.datasets[0].pointMeta[0].offsetMinutes, 15);
  assert.equal(series.datasets[0].pointMeta[0].sourceFile, '2026-08-25-0DTE.json');
});

test('Straddle Daily Price skips days without an exact minute match', () => {
  const docs = [
    document('2026-08-25', [
      { time: '2026-08-25T13:40:00Z', straddlePts: 15.1 },
      { time: '2026-08-25T13:46:00Z', straddlePts: 15 }
    ]),
    document('2026-08-26', [
      { time: '2026-08-26T13:45:30Z', straddlePts: 14.2 }
    ])
  ];

  const series = buildDailyPriceSeries(docs, { lines: [{ tenor: '0DTE', offsetMinutes: 15 }] });

  assert.deepEqual(series.labels, ['2026-08-26']);
  assert.deepEqual(series.datasets[0].data, [14.2]);
});

test('Straddle Daily Price builds one dataset per configured line', () => {
  const docs = [
    document('2026-08-25', [
      { time: '2026-08-25T13:45:00Z', straddlePts: 12.4 },
      { time: '2026-08-25T14:00:00Z', straddlePts: 11.9 }
    ], '0DTE'),
    document('2026-08-26', [
      { time: '2026-08-26T13:45:00Z', straddlePts: 13.2 }
    ], '0DTE'),
    document('2026-08-25', [
      { time: '2026-08-25T14:00:00Z', straddlePts: 27.1 }
    ], '1W')
  ];

  const series = buildDailyPriceSeries(docs, {
    lines: [
      { tenor: '0DTE', offsetMinutes: 15 },
      { tenor: '1W', offsetMinutes: 30 }
    ]
  });

  assert.deepEqual(series.labels, ['2026-08-25', '2026-08-26']);
  assert.deepEqual(series.datasets.map((dataset) => dataset.label), ['0DTE @ +15 min', '1W @ +30 min']);
  assert.deepEqual(series.datasets[0].data, [12.4, 13.2]);
  assert.deepEqual(series.datasets[1].data, [27.1, null]);
});

test('Straddle Dynamics builds one dataset per date', () => {
  const docs = [
    document('2026-08-25', [
      { time: localIso(2026, 8, 25, 16, 40, 0), straddlePts: 15.1 },
      { time: localIso(2026, 8, 25, 16, 45, 0), straddlePts: 14.2 }
    ]),
    document('2026-08-26', [
      { time: localIso(2026, 8, 26, 16, 45, 0), straddlePts: 13.7 },
      { time: localIso(2026, 8, 26, 16, 50, 0), straddlePts: 13.1 }
    ])
  ];

  const series = buildDynamicsSeries(docs);

  assert.deepEqual(series.labels, ['16:40', '16:45', '16:50']);
  assert.deepEqual(series.datasets.map((dataset) => dataset.label), ['2026-08-25', '2026-08-26']);
  assert.deepEqual(series.datasets[0].data, [15.1, 14.2, null]);
  assert.deepEqual(series.datasets[1].data, [null, 13.7, 13.1]);
});

test('Straddle Dynamics filters by optional intraday time range', () => {
  const docs = [
    document('2026-08-25', [
      { time: localIso(2026, 8, 25, 16, 40, 0), straddlePts: 15.1 },
      { time: localIso(2026, 8, 25, 16, 45, 0), straddlePts: 14.2 },
      { time: localIso(2026, 8, 25, 16, 50, 0), straddlePts: 13.9 }
    ])
  ];

  const bounded = buildDynamicsSeries(docs, { startTime: '16:45', endTime: '16:45' });
  const openEnded = buildDynamicsSeries(docs, { startTime: '16:45', endTime: '' });

  assert.deepEqual(bounded.labels, ['16:45']);
  assert.deepEqual(bounded.datasets[0].data, [14.2]);
  assert.deepEqual(openEnded.labels, ['16:45', '16:50']);
  assert.deepEqual(openEnded.datasets[0].data, [14.2, 13.9]);
});

test('snapshot widget config controls persist supported fields', () => {
  const widget = { config: {} };

  assert.equal(writeSnapshotWidgetConfigValue(widget, 'tenor', '1W'), true);
  assert.equal(writeSnapshotWidgetConfigValue(widget, 'time', '9:05:30'), true);
  assert.equal(writeSnapshotWidgetConfigValue(widget, 'startDate', '2026-08-25'), true);
  assert.equal(writeSnapshotWidgetConfigValue(widget, 'endDate', 'bad'), true);
  assert.equal(writeSnapshotWidgetConfigValue(widget, 'startTime', '10:01:30'), true);
  assert.equal(writeSnapshotWidgetConfigValue(widget, 'endTime', ''), true);
  assert.equal(writeSnapshotWidgetConfigValue(widget, 'settingsCollapsed', true), true);
  assert.equal(writeSnapshotWidgetConfigValue(widget, 'unknown', 'x'), false);

  assert.deepEqual(widget.config, {
    tenor: '1W',
    time: '09:05',
    startDate: '2026-08-25',
    endDate: '',
    startTime: '10:01',
    endTime: '',
    settingsCollapsed: true
  });
});

test('snapshot widget line controls persist line settings', () => {
  const widget = { config: { tenor: '0DTE', time: '16:45' } };

  assert.equal(addSnapshotWidgetLine(widget), true);
  assert.deepEqual(normalizeDailyLines(widget.config), [
    { tenor: '0DTE', offsetMinutes: 15 },
    { tenor: '0DTE', offsetMinutes: 15 }
  ]);
  assert.equal(writeSnapshotWidgetLineConfigValue(widget, 1, 'tenor', '1W'), true);
  assert.equal(writeSnapshotWidgetLineConfigValue(widget, 1, 'offsetMinutes', '30'), true);
  assert.equal(removeSnapshotWidgetLine(widget, 0), true);
  assert.equal(removeSnapshotWidgetLine(widget, 0), false);

  assert.deepEqual(widget.config.lines, [{ tenor: '1W', offsetMinutes: 30 }]);
  assert.equal(addSnapshotWidgetLine(widget), true);
  assert.deepEqual(widget.config.lines[1], { tenor: '1W', offsetMinutes: 30 });
  assert.equal(widget.config.tenor, undefined);
  assert.equal(widget.config.time, undefined);
});

test('snapshot widgets build empty data states', () => {
  assert.deepEqual(buildDailyPriceSeries([], { tenor: '0DTE', time: '16:45' }).datasets[0].data, []);
  assert.deepEqual(buildDynamicsSeries([]).datasets, []);
});

test('daily offsets follow US DST independently of Cyprus DST and the host timezone', () => {
  const dates = [
    ['2026-03-06', '14'], ['2026-03-09', '13'],
    ['2026-03-27', '13'], ['2026-03-30', '13'],
    ['2026-10-23', '13'], ['2026-10-26', '13'],
    ['2026-10-30', '13'], ['2026-11-02', '14']
  ];
  const docs = dates.map(([date, hour], index) => document(date, [
    { time: `${date}T${hour}:29:59Z`, straddlePts: 999 },
    { time: `${date}T${hour}:30:59.999Z`, straddlePts: index },
    { time: `${date}T${hour}:45:01Z`, straddlePts: index + 10 }
  ]));
  const previous = process.env.TZ;
  try {
    for (const timezone of ['Asia/Nicosia', 'UTC', 'America/New_York']) {
      process.env.TZ = timezone;
      const series = buildDailyPriceSeries(docs, { lines: [
        { tenor: '0DTE', offsetMinutes: 0 }, { tenor: '0DTE', offsetMinutes: 15 }
      ] });
      assert.deepEqual(series.labels, dates.map(([date]) => date));
      assert.deepEqual(series.datasets[0].data, dates.map((_, index) => index), timezone);
      assert.deepEqual(series.datasets[1].data, dates.map((_, index) => index + 10), timezone);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('daily price skips late-starting days and invalid timestamps', () => {
  const docs = [
    document('2026-10-26', [
      { time: '2026-10-26T17:00:07Z', straddlePts: 30 },
      { time: 'invalid', straddlePts: 99 },
      { time: null, straddlePts: 99 }
    ])
  ];
  assert.deepEqual(buildDailyPriceSeries(docs).labels, []);
});

test('daily price migration preserves tenors, line order and valid offsets and is idempotent', () => {
  const widget = { type: 'straddle-daily-price', config: {
    settingsCollapsed: true, tenor: '6M', time: '20:00', lines: [
      { tenor: '1W', time: '17:00' },
      { tenor: '0DTE', offsetMinutes: 0, time: '16:30' },
      { tenor: '1M', offsetMinutes: 30 },
      { tenor: '2W', offsetMinutes: -1 }
    ]
  } };
  assert.equal(migrateDailyPriceWidgetConfig(widget), true);
  assert.deepEqual(widget.config, { settingsCollapsed: true, lines: [
    { tenor: '1W', offsetMinutes: 15 }, { tenor: '0DTE', offsetMinutes: 0 },
    { tenor: '1M', offsetMinutes: 30 }, { tenor: '2W', offsetMinutes: 15 }
  ] });
  assert.equal(migrateDailyPriceWidgetConfig(widget), false);
  const single = { type: 'straddle-daily-price', config: { tenor: '3M', time: '19:00' } };
  migrateDailyPriceWidgetConfig(single);
  assert.deepEqual(single.config, { lines: [{ tenor: '3M', offsetMinutes: 15 }] });
  const dynamics = { type: 'straddle-dynamics', config: { tenor: '1W', startTime: '09:30' } };
  assert.equal(migrateDailyPriceWidgetConfig(dynamics), false);
  assert.deepEqual(dynamics.config, { tenor: '1W', startTime: '09:30' });
});

test('daily offset edits reject invalid values and retain zero', () => {
  const widget = { config: { lines: [{ tenor: '0DTE', offsetMinutes: 30 }] } };
  for (const value of ['', ' ', '-1', '1.5', 'bad', 'Infinity', null, undefined, true, '9007199254740992']) {
    assert.equal(writeSnapshotWidgetLineConfigValue(widget, 0, 'offsetMinutes', value), false);
    assert.equal(widget.config.lines[0].offsetMinutes, 30);
  }
  assert.equal(writeSnapshotWidgetLineConfigValue(widget, 0, 'offsetMinutes', '0'), true);
  assert.equal(widget.config.lines[0].offsetMinutes, 0);
});

test('daily UI publishes migrated config and restores the previous input on invalid edits', async () => {
  const previousWindow = globalThis.window;
  let changeHandler;
  let changes = 0;
  let published;
  const input = { value: '15', dataset: { straddleSnapshotLineIndex: '0', straddleSnapshotLineParam: 'offsetMinutes' },
    addEventListener: (_, handler) => { changeHandler = handler; } };
  const status = {};
  const container = {
    innerHTML: '',
    querySelectorAll: (selector) => selector === '[data-straddle-snapshot-line-param]' ? [input] : [],
    querySelector: (selector) => selector === '.straddle-snapshot-status' ? status : null
  };
  globalThis.window = { appBridge: { loadAtmStraddleSnapshots: async () => ({ ok: true, documents: [] }) } };
  const widget = { type: 'straddle-daily-price', config: { tenor: '1W', time: '18:00' } };
  try {
    await straddleDailyPriceWidget.render({ container, widget,
      widgetData: { publish: (value) => { published = value; } },
      onConfigChange: () => { changes++; }
    });
    assert.match(container.innerHTML, /Minutes from open/);
    assert.match(container.innerHTML, /type="number" min="0" step="1"/);
    assert.match(container.innerHTML, /Session open: 09:30 America\/New_York/);
    assert.deepEqual(published.config.lines, [{ tenor: '1W', offsetMinutes: 15 }]);
    assert.equal('time' in published.config, false);
    assert.deepEqual(widget.config.lines, published.config.lines);
    input.value = '1.5';
    changeHandler({ target: input });
    assert.equal(input.value, '15');
    assert.equal(changes, 0);
    input.value = '0';
    changeHandler({ target: input });
    assert.equal(changes, 1);
    assert.equal(widget.config.lines[0].offsetMinutes, 0);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
