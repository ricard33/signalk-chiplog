const { registerRoutes } = require('./lib/api');
const { openDatabase } = require('./lib/database');
const { createPassageDetector, DETECTION_DEFAULTS, TICK_INTERVAL_MS } = require('./lib/detection');
const { ApiError } = require('./lib/errors');
const { createBackgroundSchedule } = require('./lib/background-schedule');
const { createEventWatcher, CHECK_INTERVAL_MS, EVENT_DEFAULTS } = require('./lib/event-watcher');
const { INFLUX_DEFAULTS } = require('./lib/influx-history');
const { createLandmarkFinder, LANDMARK_DEFAULTS } = require('./lib/landmark-finder');
const { OBSERVATION_DEFAULTS } = require('./lib/observation-recorder');
const { createPlaceNamer, GEOCODING_DEFAULTS } = require('./lib/place-names');
const { PROPULSION_DEFAULTS } = require('./lib/propulsion-detector');
const { createReplayJob } = require('./lib/replay-job');
const { createTideForecaster, TIDE_DEFAULTS } = require('./lib/tide-forecaster');
const { createWeatherForecaster, WEATHER_DEFAULTS } = require('./lib/weather-forecaster');
const { createTrackRecorder, SAMPLE_INTERVAL_MS, TRACK_DEFAULTS } = require('./lib/track-recorder');
const {
  createUsbExportScheduler,
  CHECK_INTERVAL_MS: USB_CHECK_INTERVAL_MS,
  USB_EXPORT_DEFAULTS
} = require('./lib/usb-scheduler');

const { isTimeZone, PDF_LANGUAGES } = require('./lib/logbook-pdf');

const { version } = require('./package.json');

const DEFAULT_PLACE_MATCH_RADIUS = 200;
const FIRST_NAMING_DELAY_MS = 5 * 1000;
const NAMING_ERROR_RETRY_MS = 5 * 60 * 1000;
const FIRST_FORECAST_DELAY_MS = 5 * 1000;
// Landmarks are not needed for the passage under way, only for reading it back,
// so the first lookup waits for the busier start-up work to be done.
const FIRST_LANDMARK_DELAY_MS = 30 * 1000;

const MOTION_LABELS = { underway: 'Under way', stopped: 'Stopped', unknown: 'Waiting for data' };
const MODE_LABELS = { autostate: 'navigation.state', fallback: 'speed fallback' };

function readVesselPosition(app) {
  const value = app.getSelfPath('navigation.position')?.value;
  return value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
    ? { lat: value.latitude, lon: value.longitude }
    : null;
}

// Signal K keeps the vessel name as a plain value, not a {value, timestamp} node.
function readVesselName(app) {
  const name = app.getSelfPath('name');
  const text = typeof name === 'string' ? name : name?.value;
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : null;
}

function describeDetection({ mode, motion, propulsion, activeEntryId }) {
  const under = propulsion === null ? '' : ` under ${propulsion}`;
  const passage = activeEntryId === null ? '' : `, passage ${activeEntryId} open`;
  return `${MOTION_LABELS[motion]}${under}${passage} (${MODE_LABELS[mode]})`;
}

module.exports = function (app) {
  const plugin = {};
  let database = null;
  let settings = null;
  let detector = null;
  let namer = null;
  let schedules = [];
  // The open passage detection last reported, to notice a new one.
  let lastActiveEntryId = null;
  let usbExport = null;
  let replayJob = null;
  let namingTimer = null;
  let timers = [];
  let lastStatus = null;

  plugin.id = 'signalk-chiplog';
  plugin.name = 'Chiplog';
  plugin.description = 'Automated digital logbook for Signal K';

  plugin.schema = {
    type: 'object',
    properties: {
      stopClosureMinutes: {
        type: 'number',
        title: 'Stop duration within which a new departure continues the passage (minutes)',
        description:
          'A passage closes as soon as the boat stops; leaving again sooner than this, after waiting for a lock or a lunch anchorage, reopens it and keeps the stop as a stopover',
        default: DETECTION_DEFAULTS.stopClosureMinutes,
        minimum: 1
      },
      fallbackUnderwaySpeed: {
        type: 'number',
        title: 'Under-way speed when navigation.state is unavailable (knots)',
        description:
          'Used only without signalk-autostate: the vessel counts as under way when its average speed over ground exceeds this, and as stopped below half of it',
        default: DETECTION_DEFAULTS.fallbackUnderwaySpeed,
        minimum: 0.1
      },
      defaultPropulsion: {
        type: 'string',
        title: 'Propulsion assumed without engine data',
        description:
          'Used when neither propulsion.*.revolutions, propulsion.*.state nor navigation.state says whether the engine is running',
        enum: ['sail', 'engine'],
        default: PROPULSION_DEFAULTS.defaultPropulsion
      },
      observationIntervalMinutes: {
        type: 'number',
        title: 'Instrument snapshot interval (minutes)',
        description:
          'During a passage, instrument readings are logged on this clock boundary — on the hour by default — as well as at departure, arrival and each manoeuvre',
        default: OBSERVATION_DEFAULTS.observationIntervalMinutes,
        minimum: 1
      },
      trackIntervalSeconds: {
        type: 'number',
        title: 'Track point interval (seconds)',
        description:
          'A track point is recorded at least this often while moving, plus extra points on turns and speed changes',
        default: TRACK_DEFAULTS.trackIntervalSeconds,
        minimum: 1
      },
      placeMatchRadius: {
        type: 'number',
        title: 'Place matching radius (m)',
        description: 'A departure or arrival within this distance of a known place reuses its name',
        default: DEFAULT_PLACE_MATCH_RADIUS,
        minimum: 1
      },
      geocodingEnabled: {
        type: 'boolean',
        title: 'Name departures and arrivals with online geocoding',
        description:
          "Sends the position of departures and arrivals that match no known place to the geocoding service below. Names come from OpenStreetMap (© OpenStreetMap contributors, ODbL). Without it, they're named after their coordinates until corrected",
        default: GEOCODING_DEFAULTS.geocodingEnabled
      },
      geocodingUrl: {
        type: 'string',
        title: 'Geocoding service (Nominatim-compatible)',
        description: 'The public OpenStreetMap instance by default, or a self-hosted Nominatim',
        default: GEOCODING_DEFAULTS.geocodingUrl
      },
      landmarksEnabled: {
        type: 'boolean',
        title: 'Read each journal line against the nearest landmark',
        description:
          'Fetches the lighthouses, capes, towers and harbours of the areas sailed through from OpenStreetMap, so every position in the logbook is also given as a bearing and distance from the nearest one (© OpenStreetMap contributors, ODbL). Without it, only the coordinates are shown',
        default: LANDMARK_DEFAULTS.landmarksEnabled
      },
      overpassUrl: {
        type: 'string',
        title: 'Landmark service (Overpass API)',
        description: 'The public Overpass instance by default, or a self-hosted one',
        default: LANDMARK_DEFAULTS.overpassUrl
      },
      tidesEnabled: {
        type: 'boolean',
        title: 'Fetch the tide forecast at departure',
        description:
          'Sends the departure position to the tide service below for the next 24 hours of predicted water height. Data comes from Open-Meteo (CC BY 4.0)',
        default: TIDE_DEFAULTS.tidesEnabled
      },
      tideUrl: {
        type: 'string',
        title: 'Marine service (Open-Meteo Marine-compatible)',
        description:
          'Tides, and waves, swell, sea temperature and current for the weather forecast. The public Open-Meteo instance by default, or a self-hosted one',
        default: TIDE_DEFAULTS.tideUrl
      },
      weatherEnabled: {
        type: 'boolean',
        title: 'Fetch the marine weather forecast at departure',
        description:
          'Sends the departure position to the weather service below and to the marine service above for the next 24 hours of wind, sky, sea state and current. Data comes from Open-Meteo (CC BY 4.0)',
        default: WEATHER_DEFAULTS.weatherEnabled
      },
      weatherUrl: {
        type: 'string',
        title: 'Weather service (Open-Meteo-compatible)',
        description: 'The public Open-Meteo instance by default, or a self-hosted one',
        default: WEATHER_DEFAULTS.weatherUrl
      },
      usbExportPath: {
        type: 'string',
        title: 'USB export directory',
        description:
          'Directory the logbook is copied to for abandon-ship recovery, e.g. the mount point of a USB drive. Leave empty to turn the USB copy off'
      },
      usbExportIntervalMinutes: {
        type: 'number',
        title: 'Automatic USB copy interval (minutes)',
        description:
          'Passages new or changed since the last copy are written to the USB drive this often; 0 turns the periodic copy off',
        default: USB_EXPORT_DEFAULTS.usbExportIntervalMinutes,
        minimum: 0
      },
      usbExportOnArrival: {
        type: 'boolean',
        title: 'Copy to the USB drive at each arrival',
        default: USB_EXPORT_DEFAULTS.usbExportOnArrival
      },
      logbookLanguage: {
        type: 'string',
        title: 'Logbook language (PDF)',
        description:
          'Language of the PDF logbook written to the USB drive; downloads from the webapp use the webapp language',
        enum: PDF_LANGUAGES,
        default: 'en'
      },
      logbookTimeZone: {
        type: 'string',
        title: 'Ship’s time zone (PDF)',
        description:
          'IANA time zone the PDF logbook on the USB drive is kept in, e.g. Europe/Paris. Empty uses the server’s time zone; downloads from the webapp use the browser’s'
      },
      windSpeedThresholds: {
        type: 'array',
        title: 'Wind speed thresholds (knots)',
        description:
          'The log records when the true wind, averaged over two minutes, rises above or falls back below each of these speeds',
        items: { type: 'number', minimum: 1 },
        default: EVENT_DEFAULTS.windSpeedThresholds
      },
      pressureDropThreshold: {
        type: 'number',
        title: 'Barometric drop warning (hPa over 3 hours)',
        description:
          'The log records a pressure fall of at least this much over three hours; 0 disables it',
        default: EVENT_DEFAULTS.pressureDropThreshold,
        minimum: 0
      },
      headingChangeEnabled: {
        type: 'boolean',
        title: 'Log heading changes',
        description:
          'Records a course change once it is held; turn off to leave heading changes out of the log',
        default: EVENT_DEFAULTS.headingChangeEnabled
      },
      headingChangeThreshold: {
        type: 'number',
        title: 'Heading change threshold (degrees)',
        description: 'A change must be at least this large to be logged',
        default: EVENT_DEFAULTS.headingChangeThreshold,
        minimum: 1,
        maximum: 180
      },
      headingChangeTolerance: {
        type: 'number',
        title: 'Heading change tolerance (degrees)',
        description: 'How much the new heading may wander while holding and still count as steady',
        default: EVENT_DEFAULTS.headingChangeTolerance,
        minimum: 0
      },
      headingChangeHoldSeconds: {
        type: 'number',
        title: 'Heading change hold time (seconds)',
        description: 'How long the new heading must hold before it is logged',
        default: EVENT_DEFAULTS.headingChangeHoldSeconds,
        minimum: 1
      },
      headingChangeMinSpeed: {
        type: 'number',
        title: 'Heading change minimum speed (knots)',
        description: 'Below this speed over ground, the course is too noisy to log a change',
        default: EVENT_DEFAULTS.headingChangeMinSpeed,
        minimum: 0
      },
      headingChangeCooldownMinutes: {
        type: 'number',
        title: 'Heading change cooldown (minutes)',
        description: 'A new change is logged only once the last one is at least this old',
        default: EVENT_DEFAULTS.headingChangeCooldownMinutes,
        minimum: 0
      },
      retrospectiveHistorySource: {
        type: 'string',
        title: 'History source for retrospective analysis',
        description:
          'Signal K reads the server’s own History API provider (signalk-to-influxdb2, for example), needing no database connection of its own — the better choice on a new installation. InfluxDB 1.x keeps the legacy direct database reader, and stays the default so installations already set up that way go on working untouched.',
        enum: ['influxdb1', 'signalk'],
        enumNames: ['InfluxDB 1.x (legacy)', 'Signal K History API'],
        default: 'influxdb1'
      },
      influxQueryTimeoutSeconds: {
        type: 'number',
        title: 'Retrospective query timeout (seconds)',
        description:
          'Each retrospective query is given up on and reported as an error past this, rather than hanging indefinitely against an unreachable or overloaded history. Applies to either history source',
        default: INFLUX_DEFAULTS.influxQueryTimeoutSeconds,
        minimum: 1
      },
      influxSelfContext: {
        type: 'string',
        title: 'Vessel context (retrospective analysis)',
        description:
          'Only needed running the replay from a different Signal K server than the one that wrote the history — e.g. a development instance pointed at a boat’s production database. The vessel context the data was tagged with, such as "vessels.urn:mrn:imo:mmsi:123456789"; a failed replay names the contexts actually found. Leave empty to use this server’s own (Signal K → Server → Vessel Identity). Applies to either history source'
      }
    },
    // RJSF evaluates dependencies each time the selector changes. Keeping the
    // InfluxDB fields out of the top-level properties hides them in History
    // API mode and inserts them immediately after the source selector.
    dependencies: {
      retrospectiveHistorySource: {
        oneOf: [
          {
            properties: {
              retrospectiveHistorySource: { const: 'influxdb1' },
              influxHost: {
                type: 'string',
                title: 'InfluxDB host (retrospective analysis)',
                description:
                  'For reconstructing past passages from a signalk-to-influxdb history (InfluxDB 1.x), local or remote. Leave empty to turn that feature off'
              },
              influxPort: {
                type: 'number',
                title: 'InfluxDB port',
                default: INFLUX_DEFAULTS.influxPort
              },
              influxDatabase: {
                type: 'string',
                title: 'InfluxDB database'
              },
              influxUsername: {
                type: 'string',
                title: 'InfluxDB username',
                description: 'Leave empty if the database needs none'
              },
              influxPassword: {
                type: 'string',
                title: 'InfluxDB password',
                format: 'password'
              },
              influxProtocol: {
                type: 'string',
                title: 'InfluxDB protocol',
                enum: ['http', 'https'],
                default: INFLUX_DEFAULTS.influxProtocol
              }
            }
          },
          {
            properties: {
              retrospectiveHistorySource: { const: 'signalk' }
            }
          }
        ]
      }
    }
  };

  function runDetection() {
    // A retrospective replay drives the same detector against a past window,
    // holding its own passage 'active' in log_entries for as long as it takes
    // to close it there — live detection, track sampling and event watching
    // must not touch that row in the meantime, or a live tick would treat a
    // reconstructed passage as the current one and close it early or splice
    // live data into it.
    if (replayJob?.status().running) {
      const status = 'Retrospective replay in progress — live tracking paused';
      if (status !== lastStatus) {
        app.setPluginStatus(status);
        lastStatus = status;
      }
      return;
    }
    try {
      const outcome = detector.tick();
      usbExport.afterDetection(outcome);
      // A passage just opened: fetch its forecasts and the landmarks of where
      // it is starting from now, not at the next idle poll or at the end of a
      // retry delay left from an earlier failure.
      if (outcome.activeEntryId !== null && outcome.activeEntryId !== lastActiveEntryId) {
        schedules.forEach((schedule) => schedule.nudge());
      }
      lastActiveEntryId = outcome.activeEntryId;
      const usbError = usbExport.status().lastError;
      const status = `${describeDetection(outcome)}${usbError ? ` — USB copy failing: ${usbError.message}` : ''}`;
      if (status !== lastStatus) {
        app.setPluginStatus(status);
        lastStatus = status;
      }
    } catch (err) {
      lastStatus = null;
      app.error(`Passage detection failed: ${err.stack ?? err}`);
      app.setPluginError(`Passage detection failed: ${err.message}`);
    }
  }

  // A retrospective replay can create newly-pending place names; wake the
  // naming chain immediately rather than leave it to whatever backoff it
  // was already in. Guarded against the plugin having stopped in the
  // meantime, since a replay runs in the background and isn't awaited.
  function nudgeNaming() {
    if (!namer) {
      return;
    }
    clearTimeout(namingTimer);
    namingTimer = setTimeout(runNaming, 0);
  }

  // Geocoding is a network call, so it runs as its own chain of timeouts rather
  // than inside detection: each lookup says when the next one is due.
  async function runNaming() {
    const current = namer;
    let result;
    try {
      result = await current.resolveNext();
    } catch (err) {
      app.error(`Place naming failed: ${err.stack ?? err}`);
      result = { retryInMs: NAMING_ERROR_RETRY_MS };
    }
    if (namer !== current || result.outcome === 'stopped') {
      return;
    }
    if (result.outcome === 'failed') {
      // Expected whenever the boat is out of reach of a network.
      app.debug(
        `Geocoding unavailable, retrying in ${Math.round(result.retryInMs / 60000)} min: ${result.error.message}`
      );
    }
    namingTimer = setTimeout(runNaming, result.retryInMs);
  }

  // For work that runs every second: log a failure once, not on every run.
  function guarded(label, work) {
    let failing = false;
    return () => {
      try {
        work();
        failing = false;
      } catch (err) {
        if (!failing) {
          app.error(`${label} failed: ${err.stack ?? err}`);
        }
        failing = true;
      }
    };
  }

  const pdfOptions = () => ({
    language: settings.logbookLanguage,
    timeZone: settings.logbookTimeZone ?? undefined,
    vesselName: readVesselName(app),
    version
  });

  plugin.start = function (config = {}) {
    try {
      const { db, migrated } = openDatabase(app.getDataDirPath());
      database = db;
      settings = {
        stopClosureMinutes: config.stopClosureMinutes ?? DETECTION_DEFAULTS.stopClosureMinutes,
        fallbackUnderwaySpeed:
          config.fallbackUnderwaySpeed ?? DETECTION_DEFAULTS.fallbackUnderwaySpeed,
        defaultPropulsion: config.defaultPropulsion ?? PROPULSION_DEFAULTS.defaultPropulsion,
        observationIntervalMinutes:
          config.observationIntervalMinutes ?? OBSERVATION_DEFAULTS.observationIntervalMinutes,
        trackIntervalSeconds: config.trackIntervalSeconds ?? TRACK_DEFAULTS.trackIntervalSeconds,
        placeMatchRadius: config.placeMatchRadius ?? DEFAULT_PLACE_MATCH_RADIUS,
        geocodingEnabled: config.geocodingEnabled ?? GEOCODING_DEFAULTS.geocodingEnabled,
        geocodingUrl: config.geocodingUrl || GEOCODING_DEFAULTS.geocodingUrl,
        landmarksEnabled: config.landmarksEnabled ?? LANDMARK_DEFAULTS.landmarksEnabled,
        overpassUrl: config.overpassUrl || LANDMARK_DEFAULTS.overpassUrl,
        tidesEnabled: config.tidesEnabled ?? TIDE_DEFAULTS.tidesEnabled,
        tideUrl: config.tideUrl || TIDE_DEFAULTS.tideUrl,
        weatherEnabled: config.weatherEnabled ?? WEATHER_DEFAULTS.weatherEnabled,
        weatherUrl: config.weatherUrl || WEATHER_DEFAULTS.weatherUrl,
        usbExportPath: config.usbExportPath || null,
        usbExportIntervalMinutes:
          config.usbExportIntervalMinutes ?? USB_EXPORT_DEFAULTS.usbExportIntervalMinutes,
        usbExportOnArrival: config.usbExportOnArrival ?? USB_EXPORT_DEFAULTS.usbExportOnArrival,
        logbookLanguage: PDF_LANGUAGES.includes(config.logbookLanguage)
          ? config.logbookLanguage
          : 'en',
        logbookTimeZone: config.logbookTimeZone || null,
        windSpeedThresholds: config.windSpeedThresholds ?? EVENT_DEFAULTS.windSpeedThresholds,
        pressureDropThreshold: config.pressureDropThreshold ?? EVENT_DEFAULTS.pressureDropThreshold,
        headingChangeEnabled: config.headingChangeEnabled ?? EVENT_DEFAULTS.headingChangeEnabled,
        headingChangeThreshold:
          config.headingChangeThreshold ?? EVENT_DEFAULTS.headingChangeThreshold,
        headingChangeTolerance:
          config.headingChangeTolerance ?? EVENT_DEFAULTS.headingChangeTolerance,
        headingChangeHoldSeconds:
          config.headingChangeHoldSeconds ?? EVENT_DEFAULTS.headingChangeHoldSeconds,
        headingChangeMinSpeed: config.headingChangeMinSpeed ?? EVENT_DEFAULTS.headingChangeMinSpeed,
        headingChangeCooldownMinutes:
          config.headingChangeCooldownMinutes ?? EVENT_DEFAULTS.headingChangeCooldownMinutes,
        influxHost: config.influxHost || null,
        influxPort: config.influxPort ?? INFLUX_DEFAULTS.influxPort,
        influxDatabase: config.influxDatabase || null,
        influxUsername: config.influxUsername || null,
        influxPassword: config.influxPassword || null,
        influxProtocol: config.influxProtocol || INFLUX_DEFAULTS.influxProtocol,
        influxQueryTimeoutSeconds:
          config.influxQueryTimeoutSeconds ?? INFLUX_DEFAULTS.influxQueryTimeoutSeconds,
        influxSelfContext: config.influxSelfContext || null,
        retrospectiveHistorySource:
          config.retrospectiveHistorySource === 'signalk' ? 'signalk' : 'influxdb1'
      };

      if (settings.logbookTimeZone && !isTimeZone(settings.logbookTimeZone)) {
        app.error(
          `Unknown time zone "${settings.logbookTimeZone}" for the PDF logbook; using the server's`
        );
        settings.logbookTimeZone = null;
      }

      if (migrated.to > migrated.from) {
        app.debug(`Database schema migrated from version ${migrated.from} to ${migrated.to}`);
      }
    } catch (err) {
      app.setPluginError(`Cannot open the logbook database: ${err.message}`);
      throw err;
    }

    const readSelfPath = (path) => app.getSelfPath(path);
    detector = createPassageDetector({ db: database, readSelfPath, settings });
    const recorder = createTrackRecorder({ db: database, readSelfPath, settings });
    const watcher = createEventWatcher({
      db: database,
      readSelfPath,
      settings,
      observe: (entryId, time) => detector.observeEvent(entryId, time)
    });
    namer = createPlaceNamer({
      db: database,
      settings,
      userAgent: `signalk-chiplog/${version}`
    });
    usbExport = createUsbExportScheduler({
      db: database,
      settings,
      pdfOptions,
      log: (level, message) => (level === 'error' ? app.error(message) : app.debug(message))
    });
    replayJob = createReplayJob({
      db: database,
      settings,
      app,
      log: (level, message) => (level === 'error' ? app.error(message) : app.debug(message)),
      onDone: nudgeNaming
    });
    namingTimer = setTimeout(runNaming, FIRST_NAMING_DELAY_MS);
    // Same idea as geocoding: network calls fetching the tide and weather
    // forecasts near a recent departure, and the landmarks of the areas
    // sailed through, each on its own chain rather than inside detection.
    const networkOptions = { db: database, settings, userAgent: `signalk-chiplog/${version}` };
    const log = (level, message) => (level === 'error' ? app.error(message) : app.debug(message));
    lastActiveEntryId = null;
    schedules = [
      createBackgroundSchedule({
        label: 'Tide forecast',
        resolver: createTideForecaster(networkOptions),
        log,
        firstDelayMs: FIRST_FORECAST_DELAY_MS
      }),
      createBackgroundSchedule({
        label: 'Weather forecast',
        resolver: createWeatherForecaster(networkOptions),
        log,
        firstDelayMs: FIRST_FORECAST_DELAY_MS
      }),
      createBackgroundSchedule({
        label: 'Landmark lookup',
        resolver: createLandmarkFinder(networkOptions),
        log,
        firstDelayMs: FIRST_LANDMARK_DELAY_MS
      })
    ];
    lastStatus = null;
    runDetection();
    timers = [
      setInterval(runDetection, TICK_INTERVAL_MS),
      setInterval(
        guarded('Track recording', () => {
          if (!replayJob?.status().running) {
            recorder.sample();
          }
        }),
        SAMPLE_INTERVAL_MS
      ),
      setInterval(
        guarded('Event watching', () => {
          if (!replayJob?.status().running) {
            watcher.check();
          }
        }),
        CHECK_INTERVAL_MS
      ),
      setInterval(
        guarded('USB copy scheduling', () => usbExport.tick()),
        USB_CHECK_INTERVAL_MS
      )
    ];
  };

  plugin.stop = function () {
    timers.forEach(clearInterval);
    timers = [];
    clearTimeout(namingTimer);
    namer?.stop();
    namer = null;
    schedules.forEach((schedule) => schedule.stop());
    schedules = [];
    usbExport?.stop();
    usbExport = null;
    replayJob?.cancel();
    replayJob = null;
    detector = null;
    if (database) {
      database.close();
      database = null;
    }
  };

  // The server registers routes once, before start() and even while the plugin
  // is disabled, and never removes them: every request must check the database.
  plugin.registerWithRouter = function (router) {
    registerRoutes(router, {
      getContext() {
        if (!database) {
          throw new ApiError(
            503,
            'plugin_not_started',
            'Chiplog is not running; enable the plugin'
          );
        }
        return {
          db: database,
          config: settings,
          now: () => new Date().toISOString(),
          vesselPosition: () => readVesselPosition(app),
          observeEvent: (entryId, time) => detector.observeEvent(entryId, time),
          noteDeparture: (entryId) => detector.noteDeparture(entryId),
          usbExport,
          replayJob,
          pdfOptions,
          detection: () => ({
            mode: detector.mode(),
            motion: detector.motion(),
            propulsion: detector.propulsion(),
            stateIssue: detector.stateIssue()
          })
        };
      },
      logError: (err) => app.error(`API request failed: ${err.stack ?? err}`)
    });
  };

  return plugin;
};
