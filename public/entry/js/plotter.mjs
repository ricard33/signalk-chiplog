import { connectExtension, windowPort } from '../../vendor/plotterext.mjs';

// An explicit opt-in leaves standalone and ordinary iframe use unchanged.
export const isPlotterExtension =
  window.parent !== window && new URLSearchParams(location.search).get('plotterExtension') === '1';

export async function connectPlotter(onNightChange) {
  const client = await connectExtension({
    port: windowPort(window.parent, { origin: location.origin }),
    timeoutMs: 5000
  });
  try {
    if (client.hasCapability('nightMode')) {
      // Subscribe first so a change during the initial read cannot be lost.
      let changed = false;
      await client.subscribe(['nightMode.changed'], (_name, state) => {
        changed = true;
        onNightChange(state.enabled);
      });
      const state = await client.call('nightMode.get');
      if (!changed) {
        onNightChange(state.enabled);
      }
    }
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
