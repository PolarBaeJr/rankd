import { describe, it, expect, vi } from 'vitest';
import {
  ALL_RELEASE_FLAGS_ON,
  RELEASE_FLAGS,
  RELEASE_FLAGS_SETTING_KEY,
  defaultReleaseFlagsValue,
  parseReleaseFlags,
  readReleaseFlags,
  releaseFlagOffMessage,
} from '../release-flags';

// ON UNLESS A LITERAL false. A kill switch is a way back, so every doubt reads
// as the shipped behaviour.

describe('parseReleaseFlags', () => {
  it('reads an absent row, a null and a non-object as every switch on', () => {
    for (const value of [undefined, null, 'false', 0, false, [], [false], 42]) {
      expect(parseReleaseFlags(value)).toEqual(ALL_RELEASE_FLAGS_ON);
    }
  });

  it('reads an absent field and any garbage as on', () => {
    const flags = parseReleaseFlags({ did_not_come: 'false', void_unplayed: 0, add_on_the_spot: null, nonsense: false });
    expect(flags).toEqual(ALL_RELEASE_FLAGS_ON);
  });

  it('turns off only the switch stored as a literal false', () => {
    const flags = parseReleaseFlags({ check_in_after_draw: false, did_not_come: true });
    expect(flags.check_in_after_draw).toBe(false);
    expect(Object.entries(flags).filter(([, on]) => !on).map(([id]) => id)).toEqual(['check_in_after_draw']);
  });
});

describe('the registry', () => {
  it('has the switches the console and the database ask, each once', () => {
    const ids = RELEASE_FLAGS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'desk_helper_void',
      'auto_call_skips_absent',
      'check_in_after_draw',
      'late_placement_picker',
      'did_not_come',
      'void_unplayed',
      'auto_close_tournament',
      'placings_skip_never_played',
      'add_on_the_spot',
      'quiet_refresh',
      'ladder_doubles_points',
    ]);
  });

  it('says what off falls back to for every switch, with no em dash', () => {
    for (const f of RELEASE_FLAGS) {
      expect(f.off, f.id).toMatch(/^Off: /);
      for (const text of [f.label, f.description, f.off]) expect(text, f.id).not.toContain('—');
      expect(f.since).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('seeds a first save with every switch on, keyed by the bare id', () => {
    expect(RELEASE_FLAGS_SETTING_KEY).toBe('release_flags');
    expect(defaultReleaseFlagsValue()).toEqual(ALL_RELEASE_FLAGS_ON);
    expect(parseReleaseFlags(defaultReleaseFlagsValue())).toEqual(ALL_RELEASE_FLAGS_ON);
  });

  it('names the switch in its refusal', () => {
    expect(releaseFlagOffMessage('void_unplayed')).toContain('Void unplayed matches');
  });
});

describe('readReleaseFlags', () => {
  const client = (result: unknown) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => result }) }) }),
  });

  it('reads the stored row', async () => {
    const flags = await readReleaseFlags(client(Promise.resolve({ data: { value: { void_unplayed: false } }, error: null })));
    expect(flags.void_unplayed).toBe(false);
    expect(flags.did_not_come).toBe(true);
  });

  it('is every switch on when the read fails or throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await readReleaseFlags(client(Promise.resolve({ data: null, error: { message: 'down' } })))).toEqual(ALL_RELEASE_FLAGS_ON);
    expect(await readReleaseFlags(client(Promise.reject(new Error('boom'))))).toEqual(ALL_RELEASE_FLAGS_ON);
    expect(await readReleaseFlags(client(Promise.resolve({ data: null, error: null })))).toEqual(ALL_RELEASE_FLAGS_ON);
    spy.mockRestore();
  });
});
