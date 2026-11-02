import type { Capability } from './permissions';

// THE VIEWS OF THE /fees LIST, as data with no framework import, so the choice
// of view can be tested without mounting the page.
//
// /fees used to be five tabs, two of them other ledgers (Other income and
// Expenses). Those moved to /finances; what is left is one list of member fees,
// and the view picks which of its rows are drawn. The URL (?view=) is the one
// place the choice lives, the way /players?show= is.

export const FEE_VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'review', label: 'To review' },
  { id: 'unpaid', label: 'Unpaid' },
  { id: 'paid', label: 'Paid' },
  { id: 'waived', label: 'Waived' },
  { id: 'screenshots', label: 'Form screenshots' },
] as const;

export type FeeViewId = (typeof FEE_VIEWS)[number]['id'];

// What each old ?tab= opens now, so a link or bookmark from before still lands
// on the same rows. Other income and Expenses are not here: they are a
// different page, see legacyTabRedirect.
const LEGACY_TABS: Record<string, FeeViewId> = {
  fees: 'all',
  submitted: 'review',
  outstanding: 'unpaid',
};

const isFeeView = (value: string | undefined): value is FeeViewId =>
  FEE_VIEWS.some((v) => v.id === value);

/**
 * The view to draw, or null when the viewer may see none of them (somebody
 * holding only the reinstatement pair, or only Add fee).
 *
 * `permitted` is the views this viewer may open AND that are offered right now
 * (Waived and Form screenshots are hidden at 0). An explicit `view` wins over a
 * legacy `tab`; a view that is not permitted falls back to the default, the
 * same way an unknown one does. The query string is not a route, so this is
 * presentation: every fetch on the page is gated on its own capability.
 *
 * The default is the work waiting: To review when a receipt is waiting and the
 * viewer may settle it, otherwise the whole list.
 */
export function resolveFeeView(
  params: { view?: string; tab?: string },
  permitted: readonly FeeViewId[],
  hasWaiting: boolean,
): FeeViewId | null {
  const asked = isFeeView(params.view)
    ? params.view
    : params.tab !== undefined
      ? LEGACY_TABS[params.tab]
      : undefined;
  if (asked && permitted.includes(asked)) return asked;
  if (hasWaiting && permitted.includes('review')) return 'review';
  if (permitted.includes('all')) return 'all';
  if (permitted.includes('review')) return 'review';
  return null;
}

/**
 * Where an old /fees?tab=income or ?tab=expenses link goes now: the ledger's
 * section of /finances. Null for every other tab, which /fees still draws.
 *
 * The season goes along only when the link named one, so the bare URL keeps
 * meaning "the active season" on both pages.
 */
export function legacyTabRedirect(tab: string | undefined, season: string | undefined): string | null {
  if (tab !== 'income' && tab !== 'expenses') return null;
  const query = season !== undefined ? `?season=${encodeURIComponent(season)}` : '';
  return `/finances${query}#${tab}`;
}

// What earns each page a nav item. /fees and /finances are both opened by
// fees.page, which every officer holds, so canAccess() alone would offer an
// officer on the floor a /fees link to a list with nothing on it. These are
// the capabilities that put something on each page.
export const FEE_LIST_CAPABILITIES: readonly Capability[] = [
  'fees.clubfees.read',
  'fees.clubfees.markpaid.write',
  'fees.clubfees.addmanual.write',
  'fees.reinstatements.read',
  'fees.reinstatements.write',
];

export const FINANCES_CAPABILITIES: readonly Capability[] = [
  'fees.expenses.read',
  'fees.expenses.add.write',
  'fees.otherincome.read',
  'fees.otherincome.add.write',
  'fees.netposition.read',
  'fees.clubfees.read',
];
