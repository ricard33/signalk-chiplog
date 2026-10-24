import { html, render, useEffect, useMemo, useState } from '../../vendor/preact-htm.mjs';
import { connection, fetchAll, get, onResponse, request } from '../../js/api.mjs';
import { connectionProblem, watchConnection } from '../../js/connection.mjs';
import {
  createLocale,
  LocaleProvider,
  useConnection,
  useLocale,
  usePolling
} from '../../js/context.mjs';
import { randomId } from '../../js/ids.mjs';
import { pickLanguage } from '../../js/i18n.mjs';
import { createServerClock } from './clock.mjs';
import { createJournal } from './journal.mjs';
import { confirmAction } from './confirm.mjs';
import { connectPlotter, isPlotterExtension } from './plotter.mjs';
import { AccessGate } from './components/AccessGate.mjs';
import { EventDialog, Toast } from './components/Dialogs.mjs';
import { CrewDialog } from './components/CrewDialog.mjs';
import { PencilIcon } from './components/Icons.mjs';
import { ManoeuvrePad } from './components/ManoeuvrePad.mjs';
import { NotePanel } from './components/NotePanel.mjs';
import { RecentList } from './components/RecentList.mjs';
import { SketchPanel } from './components/SketchPanel.mjs';
import { StatusHeader } from './components/StatusHeader.mjs';

const STATE_REFRESH_MS = 15 * 1000;
const FLUSH_INTERVAL_MS = 10 * 1000;
const TOAST_MS = 10 * 1000;
const NIGHT_KEY = 'chiplog.night';
const TYPES_KEY = 'chiplog.manoeuvreTypes';
const CREW_KEY = 'chiplog.crew';

// The shortcuts shipped with the plugin, until the server's list has been seen
// once: an app started with no connection still has its buttons.
const BUILTIN_TYPES = [
  'tack',
  'gybe',
  'reef_in',
  'reef_out',
  'sail_change',
  'anchor_down',
  'anchor_up',
  'moor',
  'cast_off',
  'watch_change'
].map((key, index) => ({ key, label: key, sortOrder: (index + 1) * 10, enabled: true }));

function knownTypes() {
  try {
    const stored = JSON.parse(readSetting(TYPES_KEY) ?? 'null');
    return Array.isArray(stored) && stored.length > 0 ? stored : BUILTIN_TYPES;
  } catch {
    return BUILTIN_TYPES;
  }
}

function knownCrew() {
  try {
    const stored = JSON.parse(readSetting(CREW_KEY) ?? 'null');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readSetting(key) {
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    browserStorage()?.setItem(key, value);
  } catch {
    // A preference for this page only.
  }
}

const clock = createServerClock();
onResponse((response, sentAt, receivedAt) => {
  clock.observe(response.headers.get('date'), sentAt, receivedAt);
});

function App({ journal }) {
  const { t } = useLocale();
  const [state, setState] = useState(null);
  const [entry, setEntry] = useState(null);
  const [lastEntryId, setLastEntryId] = useState(null);
  const [types, setTypes] = useState(knownTypes);
  const [roster, setRoster] = useState(knownCrew);
  const link = useConnection();
  const [forbidden, setForbidden] = useState(false);
  const [queue, setQueue] = useState(journal.outbox.snapshot());
  const [toast, setToast] = useState(null);
  const [editing, setEditing] = useState(null);
  const [managingCrew, setManagingCrew] = useState(false);
  const [tab, setTab] = useState('note');
  const [night, setNight] = useState(readSetting(NIGHT_KEY) === 'on');
  const [plotter, setPlotter] = useState(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = () => setVersion((v) => v + 1);
  // The link itself is followed by `connection` (api.mjs), which every request
  // reports to; a refusal is this tablet lacking access, which the gate asks for.
  const online = link.state !== 'offline';

  const noteFailure = (error) => {
    if (error?.code === 'forbidden') {
      setForbidden(true);
    }
  };

  // Shows what was not done. Entries are queued rather than refused when the
  // link is down, so this is for corrections and the crew list.
  const showFailure = (error) => {
    noteFailure(error);
    const offline = connectionProblem(error) === 'offline';
    setToast({
      kind: 'error',
      reconnect: offline,
      message: offline ? t('entry.notDoneOffline') : t('entry.refused', { message: error.message })
    });
  };

  const flushQueue = async () => {
    if (journal.outbox.size === 0) {
      return;
    }
    const outcome = await journal.flush();
    noteFailure(outcome.blocked);
    if (outcome.sent.length > 0) {
      refresh();
    }
  };

  // Asked for by the crew: says so when the server still does not answer,
  // since nothing else on screen would change.
  const reconnect = async () => {
    const state = await connection.check();
    if (state === 'offline') {
      setToast({ kind: 'error', reconnect: true, message: t('entry.stillOffline') });
    } else if (toast?.reconnect) {
      setToast(null);
    }
  };

  useEffect(() => {
    journal.setListener(setQueue);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = night ? 'night' : '';
    writeSetting(NIGHT_KEY, night ? 'on' : 'off');
  }, [night]);

  useEffect(() => {
    if (!isPlotterExtension) {
      return undefined;
    }
    let active = true;
    let connection;
    connectPlotter((enabled) => active && setNight(enabled))
      .then((client) => {
        if (!active) {
          client.close();
          return;
        }
        connection = client;
        setPlotter(client);
      })
      // The tablet remains usable if the host cannot complete the handshake.
      .catch(() => {});
    return () => {
      active = false;
      connection?.close();
    };
  }, []);

  const toggleNight = async () => {
    const enabled = !night;
    if (plotter?.hasCapability('nightMode')) {
      try {
        await plotter.call('nightMode.set', { enabled, auto: false });
        setNight(enabled);
        return;
      } catch {
        // Keep the local night switch usable if the host stops answering.
      }
    }
    setNight(enabled);
  };

  useEffect(() => {
    if (!toast || toast.kind === 'error') {
      return undefined;
    }
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  usePolling(
    (isCurrent) => {
      get('/state')
        .then(async (next) => {
          const active =
            next.activeEntryId === null ? null : await get(`/entries/${next.activeEntryId}`);
          const last = active ? active.id : ((await get('/entries?limit=1')).items[0]?.id ?? null);
          if (isCurrent()) {
            setState(next);
            setEntry(active);
            setLastEntryId(last);
          }
        })
        .catch(noteFailure);
    },
    STATE_REFRESH_MS,
    [version]
  );

  usePolling(
    (isCurrent) => {
      fetchAll('/manoeuvre-types')
        .then((items) => {
          writeSetting(TYPES_KEY, JSON.stringify(items));
          if (isCurrent()) {
            setTypes(items);
          }
        })
        .catch(noteFailure);
    },
    0,
    [forbidden, link.restored]
  );

  usePolling(
    (isCurrent) => {
      fetchAll('/crew')
        .then((items) => {
          writeSetting(CREW_KEY, JSON.stringify(items));
          if (isCurrent()) {
            setRoster(items);
          }
        })
        .catch(noteFailure);
    },
    0,
    [forbidden, link.restored]
  );

  // Replays the queue while it holds anything, and as soon as the network is back.
  useEffect(() => {
    const timer = setInterval(flushQueue, FLUSH_INTERVAL_MS);
    window.addEventListener('online', flushQueue);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', flushQueue);
    };
  }, []);

  // And whenever the link comes back, along with the state it missed.
  useEffect(() => {
    flushQueue();
    if (link.restored > 0) {
      setForbidden(false);
      refresh();
    }
  }, [link.restored]);

  const manoeuvreLabels = useMemo(
    () => Object.fromEntries(types.map((type) => [type.key, type.label])),
    [types]
  );

  // Resolves to true once the entry is logged or safely queued.
  const log = async (body, what) => {
    setBusy(true);
    try {
      const outcome = await journal.log(body);
      if (outcome.status === 'queued') {
        noteFailure(outcome.error);
        setToast({ kind: 'logged', ref: outcome.ref, what, queued: true });
      } else {
        setToast({
          kind: 'logged',
          ref: outcome.ref,
          what,
          time: outcome.event.time,
          openedEntry: outcome.event.openedEntry
        });
        refresh();
      }
      return true;
    } catch (error) {
      setToast({
        kind: 'error',
        message:
          error.code === 'no_passage'
            ? t('entry.noPassageError')
            : t('entry.refused', { message: error.message })
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    const { ref } = toast;
    setToast({ kind: 'undone' });
    noteFailure(await journal.undo(ref));
    refresh();
  };

  const saveEvent = async (patch) => {
    const target = editing;
    setEditing(null);
    // A note is its text: emptying it would be a deletion, which has its own button.
    if (patch.comment === null && target.event?.type === 'text_annotation') {
      return;
    }
    if (Object.keys(patch).length === 0) {
      return;
    }
    try {
      if (target.ref) {
        noteFailure(await journal.edit(target.ref, patch));
      } else {
        await request('PATCH', `/events/${target.event.id}`, patch);
      }
      refresh();
    } catch (error) {
      showFailure(error);
    }
  };

  const deleteEvent = async (event) => {
    if (!(await confirmAction(t('entry.deleteConfirm'), t))) {
      return;
    }
    try {
      await request('DELETE', `/events/${event.id}`);
      refresh();
    } catch (error) {
      showFailure(error);
    }
  };

  const discard = (ref) => {
    journal.outbox.remove(ref);
  };

  const saveCrew = async (members) => {
    try {
      const updated = await request('PUT', `/entries/${entry.id}/crew`, { members });
      setEntry((current) => ({ ...current, crew: updated }));
      setManagingCrew(false);
      refresh();
    } catch (error) {
      showFailure(error);
    }
  };

  const addCrewMember = async (name, role) => {
    try {
      const member = await request('POST', '/crew', { name, role });
      setRoster((prev) => [...prev, member]);
      return member;
    } catch (error) {
      showFailure(error);
      return null;
    }
  };

  const editCrewMember = async (id, patch) => {
    try {
      const updated = await request('PATCH', `/crew/${id}`, patch);
      setRoster((prev) => prev.map((member) => (member.id === id ? updated : member)));
    } catch (error) {
      showFailure(error);
    }
  };

  const deleteCrewMember = async (id) => {
    try {
      await request('DELETE', `/crew/${id}`);
      setRoster((prev) => prev.filter((member) => member.id !== id));
      return true;
    } catch (error) {
      showFailure(error);
      return false;
    }
  };

  const editTitle = editing?.what ?? t('entry.comment');
  const bounds = entry ? { start: entry.startTime, end: entry.endTime } : null;

  return html`
    <${StatusHeader}
      state=${state}
      entry=${entry}
      online=${online}
      connecting=${link.checking}
      onReconnect=${reconnect}
      queued=${queue.pending.length}
      night=${night}
      onToggleNight=${toggleNight}
    />
    <main class="entry-main">
      ${
        (forbidden || link.state === 'signedOut') &&
        html`<${AccessGate}
          onGranted=${() => {
            setForbidden(false);
            connection.check();
            flushQueue();
            refresh();
          }}
        />`
      }
      <section class="panel crew-panel" aria-labelledby="crew-panel-title">
        <div class="panel-header">
          <h2 id="crew-panel-title" class="panel-title">${t('entry.crew')}</h2>
          <button
            type="button"
            class="tool-button icon-button"
            aria-label=${t('entry.editCrew')}
            title=${t('entry.editCrew')}
            disabled=${!entry}
            onClick=${() => setManagingCrew(true)}
          >
            <${PencilIcon} />
          </button>
        </div>
        ${
          entry?.crew?.length > 0
            ? html`<ul class="crew-list">
                ${entry.crew.map(
                  (member) =>
                    html`<li key=${member.id}>
                      ${member.name}${member.role ? html` <span class="crew-role">${member.role}</span>` : ''}
                    </li>`
                )}
              </ul>`
            : html`<p class="hint">${t('entry.noCrew')}</p>`
        }
      </section>
      <div class="entry-columns">
        <${ManoeuvrePad}
          types=${types}
          noPassage=${state !== null && state.activeEntryId === null}
          busy=${busy}
          onLog=${log}
        />
        <section class="panel writer ${tab === 'sketch' ? 'fullscreen' : ''}">
          <div class="tabs" role="tablist">
            ${['note', 'sketch'].map(
              (name) => html`<button
                type="button"
                role="tab"
                key=${name}
                class="tab"
                aria-selected=${tab === name ? 'true' : 'false'}
                onClick=${() => setTab(name)}
              >
                ${t(`entry.${name}`)}
              </button>`
            )}
          </div>
          <div class="tab-panel" hidden=${tab !== 'note'}>
            <${NotePanel} busy=${busy} bounds=${bounds} onLog=${log} />
          </div>
          <div class="tab-panel" hidden=${tab !== 'sketch'}>
            <${SketchPanel} busy=${busy} onLog=${log} night=${night} />
          </div>
        </section>
      </div>
      <${RecentList}
        entryId=${lastEntryId}
        version=${version}
        queue=${queue}
        manoeuvreLabels=${manoeuvreLabels}
        onDelete=${deleteEvent}
        onDiscard=${discard}
        onComment=${(event) => setEditing({ event })}
      />
    </main>
    <${Toast}
      toast=${toast}
      timeoutMs=${TOAST_MS}
      onClose=${() => setToast(null)}
      onUndo=${undo}
      onReconnect=${reconnect}
      onComment=${() =>
        setEditing({ ref: toast.ref, what: toast.what, event: journal.entryFor(toast.ref) })}
    />
    ${
      editing &&
      html`<${EventDialog}
        title=${editTitle}
        event=${editing.event}
        bounds=${bounds}
        onCancel=${() => setEditing(null)}
        onSave=${saveEvent}
      />`
    }
    ${
      managingCrew &&
      html`<${CrewDialog}
        roster=${roster}
        current=${entry?.crew ?? []}
        onCancel=${() => setManagingCrew(false)}
        onSave=${saveCrew}
        onAddMember=${addCrewMember}
        onEditMember=${editCrewMember}
        onDeleteMember=${deleteCrewMember}
      />`
    }
  `;
}

// Offline start-up and installation need a service worker, which browsers
// only allow over HTTPS or on localhost; over plain HTTP the page works as is.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const locale = createLocale(pickLanguage(navigator.languages, location.search));
document.documentElement.dataset.plotterExtension = String(isPlotterExtension);
document.documentElement.lang = locale.language;
document.title = locale.t('entry.title');

let listener = () => {};
const journal = createJournal({
  request,
  storage: browserStorage(),
  clock,
  newRef: randomId,
  onChange: (snapshot) => listener(snapshot)
});
journal.setListener = (next) => {
  listener = next;
};

watchConnection(connection, { window, document });

render(
  html`<${LocaleProvider} value=${locale}><${App} journal=${journal} /></${LocaleProvider}>`,
  document.getElementById('app')
);
