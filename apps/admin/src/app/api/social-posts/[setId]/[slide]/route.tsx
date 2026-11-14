import { ImageResponse } from 'next/og';
import { isUuid } from '@badminton/shared';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { releaseFlagOn } from '@/lib/release-flags';
import { loadRenderedSet, EYEBROW } from '@/lib/social-posts/sets';
import { Slide, SLIDE_FONTS } from '@/lib/social-posts/slides';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from '@/lib/social-posts/layout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ONE SLIDE OF A SOCIAL POST SET, as a PNG (00333). Behind the officer's
// session and announcements.socialposts.read, and the social_posts switch.
// Every refusal is the same bare 404, so the route says nothing about a set
// to somebody who may not see it. The names are read now, never cached.

const gone = () => new Response(null, { status: 404 });

export async function GET(_request: Request, { params }: { params: Promise<{ setId: string; slide: string }> }) {
  const { setId, slide } = await params;
  if (!(await releaseFlagOn('social_posts'))) return gone();
  // requireCapability THROWS on a refusal; caught so it is the same 404.
  try {
    await requireCapability('announcements.socialposts.read');
  } catch {
    return gone();
  }
  const index = Number(slide.replace(/\.png$/, ''));
  if (!isUuid(setId) || !Number.isInteger(index) || index < 1) return gone();

  const rendered = await loadRenderedSet(createAdminClient(), setId);
  if (!rendered || index > rendered.pages.length) return gone();

  return new ImageResponse(
    (
      <Slide
        eyebrow={EYEBROW[rendered.set.kind]}
        eventName={rendered.event.name}
        detail={rendered.event.detail}
        blocks={rendered.pages[index - 1]!}
        index={index}
        total={rendered.pages.length}
      />
    ),
    {
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      fonts: SLIDE_FONTS,
      headers: {
        'Content-Disposition': `inline; filename="${rendered.set.kind}-${index}.png"`,
        'Cache-Control': 'private, no-store',
      },
    },
  );
}
