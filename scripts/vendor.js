// Copies the webapp's third-party browser files from node_modules into
// public/vendor, which Signal K serves as-is: the webapp has no build step and
// must not depend on a CDN, since a boat is usually offline.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'public', 'vendor');

const files = [
  ['node_modules/signalk-plotterext-bus/LICENSE', 'plotterext-LICENSE'],
  ['node_modules/htm/preact/standalone.module.js', 'preact-htm.mjs'],
  ['node_modules/htm/LICENSE', 'htm-LICENSE'],
  // The htm standalone build bundles Preact.
  ['node_modules/preact/LICENSE', 'preact-LICENSE'],
  // Encoder and muxer for the animation's MP4 export: one self-contained ES
  // module, loaded only when a video is actually exported. MPL-2.0, so the
  // licence travels with it.
  ['node_modules/mediabunny/dist/bundles/mediabunny.min.mjs', 'mediabunny.min.mjs'],
  ['node_modules/mediabunny/LICENSE', 'mediabunny-LICENSE'],
  ['node_modules/leaflet/dist/leaflet.js', 'leaflet/leaflet.js'],
  ['node_modules/leaflet/dist/leaflet.css', 'leaflet/leaflet.css'],
  ['node_modules/leaflet/dist/images', 'leaflet/images'],
  ['node_modules/leaflet/LICENSE', 'leaflet/LICENSE'],
  // The 3D animation's engine is bundled below; its licence travels with it.
  ['node_modules/three/LICENSE', 'three-LICENSE']
];

fs.rmSync(vendor, { recursive: true, force: true });
for (const [source, target] of files) {
  const destination = path.join(vendor, target);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(path.join(root, source), destination, { recursive: true });
}

// The extension client ships split modules: bundle it for the offline tablet.
require('esbuild').buildSync({
  stdin: {
    contents: "export { connectExtension, windowPort } from 'signalk-plotterext-bus/extension'",
    resolveDir: root
  },
  bundle: true,
  format: 'esm',
  minify: true,
  outfile: path.join(vendor, 'plotterext.mjs')
});

// three.js ships as a split build with add-ons that import the bare specifier
// 'three', so it cannot be copied as it is. Bundle the few parts the 3D
// animation uses into one minified ES module, loaded only when that view is.
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'scripts', 'three-entry.mjs')],
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'none',
  outfile: path.join(vendor, 'three.min.mjs')
});
