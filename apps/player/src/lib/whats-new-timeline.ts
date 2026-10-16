import { clubToday } from '@badminton/shared';
import type { WhatsNewEntry } from './whats-new';
import type { ClubChangeEntry } from './club-changes';

// ONE TIMELINE FOR THE WHAT'S NEW PAGE: app releases and posted club changes,
// newest first. A release carries a calendar day; a club change carries an
// instant, which is read as the club's own calendar day, so a change posted on
// a Thursday evening is not filed under Friday because the server runs in UTC.

export type TimelineItem =
  | { kind: 'release'; date: string; release: WhatsNewEntry }
  | { kind: 'club'; date: string; postedAt: string; entry: ClubChangeEntry };

export function buildWhatsNewTimeline(releases: WhatsNewEntry[], clubChanges: ClubChangeEntry[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...releases.map((release) => ({ kind: 'release' as const, date: release.date, release })),
    ...clubChanges.map((entry) => ({
      kind: 'club' as const,
      date: clubToday(new Date(entry.postedAt)),
      postedAt: entry.postedAt,
      entry,
    })),
  ];
  // Newest day first. On the same day a club change sorts above the release,
  // and two club changes on one day keep their posting order, newest first.
  return items.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.kind !== b.kind) return a.kind === 'club' ? -1 : 1;
    if (a.kind === 'club' && b.kind === 'club') return a.postedAt < b.postedAt ? 1 : -1;
    return 0;
  });
}
