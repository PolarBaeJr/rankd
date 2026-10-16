import { PageHeader } from '@badminton/ui';
import { WHATS_NEW, type WhatsNewEntry } from '@/lib/whats-new';
import { getClubChangeEntries, type ClubChangeEntry } from '@/lib/club-changes';
import { buildWhatsNewTimeline } from '@/lib/whats-new-timeline';

// Public page: viewable without an account (see lib/public-paths.ts).
//
// The app's release notes and the club's own changes (rating settings, account
// rules and the like, posted from the console's Club changes page, 00286) are
// both public. The page is dynamic so a newly posted entry shows at once.
export const metadata = { title: "What's new" };
export const dynamic = 'force-dynamic';

// The dates are calendar days, not instants, so they are read and printed in
// UTC to keep any timezone from moving them a day.
function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function ReleaseCard({ entry, current }: { entry: WhatsNewEntry; current: string | undefined }) {
  return (
    <section className="card-base">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
          v{entry.version}: {entry.title}
        </h2>
        {entry.version === current && <span className="mono tag">This version</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {formatDate(entry.date)}
      </div>
      {entry.members.length > 0 && (
        <ul style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 14 }}>
          {entry.members.map((line) => (
            <li key={line} style={{ marginTop: 4 }}>{line}</li>
          ))}
        </ul>
      )}
      {entry.execs && entry.execs.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginTop: 12 }}>
            For execs
          </div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: 14 }}>
            {entry.execs.map((line) => (
              <li key={line} style={{ marginTop: 4 }}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ClubChangeCard({ entry, date }: { entry: ClubChangeEntry; date: string }) {
  return (
    <section className="card-base" data-kind="club-change">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{entry.title ?? 'Club changes'}</h2>
        <span className="mono tag">Club</span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {formatDate(date)}
      </div>
      {entry.intro && <p style={{ margin: '10px 0 0', fontSize: 14 }}>{entry.intro}</p>}
      <ul style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 14 }}>
        {entry.lines.map((line, index) => (
          <li key={index} style={{ marginTop: 4 }}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

export default async function WhatsNewPage() {
  const current = process.env.NEXT_PUBLIC_APP_VERSION;
  const clubChanges = await getClubChangeEntries();
  const timeline = buildWhatsNewTimeline(WHATS_NEW, clubChanges);

  return (
    <div data-screen-label="What's new" style={{ maxWidth: 760, margin: '0 auto' }}>
      <PageHeader
        eyebrow="RELEASE NOTES"
        title="What's new"
        sub="What changed in each version of the app, and changes to how the club runs."
      />
      <div className="grid" style={{ gap: 12 }}>
        {timeline.map((item) =>
          item.kind === 'release' ? (
            <ReleaseCard key={`release-${item.release.version}`} entry={item.release} current={current} />
          ) : (
            <ClubChangeCard key={`club-${item.entry.id}`} entry={item.entry} date={item.date} />
          ),
        )}
      </div>
    </div>
  );
}
