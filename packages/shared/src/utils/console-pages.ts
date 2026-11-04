// CONSOLE PAGE SWITCHES: a super admin switches an admin console page off.
//
// NOT THE MEMBER PAGE SWITCHES (./features.ts), which are member-facing and mint
// a `page.access.<id>` capability each, and not the kill switches
// (./release-flags.ts), which put back a release's old behaviour. These close a
// whole console section: off, the nav hides it and the route answers with the
// unavailable page for everyone except a super admin. Nothing here mints a
// capability or touches a vocabulary CHECK.
//
// One platform_settings row, key `console_pages`, holding `<id>` booleans. No
// migration seeds it: the first save inserts it (SEEDABLE_SETTINGS in the
// admin's platform-setting-fields.ts). admin_console_access (00321) returns the
// row beside the level, so the middleware reads it in the round trip it already
// makes.
//
// ON UNLESS A LITERAL `false`. An absent row, an absent field, a string, a
// null, a non-object and a FAILED READ all read as on.
//
// AN ALLOWLIST. Only the pages below are switchable. Never switchable, and so
// never listed: /platform, /accounts, /permissions, /dashboard, /settings,
// /legal and everything under it, /my-courts, sign-in and auth, /unavailable,
// /unauthorized, /passkey-required and the passkey API. console-pages.test.ts
// pins that.
//
// Deliberately dependency-free, so the edge middleware and a client component
// can import it deeply.

export interface ConsolePageDefinition {
  id: string;
  label: string;
  /** Route prefixes this switch closes. The first is the nav item's href. */
  paths: readonly string[];
}

export const CONSOLE_PAGES = [
  { id: 'matches', label: 'Matches', paths: ['/matches'] },
  { id: 'tournaments', label: 'Tournaments', paths: ['/tournaments'] },
  { id: 'events', label: 'Club events', paths: ['/events'] },
  { id: 'sessions', label: 'Sessions', paths: ['/sessions'] },
  { id: 'announcements', label: 'Announcements', paths: ['/announcements'] },
  { id: 'seasons', label: 'Seasons', paths: ['/seasons'] },
  { id: 'fees', label: 'Fees', paths: ['/fees'] },
  { id: 'finances', label: 'Finances', paths: ['/finances'] },
  { id: 'players', label: 'Players', paths: ['/players'] },
  { id: 'ratings', label: 'Ratings', paths: ['/ratings'] },
  { id: 'club_changes', label: 'Club changes', paths: ['/club-changes'] },
  { id: 'audit', label: 'Audit Log', paths: ['/audit', '/api/audit/export'] },
  { id: 'challenges', label: 'Challenges', paths: ['/challenges'] },
  { id: 'walkovers', label: 'Walkovers', paths: ['/walkovers'] },
  { id: 'disputes', label: 'Disputes', paths: ['/disputes'] },
] as const satisfies readonly ConsolePageDefinition[];

export type ConsolePageId = (typeof CONSOLE_PAGES)[number]['id'];

export type ConsolePages = Record<ConsolePageId, boolean>;

export const CONSOLE_PAGES_SETTING_KEY = 'console_pages';

export const ALL_CONSOLE_PAGES_ON: ConsolePages = Object.fromEntries(
  CONSOLE_PAGES.map((page) => [page.id, true]),
) as ConsolePages;

/** The row a first save starts from: every page on. */
export function defaultConsolePagesValue(): Record<string, boolean> {
  return { ...ALL_CONSOLE_PAGES_ON };
}

/** The stored row as a switch per page: off only for a literal `false`. */
export function parseConsolePages(value: unknown): ConsolePages {
  const row =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(CONSOLE_PAGES.map((page) => [page.id, row[page.id] !== false])) as ConsolePages;
}

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/** The switch that closes this path, or null for a page no switch reaches. */
export function consolePageFor(pathname: string): ConsolePageId | null {
  for (const page of CONSOLE_PAGES) {
    if ((page.paths as readonly string[]).some((prefix) => isUnder(pathname, prefix))) return page.id;
  }
  return null;
}

/**
 * Is this path closed for this viewer? A super admin is never shut out, so a
 * page they switched off stays reachable for them.
 */
export function consolePageClosed(
  pathname: string,
  pages: ConsolePages,
  isSuperAdmin: boolean,
): boolean {
  if (isSuperAdmin) return false;
  const id = consolePageFor(pathname);
  return id !== null && !pages[id];
}

// Minimal structural shape so any Supabase client in this repo fits.
type PagesReader = { from: (table: string) => any };

/**
 * Read the switches. Never throws: a failed read logs and returns every page
 * on.
 */
export async function readConsolePages(client: PagesReader): Promise<ConsolePages> {
  try {
    const { data, error } = await client
      .from('platform_settings')
      .select('value')
      .eq('key', CONSOLE_PAGES_SETTING_KEY)
      .maybeSingle();
    if (error) {
      console.error('[console-pages] could not read the console page switches, using all on:', error.message);
      return { ...ALL_CONSOLE_PAGES_ON };
    }
    return parseConsolePages(data?.value ?? null);
  } catch (err) {
    console.error('[console-pages] could not read the console page switches, using all on:', err);
    return { ...ALL_CONSOLE_PAGES_ON };
  }
}
