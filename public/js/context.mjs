import { createContext, useContext, useEffect, useRef, useState } from '../vendor/preact-htm.mjs';
import { parseAnimationHash } from './days.mjs';
import { createFormatter } from './format.mjs';
import { createTranslator } from './i18n.mjs';
import { createViewMemory } from './view-memory.mjs';

const LocaleContext = createContext(null);

export const LocaleProvider = LocaleContext.Provider;

export function createLocale(language) {
  const t = createTranslator(language);
  const format = createFormatter({
    locale: language,
    units: { knots: t('unit.knots'), nauticalMiles: t('unit.nauticalMiles') }
  });
  return { language, t, format };
}

export function useLocale() {
  return useContext(LocaleContext);
}

function parseRoute(hash) {
  const passage = hash.match(/^#\/passages\/(\d+)$/);
  if (passage) {
    return { name: 'passage', id: Number(passage[1]) };
  }
  if (hash === '#/export') {
    return { name: 'export' };
  }
  if (hash === '#/statistics') {
    return { name: 'statistics' };
  }
  // The dates travel in the hash (a passage page hands them over, and the page
  // keeps them there as they change); the playback state does not.
  const animation = parseAnimationHash(hash);
  if (animation) {
    return { name: 'animation', ...animation };
  }
  return hash === '#/replay' ? { name: 'replay' } : { name: 'log' };
}

// What the views have left behind, shared by all of them: one logbook, one
// place it was left.
export const viewMemory = createViewMemory();

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  const leaving = useRef(route);
  useEffect(() => {
    const onChange = () => {
      const from = leaving.current;
      const to = parseRoute(location.hash);
      leaving.current = to;
      // Saved here rather than as the view goes: nothing has re-rendered yet,
      // so this is still where the reader left the page.
      if (viewMemory.recall(from.name)) {
        viewMemory.remember(from.name, { scrollY: window.scrollY });
      }
      setRoute(to);
      // A view with something to come back to scrolls itself, once it has
      // rendered enough page to scroll (see LogView); every other arrival
      // starts at the top.
      if (!viewMemory.recall(to.name)) {
        window.scrollTo(0, 0);
      }
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

// Runs `load` now and every `intervalMs`, ignoring results that arrive after
// the component is gone.
export function usePolling(load, intervalMs, dependencies = []) {
  useEffect(() => {
    let active = true;
    const run = () => load(() => active);
    run();
    const timer = intervalMs ? setInterval(run, intervalMs) : null;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, dependencies);
}
