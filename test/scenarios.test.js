const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { play, scenarioFiles } = require('./scenarios/player');

// The shared scenarios (test/scenarios/README.md): each result must still be what the logbook
// engine makes of its scenario. A rule changed on purpose is recorded again with
// `npm run scenarios`, and the diff of the results is reviewed with the change.
describe('shared scenarios', () => {
  const directory = path.join(__dirname, 'scenarios');
  for (const name of scenarioFiles(directory)) {
    const scenario = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    it(`${name}: ${scenario.description}`, () => {
      const expected = JSON.parse(
        fs.readFileSync(path.join(directory, name.replace(/\.json$/, '.result.json')), 'utf8')
      );
      assert.deepEqual(play(scenario), expected);
    });
  }
});
