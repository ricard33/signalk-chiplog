const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const chiplog = require('../index');

describe('plugin configuration schema', () => {
  const { properties, dependencies } = chiplog({}).schema;
  const legacy = dependencies.retrospectiveHistorySource.oneOf.find(
    (branch) => branch.properties?.retrospectiveHistorySource?.const === 'influxdb1'
  );

  it('shows the InfluxDB connection only when the legacy source is selected', () => {
    assert.ok(properties.retrospectiveHistorySource);
    assert.equal(properties.influxHost, undefined);

    assert.ok(legacy, 'the legacy InfluxDB branch is conditional');
    assert.ok(legacy.properties.influxHost);
    assert.ok(legacy.properties.influxDatabase);
  });

  it('keeps the settings that apply to either source out of that branch', () => {
    for (const key of ['influxQueryTimeoutSeconds', 'influxSelfContext']) {
      assert.ok(properties[key], `${key} is always shown`);
      assert.equal(legacy.properties[key], undefined, `${key} is not repeated in the branch`);
    }
  });

  it('defaults to the legacy source, so an existing installation is untouched', () => {
    assert.equal(properties.retrospectiveHistorySource.default, 'influxdb1');
    assert.deepEqual(properties.retrospectiveHistorySource.enum, ['influxdb1', 'signalk']);
  });
});
