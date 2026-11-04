// QUIET LIVE REFRESH (kill switch quiet_refresh). The event page and My courts
// poll a small fingerprint of what they show and re-read only when it moved,
// and a re-read waits while the person at the screen is in the middle of
// something. Pure, so the decisions are tested without a browser; the DOM
// reading is in readScreenState below.

/** How often an open page asks whether anything changed. */
export const PROBE_MS = 5000;
/** How often a refresh that had to wait asks again. */
export const DEFER_RETRY_MS = 1000;

/** True when the probe read something other than what the page shows. A failed probe (null) is no change. */
export function fingerprintChanged(shown: string, probed: string | null): boolean {
  return probed !== null && probed !== shown;
}

export interface ScreenState {
  /** An input, textarea, select or editable element has focus. */
  editing: boolean;
  /** A Dialog (or confirm) is open. */
  dialogOpen: boolean;
  /** A Dropdown, Select or picker list is open. */
  menuOpen: boolean;
  /** A button is showing its loading state: a save is in flight. */
  actionPending: boolean;
  /** The page is hidden; a refresh waits until it is seen. */
  hidden: boolean;
}

/** Whether a refresh may land now, or has to wait until the screen is left alone. */
export function mayRefreshNow(state: ScreenState): boolean {
  return !state.editing && !state.dialogOpen && !state.menuOpen && !state.actionPending && !state.hidden;
}

/** Reads ScreenState off the document. Client only. */
export function readScreenState(doc: Document): ScreenState {
  const active = doc.activeElement as HTMLElement | null;
  const tag = active?.tagName;
  return {
    editing: !!active && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable),
    dialogOpen: !!doc.querySelector('[role="dialog"]'),
    menuOpen: !!doc.querySelector('[role="menu"], [role="listbox"]'),
    actionPending: !!doc.querySelector('[aria-busy="true"]'),
    hidden: doc.visibilityState !== 'visible',
  };
}

/** The window event a Realtime nudge sends when quiet refresh is on: it asks the probe, and waits like one. */
export const QUIET_REFRESH_EVENT = 'quiet-refresh:request';
