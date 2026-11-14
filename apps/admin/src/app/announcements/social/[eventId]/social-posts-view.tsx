import Link from 'next/link';
import { Badge, Card, PageHeader } from '@badminton/ui';
import { withBase } from '@/lib/base-path';
import { CopyText } from './copy-text';

// THE SOCIAL POSTS PAGE, as plain props so it renders without a database.
// Newest set first; a superseded set stays listed and says so, because it may
// already have been posted. Every image is drawn by the slide route, behind
// the same capability as this page.

export interface SocialSetView {
  id: string;
  kind: 'teams_full' | 'teams_new' | 'draw';
  createdAt: string;
  superseded: boolean;
  caption: string;
  slides: number;
  /** How many teams or entries the set names. */
  entries: number;
}

export interface SocialPostsViewProps {
  eventName: string;
  eventHref: string;
  /** The results announcement's line, when the event is finalized. */
  resultsLine: string | null;
  sets: SocialSetView[];
}

export const SET_TITLE: Record<SocialSetView['kind'], string> = {
  teams_full: 'Meet the teams',
  teams_new: 'New teams',
  draw: 'The draw',
};

const MICRO = 'font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-secondary)]';

export function SocialPostsView({ eventName, eventHref, resultsLine, sets }: SocialPostsViewProps) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={eventName}
        title="Social posts"
        sub="Slides and captions to post by hand. Names are drawn as they are now; a member hidden from the leaderboard, asking to be deleted, or a guest appears as A member."
        actions={<Link href={eventHref} className="text-sm underline">Back to the event</Link>}
      />

      {resultsLine && (
        <Card>
          <div className={MICRO}>Results</div>
          <p className="mt-2 text-sm text-[var(--text-primary)]">{resultsLine}</p>
          <div className="mt-3">
            <CopyText text={resultsLine} label="Copy results" />
          </div>
        </Card>
      )}

      {sets.length === 0 && !resultsLine && (
        <Card>
          <p className="text-sm text-[var(--text-secondary)]">
            Nothing yet. Sets appear here when teams are confirmed and when the draw is made.
          </p>
        </Card>
      )}

      {sets.map((set) => (
        <Card key={set.id} className={set.superseded ? 'opacity-70' : undefined}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">{SET_TITLE[set.kind]}</h2>
            <span className={MICRO}>
              {set.entries} {set.kind === 'draw' ? 'entries' : set.entries === 1 ? 'team' : 'teams'} / {set.slides} {set.slides === 1 ? 'slide' : 'slides'}
            </span>
            {set.superseded && <Badge variant="neutral">Superseded</Badge>}
            <span className={MICRO}>{set.createdAt}</span>
          </div>

          <div className="mt-4 flex flex-wrap gap-4">
            {Array.from({ length: set.slides }, (_, index) => {
              const src = withBase(`/api/social-posts/${set.id}/${index + 1}`);
              return (
                <figure key={index} className="w-[216px]">
                  {/* A plain img: the route renders the PNG on request, and next/image would cache it. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={`${SET_TITLE[set.kind]}, slide ${index + 1}`} width={216} height={270} className="border border-[var(--border)]" />
                  <figcaption className="mt-1">
                    <a href={src} target="_blank" rel="noreferrer" className="text-xs underline">
                      Open image {index + 1}
                    </a>
                  </figcaption>
                </figure>
              );
            })}
          </div>

          <pre className="mt-4 whitespace-pre-wrap rounded-md border border-[var(--border)] p-3 text-sm text-[var(--text-primary)]">{set.caption}</pre>
          <div className="mt-2">
            <CopyText text={set.caption} />
          </div>
        </Card>
      ))}
    </div>
  );
}
