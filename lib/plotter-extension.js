const { version } = require('../package.json');

const EXTENSION_ID = 'signalk-chiplog';

function buildManifest() {
  return {
    name: 'Chiplog — Helm entry',
    description: 'Log manoeuvres, notes and handwriting without leaving the chart.',
    version,
    apiVersion: '1',
    requires: ['panels.iframe', 'buttons'],
    optional: ['nightMode'],
    panels: [
      {
        id: 'helm-entry',
        title: 'Chiplog',
        type: 'iframe',
        url: '/signalk-chiplog/entry/?plotterExtension=1',
        lifecycle: 'keepAlive'
      }
    ],
    buttons: [
      {
        id: 'open-helm-entry',
        title: 'Chiplog',
        slot: 'mapToolbar',
        icon: 'edit_note',
        action: { type: 'togglePanel', panel: 'helm-entry' }
      }
    ]
  };
}

function registerPlotterExtension(app, isRunning) {
  // Older servers can still run the standalone logbook and tablet app.
  if (typeof app.registerResourceProvider !== 'function') {
    return;
  }
  app.registerResourceProvider({
    type: 'plotterExtensions',
    methods: {
      listResources: async () => (isRunning() ? { [EXTENSION_ID]: buildManifest() } : {}),
      getResource: async (id) => {
        if (!isRunning() || id !== EXTENSION_ID) {
          throw new Error(`No such plotterExtensions resource: ${id}`);
        }
        return buildManifest();
      },
      setResource: async () => {
        throw new Error('Chiplog plotter extension is read-only');
      },
      deleteResource: async () => {
        throw new Error('Chiplog plotter extension is read-only');
      }
    }
  });
}

module.exports = { registerPlotterExtension };
