const {
  attachTapeContractAtmPrice,
  createTapeContractStore,
  startTapeContractReceiver
} = require('./receiver.cjs');

function activateTapeContractDataSource(context = {}) {
  const store = createTapeContractStore();
  const receiver = startTapeContractReceiver({ store });
  receiver.on('error', (err) => console.warn('Tape contract receiver failed', err));

  const removeHandler = context?.ipc?.handle?.('tape-contract:get-snapshot', async (_evt, params) => {
    const measure = context?.profiler?.measure;
    const loadSnapshot = () => Promise.resolve(attachTapeContractAtmPrice(store.drainSnapshot()));
    if (typeof measure === 'function') {
      return measure('tape-contract:get-snapshot', { root: params?.root }, loadSnapshot);
    }
    return loadSnapshot();
  });

  return () => {
    if (typeof removeHandler === 'function') removeHandler();
    receiver.close();
  };
}

module.exports = {
  activateTapeContractDataSource
};
