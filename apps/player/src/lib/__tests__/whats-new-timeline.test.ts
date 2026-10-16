import { describe, it, expect } from 'vitest';
import { buildWhatsNewTimeline } from '../whats-new-timeline';
import type { WhatsNewEntry } from '../whats-new';
import type { ClubChangeEntry } from '../club-changes';

const release = (version: string, date: string): WhatsNewEntry => ({ version, date, title: version, members: [] });
const change = (id: string, postedAt: string): ClubChangeEntry => ({ id, title: null, intro: null, lines: ['A line.'], postedAt });

describe('buildWhatsNewTimeline', () => {
  it('files a change by the club calendar day, not the UTC one', () => {
    // 06:30 UTC on October 9 is 23:30 on October 8 in the club's time zone.
    const [item] = buildWhatsNewTimeline([], [change('c1', '2026-10-09T06:30:00Z')]);
    expect(item!.date).toBe('2026-10-08');
  });

  it('puts the newest day first, and a club change above a release on the same day', () => {
    const items = buildWhatsNewTimeline(
      [release('1.1.0', '2026-10-08'), release('1.0.8', '2026-09-29')],
      [change('late', '2026-10-08T20:00:00Z'), change('early', '2026-10-08T17:00:00Z'), change('old', '2026-10-01T18:00:00Z')],
    );
    expect(items.map((item) => (item.kind === 'release' ? item.release.version : item.entry.id))).toEqual([
      'late',
      'early',
      '1.1.0',
      'old',
      '1.0.8',
    ]);
  });

  it('is the release list unchanged when there are no club changes', () => {
    const releases = [release('1.1.0', '2026-10-08'), release('1.0.8', '2026-09-29')];
    expect(buildWhatsNewTimeline(releases, []).map((item) => item.kind === 'release' && item.release)).toEqual(releases);
  });
});
