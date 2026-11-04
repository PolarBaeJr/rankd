import { describe, it, expect } from 'vitest';
import { fingerprintChanged, mayRefreshNow, type ScreenState } from '../quiet-refresh';

const idle: ScreenState = { editing: false, dialogOpen: false, menuOpen: false, actionPending: false, hidden: false };

describe('fingerprintChanged', () => {
  it('is a change only when the probe read something else', () => {
    expect(fingerprintChanged('abc', 'abd')).toBe(true);
    expect(fingerprintChanged('abc', 'abc')).toBe(false);
  });

  it('reads a failed probe as no change', () => {
    expect(fingerprintChanged('abc', null)).toBe(false);
    expect(fingerprintChanged('', null)).toBe(false);
  });

  it('refreshes a page whose own fingerprint read failed once the probe answers', () => {
    expect(fingerprintChanged('', 'abc')).toBe(true);
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
