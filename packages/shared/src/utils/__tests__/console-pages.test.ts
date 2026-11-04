import { describe, it, expect, vi } from 'vitest';
import {
  ALL_CONSOLE_PAGES_ON,
  CONSOLE_PAGES,
  CONSOLE_PAGES_SETTING_KEY,
  consolePageClosed,
  consolePageFor,
  defaultConsolePagesValue,
  parseConsolePages,
  readConsolePages,
} from '../console-pages';

// THE CONSOLE PAGE SWITCHES (00321). On unless a literal false, closed for
// everyone but a super admin, and only the allowlisted pages are switchable.

describe('parseConsolePages', () => {
  it('reads an absent row, a null and a non-object as every page on', () => {
    for (const value of [undefined, null, 'false', 0, false, [], [false], 42]) {
      expect(parseConsolePages(value)).toEqual(ALL_CONSOLE_PAGES_ON);
    }
  });

  it('reads an absent field and any garbage as on', () => {
    expect(parseConsolePages({ matches: 'false', fees: 0, audit: null, nonsense: false })).toEqual(ALL_CONSOLE_PAGES_ON);
  });

  it('turns off only the page stored as a literal false', () => {
    const pages = parseConsolePages({ matches: false, fees: true });
    expect(Object.entries(pages).filter(([, on]) => !on).map(([id]) => id)).toEqual(['matches']);
  });

  it('starts a first save from every page on', () => {
    expect(defaultConsolePagesValue()).toEqual(ALL_CONSOLE_PAGES_ON);
    expect(CONSOLE_PAGES_SETTING_KEY).toBe('console_pages');
  });
});

describe('the allowlist', () => {
  it('lists each page once', () => {
    const ids = CONSOLE_PAGES.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never reaches a page that must stay open', () => {
    for (const path of [
      '/platform',
      '/accounts',
      '/permissions',
      '/dashboard',
      '/',
      '/settings',
      '/legal',
      '/legal/privacy',
      '/my-courts',
      '/login',
      '/auth/callback',
      '/unavailable',
      '/unauthorized',
      '/passkey-required',
      '/api/passkey/register/options',
      '/api/health',
    ]) {
      expect(consolePageFor(path), path).toBeNull();
    }
  });

  it('matches by whole segment, not by prefix', () => {
    expect(consolePageFor('/matches')).toBe('matches');
    expect(consolePageFor('/matches/123')).toBe('matches');
    expect(consolePageFor('/matchesx')).toBeNull();
    expect(consolePageFor('/fees')).toBe('fees');
    expect(consolePageFor('/finances')).toBe('finances');
  });

  it('closes the audit export with the audit log', () => {
    expect(consolePageFor('/api/audit/export')).toBe('audit');
  });
});

describe('consolePageClosed', () => {
  const pages = parseConsolePages({ matches: false });

  it('closes a switched-off page for an officer', () => {
    expect(consolePageClosed('/matches', pages, false)).toBe(true);
    expect(consolePageClosed('/matches/abc', pages, false)).toBe(true);
  });

  it('never closes a page for a super admin', () => {
    expect(consolePageClosed('/matches', pages, true)).toBe(false);
  });

  it('leaves every other page open', () => {
    expect(consolePageClosed('/tournaments', pages, false)).toBe(false);
    expect(consolePageClosed('/platform', pages, false)).toBe(false);
  });
});

describe('readConsolePages', () => {
  const client = (result: unknown, throws = false) => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (throws) throw new Error('down');
            return result;
          },
        }),
      }),
    }),
  });

  it('reads the stored row', async () => {
    const pages = await readConsolePages(client({ data: { value: { fees: false } }, error: null }));
    expect(pages.fees).toBe(false);
    expect(pages.matches).toBe(true);
  });

  it('reads a failed read and a throw as every page on', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await readConsolePages(client({ data: null, error: { message: 'nope' } }))).toEqual(ALL_CONSOLE_PAGES_ON);
    expect(await readConsolePages(client(null, true))).toEqual(ALL_CONSOLE_PAGES_ON);
    spy.mockRestore();
  });
});
