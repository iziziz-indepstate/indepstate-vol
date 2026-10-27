import test from 'node:test';
import assert from 'node:assert/strict';
import { mountWidgetGridLayout } from '../src/renderer/widget-grid-layout.js';

function fixture() {
  const frames = new Map();
  const classes = new Set();
  let notify, disconnected = false, nextFrame = 0;
  const card = { style: {}, getBoundingClientRect: () => ({ height: 300 }) };
  const grid = {
    children: [card], isConnected: true,
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    ownerDocument: { defaultView: {
      ResizeObserver: class {
        constructor(callback) { notify = callback; }
        observe() {}
        disconnect() { disconnected = true; }
      },
      getComputedStyle: () => ({ gridAutoRows: '1px', getPropertyValue: () => '10px' }),
      requestAnimationFrame: (fn) => { frames.set(++nextFrame, fn); return nextFrame; },
      cancelAnimationFrame: (id) => frames.delete(id)
    } }
  };
  return { grid, card, frames, classes, notify: () => notify(), disconnected: () => disconnected };
}

test('grid teardown cancels pending measurements and ignores callbacks from the old observer', () => {
  const f = fixture();
  const dispose = mountWidgetGridLayout(f.grid);
  f.notify(); f.notify();
  assert.equal(f.frames.size, 1);
  const staleFrame = [...f.frames.values()][0];
  dispose();
  assert.equal(f.frames.size, 0);
  assert.equal(f.disconnected(), true);
  assert.equal(f.classes.size, 0);
  assert.equal(f.card.style.gridRowEnd, '');
  f.notify(); staleFrame();
  assert.equal(f.frames.size, 0);
  assert.equal(f.card.style.gridRowEnd, '');
});

test('detached grids are not measured by pending callbacks', () => {
  const f = fixture();
  const dispose = mountWidgetGridLayout(f.grid);
  f.grid.isConnected = false;
  f.card.getBoundingClientRect = () => { throw new Error('Detached grid measured'); };
  f.notify();
  [...f.frames.values()][0]();
  dispose();
});

test('without ResizeObserver the normal responsive grid is retained', () => {
  const f = fixture();
  delete f.grid.ownerDocument.defaultView.ResizeObserver;
  const dispose = mountWidgetGridLayout(f.grid);
  assert.equal(f.classes.size, 0);
  assert.equal(f.card.style.gridRowEnd, undefined);
  dispose();
});
