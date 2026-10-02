// Where the reader was in a view, so that coming back to it lands there rather
// than at the top of a page that has forgotten everything.
//
// The browser cannot do this for us. The app replaces the whole page on a hash
// change, and the logbook's older pages are fetched after it renders, so by the
// time the browser would put the scroll back, the page is one screen tall and
// the position has been clamped away.
//
// Kept per view rather than per history entry: the reader expects the same
// thing of the back button, of "Back to the logbook" and of the nav bar — the
// logbook as they left it. A view is remembered only once it has asked to be
// (`remember`), which is also what tells the router whether to scroll that view
// to the top on arrival or leave it to put itself back.
//
// Only for the life of the page: a reload is a fresh start, as it is anywhere
// else.

export function createViewMemory() {
  const views = new Map();

  return {
    // What this view left behind, or null if it has never asked to be
    // remembered. A copy: what the caller does with it is its own business.
    recall(name) {
      const state = views.get(name);
      return state ? { ...state } : null;
    },

    // Merged into what is already there, so the view and the router can each
    // record their own part of it.
    remember(name, state) {
      views.set(name, { ...views.get(name), ...state });
    },

    forget(name) {
      views.delete(name);
    }
  };
}
