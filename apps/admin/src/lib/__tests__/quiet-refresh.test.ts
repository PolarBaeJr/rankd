import { describe, it, expect } from 'vitest';
import { FAILED_PROBE_REFRESH_MS, fingerprintChanged, mayRefreshNow, probeRefreshDue, type ScreenState } from '../quiet-refresh';

const idle: ScreenState = { editing: false, dialogOpen: false, menuOpen: false, actionPending: false, hidden: false };

describe('fingerprintChanged', () => {
  it('is a change only when the probe read something else', () => {
    expect(fingerprintChanged('abc', 'abd')).toBe(true);
    expect(fingerprintChanged('abc', 'abc')).toBe(false);
  });

  it('reads a failed probe as changed: unknown is not current', () => {
    expect(fingerprintChanged('abc', null)).toBe(true);
    expect(fingerprintChanged('', null)).toBe(true);
  });

  it('refreshes a page whose own fingerprint read failed once the probe answers', () => {
    expect(fingerprintChanged('', 'abc')).toBe(true);
  });
});

describe('probeRefreshDue', () => {
  it('waits FAILED_PROBE_REFRESH_MS after the last refresh before a failed probe refreshes', () => {
    expect(FAILED_PROBE_REFRESH_MS).toBe(15000);
    expect(probeRefreshDue('abc', null, 0)).toBe(false);
    expect(probeRefreshDue('abc', null, FAILED_PROBE_REFRESH_MS - 1)).toBe(false);
    expect(probeRefreshDue('abc', null, FAILED_PROBE_REFRESH_MS)).toBe(true);
  });

  it('otherwise follows fingerprintChanged, however recent the last refresh', () => {
    expect(probeRefreshDue('abc', 'abd', 0)).toBe(true);
    expect(probeRefreshDue('abc', 'abc', 0)).toBe(false);
    expect(probeRefreshDue('abc', 'abc', FAILED_PROBE_REFRESH_MS * 10)).toBe(false);
  });
});

describe('mayRefreshNow', () => {
  it('lets a refresh land on an idle, visible screen', () => {
    expect(mayRefreshNow(idle)).toBe(true);
  });

  it('waits while anything is in the way', () => {
    for (const key of ['editing', 'dialogOpen', 'menuOpen', 'actionPending', 'hidden'] as const) {
      expect(mayRefreshNow({ ...idle, [key]: true }), key).toBe(false);
    }
  });
});
