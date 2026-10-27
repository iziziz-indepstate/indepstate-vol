// Keep natural card heights while reserving enough one-pixel grid rows for each card.
export function mountWidgetGridLayout(grid) {
  const view = grid.ownerDocument.defaultView;
  if (!view?.ResizeObserver) return () => {};
  const cards = Array.from(grid.children);
  let frame = null;
  let disposed = false;

  function measure() {
    frame = null;
    if (disposed || !grid.isConnected) return;
    const styles = view.getComputedStyle(grid);
    const rowSize = Number.parseFloat(styles.gridAutoRows) || 1;
    const gap = Number.parseFloat(styles.getPropertyValue('--widget-grid-gap')) || 0;
    const spans = cards.map((card) => {
      const height = card.getBoundingClientRect().height;
      return height > 0 ? `span ${Math.ceil((height + gap) / rowSize)}` : null;
    });
    cards.forEach((card, index) => {
      if (spans[index] && card.style.gridRowEnd !== spans[index]) card.style.gridRowEnd = spans[index];
    });
  }

  const observer = new view.ResizeObserver(() => {
    if (!disposed && frame === null) frame = view.requestAnimationFrame(measure);
  });
  grid.classList.add('widget-grid-compact');
  measure();
  cards.forEach((card) => observer.observe(card, { box: 'border-box' }));

  return () => {
    disposed = true;
    observer.disconnect();
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    cards.forEach((card) => { card.style.gridRowEnd = ''; });
    grid.classList.remove('widget-grid-compact');
  };
}
