import test from 'node:test';
import assert from 'node:assert/strict';
import atmStraddleSnapshotPlugin from '../src/plugins/atm-straddle-snapshot/manifest.js';
import {
  addSnapshotWidgetLine,
  buildDailyPriceSeries,
  buildDynamicsSeries,
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
  assert.deepEqual(straddleDailyPriceWidget.defaultConfig.lines, [{ tenor: '0DTE', time: '16:45' }]);
  assert.equal(straddleDynamicsWidget.defaultConfig.tenor, '0DTE');
});

test('Straddle Daily Price matches exact local HH:mm and ignores seconds', () => {
  const docs = [
    document('2026-08-25', [
      { time: localIso(2026, 8, 25, 16, 45, 59), straddlePts: 12.4 }
    ]),
    document('2026-08-26', [
      { time: localIso(2026, 8, 26, 16, 45, 1), straddlePts: 13.8 }
    ])
  ];

  const series = buildDailyPriceSeries(docs, { tenor: '0DTE', time: '16:45' });

  assert.deepEqual(series.labels, ['2026-08-25', '2026-08-26']);
  assert.deepEqual(series.datasets[0].data, [12.4, 13.8]);
  assert.equal(series.datasets[0].pointMeta[0].localMinute, '16:45');
  assert.equal(series.datasets[0].pointMeta[0].sourceFile, '2026-08-25-0DTE.json');
});

test('Straddle Daily Price skips days without an exact minute match', () => {
  const docs = [
    document('2026-08-25', [
      { time: localIso(2026, 8, 25, 16, 40, 0), straddlePts: 15.1 }
    ]),
    document('2026-08-26', [
      { time: localIso(2026, 8, 26, 16, 45, 30), straddlePts: 14.2 }
    ])
  ];

  const series = buildDailyPriceSeries(docs, { tenor: '0DTE', time: '16:45' });

  assert.deepEqual(series.labels, ['2026-08-26']);
  assert.deepEqual(series.datasets[0].data, [14.2]);
});

test('Straddle Daily Price builds one dataset per configured line', () => {
  const docs = [
    document('2026-08-25', [
      { time: localIso(2026, 8, 25, 16, 45, 0), straddlePts: 12.4 },
      { time: localIso(2026, 8, 25, 17, 0, 0), straddlePts: 11.9 }
    ], '0DTE'),
    document('2026-08-26', [
      { time: localIso(2026, 8, 26, 16, 45, 0), straddlePts: 13.2 }
    ], '0DTE'),
    document('2026-08-25', [
      { time: localIso(2026, 8, 25, 17, 0, 0), straddlePts: 27.1 }
    ], '1W')
  ];

  const series = buildDailyPriceSeries(docs, {
    lines: [
      { tenor: '0DTE', time: '16:45' },
      { tenor: '1W', time: '17:00' }
    ]
  });

  assert.deepEqual(series.labels, ['2026-08-25', '2026-08-26']);
  assert.deepEqual(series.datasets.map((dataset) => dataset.label), ['0DTE @ 16:45', '1W @ 17:00']);
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
    { tenor: '0DTE', time: '16:45' },
    { tenor: '0DTE', time: '16:45' }
  ]);
  assert.equal(writeSnapshotWidgetLineConfigValue(widget, 1, 'tenor', '1W'), true);
  assert.equal(writeSnapshotWidgetLineConfigValue(widget, 1, 'time', '9:05:30'), true);
  assert.equal(removeSnapshotWidgetLine(widget, 0), true);
  assert.equal(removeSnapshotWidgetLine(widget, 0), false);

  assert.deepEqual(widget.config.lines, [{ tenor: '1W', time: '09:05' }]);
  assert.equal(widget.config.tenor, undefined);
  assert.equal(widget.config.time, undefined);
});

test('snapshot widgets build empty data states', () => {
  assert.deepEqual(buildDailyPriceSeries([], { tenor: '0DTE', time: '16:45' }).datasets[0].data, []);
  assert.deepEqual(buildDynamicsSeries([]).datasets, []);
});
