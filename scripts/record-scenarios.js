// Plays every shared scenario (test/scenarios/*.json) on the plugin's logbook engine and
// writes what it made of each next to it (<name>.result.json). Run it after changing a logbook
// rule: the diff of the results shows what the change does, and test/scenarios.test.js keeps
// them current. A companion app can copy scenarios and results to check its own port.
//
//   npm run scenarios

const fs = require('node:fs');
const path = require('node:path');
const { play, scenarioFiles } = require('../test/scenarios/player');

const directory = path.join(__dirname, '..', 'test', 'scenarios');
const files = scenarioFiles(directory);
for (const name of files) {
  const scenario = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  fs.writeFileSync(
    path.join(directory, name.replace(/\.json$/, '.result.json')),
    `${JSON.stringify(play(scenario), null, 2)}\n`
  );
}
console.log(`Recorded ${files.length} scenarios`);
