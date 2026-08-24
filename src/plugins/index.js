import atmStraddleSnapshotPlugin from './atm-straddle-snapshot/manifest.js';
import nDateStrikeClipboardPlugin from './ndate-strike-clipboard/manifest.js';

export const appPluginManifests = [
  atmStraddleSnapshotPlugin,
  nDateStrikeClipboardPlugin
];

export function activateAppPlugins(manifests, context) {
  const cleanups = [];
  for (const manifest of Array.isArray(manifests) ? manifests : []) {
    if (typeof manifest?.activate !== 'function') continue;
    try {
      const cleanup = manifest.activate(context);
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    } catch (err) {
      console.warn(`Failed to activate plugin ${manifest?.id || 'unknown'}`, err);
    }
  }
  return () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (err) {
        console.warn('Failed to deactivate plugin cleanup', err);
      }
    }
  };
}
