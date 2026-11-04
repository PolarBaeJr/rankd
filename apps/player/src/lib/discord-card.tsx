import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CardAward,
  CardBackground,
  CardMatch,
  DiscordProfile,
  LadderFocus,
  LadderLine,
  MatchDiscipline,
} from './discord-profile';
import { FOCUS_LABEL, focusDiscipline } from './discord-profile';
import { formatStreak } from './ladder';

/**
 * The profile card's pixels.
 *
 * SEPARATE FROM THE ROUTE so the card can be rendered from a fixture without a
 * database and without a signed token -- see __tests__/discord-card-render.
 * The route decides who may see a card; this decides what one looks like.
 *
 * THE FONTS ARE .ttf, NOT THE .woff2 THE BROWSER GETS. satori, which next/og
 * renders through, cannot read WOFF2 at all. The three files are the same
 * Barlow the app uses, with the latin, latin-ext and vietnamese subsets merged
 * into one face each so an accented or Vietnamese name renders as itself
 * instead of as tofu. They reach the container through
 * outputFileTracingIncludes in next.config.js -- nothing imports them, so
 * nothing traces them, and without that entry the route builds clean and 500s
 * on its first real request.
 *
 * THE LAYOUT IS A PANEL GRID, and the panels are the whole reason it reads as
 * a card rather than as a page. Every figure sits in a bordered box that says
 * what it is, so the eye lands on a value and finds its label without
 * tracking; the previous flat rows left three big numbers floating over an
 * empty field and a reader had to work out which was which. Panels also make
 * the empty cases honest -- a member with no rival gets a panel that says so,
 * where a flat line just went missing.
 */

export const W = 1000;

/**
 * BOTH HEIGHTS ARE THE SUM OF THE BLOCKS, not round numbers.
 *
 * satori cannot size an image to its content, so the height is asserted here
 * and the layout has to match it. Assert too little and the last row is cropped
 * with no error anywhere; assert too much -- which is what 420/580 did -- and
 * the card posts a band of empty black into the channel, because the rail is
 * pinned to the bottom and nothing fills the gap above it.
 *
 * Unranked: 32 top + 106 hero + 22 + 132 panel + 31 rail + 26 bottom = 349.
 * Ranked:   that, + 12 + 156 for the recent/rival row               = 517.
 *
 * THE CONSTANTS ARE EACH 7 MORE THAN THAT SUM, on purpose: 349 + 7 = 356 and
 * 517 + 7 = 524. A font's real line box is a little taller than its nominal
 * size, so the blocks measure fractionally over their nominal heights, and
 * being short is the failure that loses information rather than merely looking
 * untidy. Do not "correct" 356 down to 349 -- that reintroduces the crop.
 *
 * discord-card-render.test.ts draws every shape and checks that nothing was
 * cropped at the bottom edge. It CANNOT see the opposite mistake: an over-tall
 * constant leaves dead black above the rail, which no assertion here detects,
 * so run that test with CARD_RENDER_OUT set and look at the images whenever
 * these numbers change.
 */
export const H = 356;

/** With the recent-form block and the rival panel beside it. */
export const H_WITH_FORM = 524;

/**
 * The bio block: 18 marginTop + two 24px lines.
 *
 * THE BIO CANNOT CROP THE CARD, and that is worth stating because it is the
 * opposite of the failure H warns about. The block below is drawn at a fixed
 * 48px, and satori CLIPS a flex box's overflow rather than letting it push the
 * layout down -- measured: a 599-character bio leaves the bottom edge as clean
 * as a 149-character one. So the render test's crop check, which is what
 * catches every other overrun in this file, can never fail for a bio.
 *
 * WHAT GOES WRONG INSTEAD IS QUIETER. A bio that wraps to a third line has
 * that line clipped away inside the box: the card still looks right, and the
 * member's words are simply gone. BIO_MAX is the only thing standing between
 * this layout and that, which is why it is a measured number and not a guess.
 */
export const H_BIO = 66;

/**
 * How much of a bio the card draws.
 *
 * Shorter than the 240 the bot used to put in the message body, because a
 * message can be any height and this block is exactly two lines.
 *
 * 150 IS MEASURED, NOT CHOSEN. Barlow 400 at 17px across the 910px of usable
 * width fits 150 characters in two lines both for text of short words, which
 * wraps as late as possible and so packs the most in, and for long unbroken
 * names, which wrap early. 160 still fits; 150 keeps a margin for a face that
 * measures differently. Raising it is a layout change -- see the wrap test in
 * discord-card-render.test.ts, which is the assertion that holds this, because
 * the crop check cannot.
 */
export const BIO_MAX = 150;

/** The bio as it will be drawn, or null when there is nothing to draw. */
export function cardBio(bio: string | null | undefined): string | null {
  const text = (bio ?? '').trim();
  if (!text) return null;
  return text.length > BIO_MAX ? `${text.slice(0, BIO_MAX - 3).trimEnd()}...` : text;
}

/**
 * Whether the card carries the provisional footnote.
 *
 * The asterisk is drawn on the rating itself either way; this is the line that
 * says what it means. It lives on the rail, which has spare width and a fixed
 * height, so unlike the bio it costs the card nothing.
 */
export function isProvisional(profile: DiscordProfile): boolean {
  return !!(profile.doubles?.provisional || profile.singles?.provisional);
}

/**
 * How tall to draw THIS card.
 *
 * An unranked member gets neither recent form nor rival nor nights -- see
 * loadForm -- so drawing them at the full height would post 160px of nothing
 * into a channel. satori cannot size an image to its content, but the caller
 * chooses the height it renders at, so the two just have to agree; both the
 * route and Card ask this.
 */
export function cardHeight(profile: DiscordProfile): number {
  const base = profile.ranked ? H_WITH_FORM : H;
  // The bio is the one block whose PRESENCE varies independently of `ranked`,
  // so it is added rather than folded into either constant. A member with no
  // bio must not get 66px of empty card.
  return base + (cardBio(profile.bio) ? H_BIO : 0);
}

const INK = '#f2f2f2';
const MUTE = '#8d8d8d';
const FAINT = '#666666';
const RED = '#cc0000';
const LINE = 'rgba(255,255,255,0.10)';
/** Panel fill and edge. Two values used everywhere, so a panel cannot drift. */
const PANEL = 'rgba(255,255,255,0.045)';
const PANEL_LINE = 'rgba(255,255,255,0.09)';

// Read once per process rather than per request. The files are ~68KB each and
// never change while the container lives.
const fontFile = (f: string) => readFileSync(join(process.cwd(), 'src/fonts', f));
export const FONTS = [
  { name: 'Barlow Condensed', data: fontFile('BarlowCondensed-Bold.ttf'), weight: 700 as const, style: 'normal' as const },
  { name: 'Barlow', data: fontFile('Barlow-Regular.ttf'), weight: 400 as const, style: 'normal' as const },
  { name: 'Barlow', data: fontFile('Barlow-SemiBold.ttf'), weight: 600 as const, style: 'normal' as const },
];

/**
 * The background, as its own layer.
 *
 * ONE ABSOLUTELY-POSITIONED CHILD behind everything else, rather than a
 * `background` on the root. That is the whole point of the split: a member-
 * chosen image, a seasonal treatment or an award-earned pattern all become a
 * new case here, and nothing above this function moves. resolveBackground in
 * lib/discord-profile.ts decides WHICH; this decides what it looks like.
 */
function Background({ background, height }: { background: CardBackground; height: number }) {
  switch (background.kind) {
    case 'default':
    default:
      return (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: W,
            height,
            display: 'flex',
            background: '#0a0a0a',
          }}
        >
          {/* The club's red, bled in from the left edge the way the app's
              brand mark sits against the surface. Kept low so a future photo
              background can replace this block without the type needing new
              contrast rules. */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 10,
              height,
              display: 'flex',
              background: RED,
            }}
          />
          {/* Two washes rather than one. The corner glow gives the hero band a
              light source so the avatar is not floating on flat black, and the
              long diagonal keeps the bottom half from going dead -- a card is
              mostly seen at thumbnail size, where an even field reads as an
              image that failed to load. */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: W,
              height,
              display: 'flex',
              background: 'radial-gradient(120% 90% at 6% 0%, rgba(204,0,0,0.30) 0%, rgba(10,10,10,0) 60%)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: W,
              height,
              display: 'flex',
              background: 'linear-gradient(160deg, rgba(255,255,255,0.05) 0%, rgba(10,10,10,0) 45%)',
            }}
          />
        </div>
      );
  }
}

/** Two initials, when there is no avatar or it could not be fetched in time. */
function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * The hosts an avatar may be fetched from.
 *
 * BOTH APP URLS, AND THAT IS NOT BELT AND BRACES. publicStorageUrl
 * (components/AvatarUpload.tsx) rewrites every uploaded avatar to
 * `${window.location.origin}/supabase/...`, so a stored avatar_url names the
 * APP's own origin rather than Supabase's -- all three on prod today are
 * https://sfubadminton.com/supabase/... . Which variable carries that origin
 * depends on how the image was built, and challenge-qr.ts records
 * NEXT_PUBLIC_PLAYER_URL going missing from a build env as something that has
 * actually happened, so an allowlist resting on one of them would quietly blank
 * every avatar in the club instead of failing loudly.
 *
 * Read per call rather than into a module const: these are NEXT_PUBLIC_ values
 * and a test that stubs the environment cannot reach a const that was evaluated
 * at import time. The route is cached for 900s, so the cost is nothing.
 */
function allowedAvatarHosts(): Set<string> {
  // Spelled out one by one on purpose. NEXT_PUBLIC_ values are substituted into
  // the bundle by literal text match at build time, so process.env[name] with a
  // computed name reads undefined and the allowlist would come up empty.
  const configured = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_PLAYER_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ];
  const hosts = new Set<string>(['cdn.discordapp.com']);
  for (const value of configured) {
    if (!value) continue;
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      // A malformed build value contributes no host rather than throwing the
      // whole render away.
    }
  }
  return hosts;
}

/** Hostnames that name the inside of the network rather than a place on the web. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // URL.hostname hands back an IPv6 literal still wrapped in its brackets.
  if (host.startsWith('[')) {
    const ip = host.slice(1, -1);
    // ::1 loopback, fc00::/7 unique-local (fc.. or fd..), and the IPv4-mapped
    // form, which is another way to write 127.0.0.1.
    return ip === '::1' || /^f[cd]/.test(ip) || ip.startsWith('::ffff:');
  }
  return /^(?:127|10)\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
}

/**
 * Whether the card renderer may fetch this URL at all.
 *
 * players.avatar_url IS MEMBER-WRITABLE WITH NO HOST RESTRICTION, and this fetch
 * runs server-side from api/discord/card/[token], a route that is anonymous by
 * design. Without this a member stores http://10.0.0.5:8000/ or
 * http://localhost:54321/ and the club's own server makes that request for them,
 * from inside the network, against anything the container can reach. The
 * response never comes back to them -- the card either draws or falls back to
 * initials -- but a blind SSRF is still a port scanner and still reaches
 * services that trust their own network.
 *
 * THE ALLOWLIST IS THE CONTROL. The literal-address checks are defence in depth
 * only: they read the hostname as written, so they cannot see a name that
 * RESOLVES to an internal address, and the allowlist is what actually prevents
 * that. Hosts match exactly and case-insensitively, never by suffix, because
 * `evil-sfubadminton.com` ends with the club's own domain.
 */
export function isFetchableAvatarUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // http(s) only. file:, data: and the rest are all ways to make one fetch read
  // something that was never a web page.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // user:pass@host would send those credentials to whatever the host turns out
  // to be.
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) return false;
  return allowedAvatarHosts().has(host);
}

/**
 * The avatar, inlined.
 *
 * Fetched HERE rather than handed to satori as a remote src, because satori's
 * own fetch has no timeout: a slow storage bucket would hold the render past
 * Discord's patience and the card would fail as a whole. This one gives up
 * after 1.5s and the caller falls back to initials — a card with a monogram is
 * a card; a card that never arrives is a broken embed.
 */
export async function avatarDataUri(url: string | null): Promise<string | null> {
  if (!url) return null;
  // Fails closed, which costs a monogram and nothing else: the caller already
  // draws initials for null. See isFetchableAvatarUrl for the SSRF this stops.
  if (!isFetchableAvatarUrl(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // A profile photo an order of magnitude bigger than this is not a profile
    // photo; refusing it keeps one bad row from stalling every card render.
    if (buf.byteLength > 3_000_000) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * A section label. One definition, because there are now six of them and they
 * have to be identical or the grid stops reading as a grid.
 */
function Label({ text }: { text: string }) {
  return (
    <div
      style={{
        display: 'flex',
        fontFamily: 'Barlow',
        fontWeight: 600,
        fontSize: 14,
        letterSpacing: 1.5,
        color: FAINT,
      }}
    >
      {text}
    </div>
  );
}

/**
 * One figure in the stat row.
 *
 * `accent` marks the club's primary discipline so the row has a first item
 * rather than four equal ones -- a red top edge and brighter ink, which is the
 * whole of the emphasis. Nothing here is a different SIZE, because four panels
 * of different heights stop being a grid.
 */
function StatPanel({
  label,
  value,
  sub,
  sub2,
  accent,
  dim,
}: {
  label: string;
  value: string;
  sub?: string | null;
  sub2?: string | null;
  accent?: boolean;
  dim?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        height: 132,
        padding: '14px 16px 0 16px',
        background: PANEL,
        border: `1px solid ${PANEL_LINE}`,
        borderTop: accent ? `2px solid ${RED}` : `1px solid ${PANEL_LINE}`,
      }}
    >
      <Label text={label} />
      <div
        style={{
          display: 'flex',
          fontFamily: 'Barlow Condensed',
          fontWeight: 700,
          fontSize: 50,
          lineHeight: 1.12,
          color: dim ? MUTE : INK,
        }}
      >
        {value}
      </div>
      <div style={{ display: 'flex', fontFamily: 'Barlow', fontWeight: 400, fontSize: 16, color: MUTE }}>
        {sub ?? ' '}
      </div>
      <div style={{ display: 'flex', fontFamily: 'Barlow', fontWeight: 400, fontSize: 16, color: FAINT }}>
        {sub2 ?? ' '}
      </div>
    </div>
  );
}

/**
 * THE RANKS, TOP RIGHT -- by default every one the member actually holds.
 *
 * This was a single big number: the better of the two ladders, at 58px. That
 * was wrong about the club. Two elos are ranked FOUR ways on /leaderboard --
 * Open Singles, Open Doubles, Comp Singles, Comp Doubles, where an open tab and
 * its comp twin differ only in population and not in rating
 * (leaderboard-client.tsx:259). A member holds two of those ranks, or four if
 * they are competitive, and a card showing one of them picked a winner without
 * saying there had been a contest.
 *
 * SO THE DEFAULT IS A TABLE, and the labels are the point of it. Down the side
 * the two disciplines, across the top the two populations. A rank means nothing
 * without both, and every earlier version of this block left one of them for
 * the reader to assume.
 *
 * `/profile type:` asks for ONE ladder instead, and that card gets the old big
 * badge back -- see RankBadge below. The table is what you get when you have
 * not said which you meant.
 *
 * THE COMP COLUMN IS ABSENT, NOT EMPTY, for a member who is not competitive,
 * which is most of the club. They get a narrower block with one column and the
 * name beside it gets the width back. That is why RANK_W has two values and why
 * the name's step-downs are keyed to the same condition.
 */
const RANK_W_OPEN = 128;
const RANK_W_BOTH = 196;

/** Whether the member has any comp standing at all. Decides the block's width. */
export function hasComp(profile: DiscordProfile): boolean {
  return profile.doubles?.compRank != null || profile.singles?.compRank != null;
}

/**
 * How much width the rank block takes off the name line.
 *
 * Exported because the name's font step-downs are computed from it rather than
 * hand-tuned against one layout -- when this block changes width, the name has
 * to know, and a constant in two places is how that goes wrong silently.
 */
export function rankBlockWidth(profile: DiscordProfile, focused: boolean): number {
  if (focused) return 132;
  return hasComp(profile) ? RANK_W_BOTH : RANK_W_OPEN;
}

function RankCell({ text, dim }: { text: string; dim?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        width: 62,
        justifyContent: 'flex-end',
        fontFamily: 'Barlow Condensed',
        fontWeight: 700,
        fontSize: 30,
        lineHeight: 1,
        color: dim ? MUTE : INK,
      }}
    >
      {text}
    </div>
  );
}

function RankHead({ text }: { text: string }) {
  return (
    <div
      style={{
        display: 'flex',
        width: 62,
        justifyContent: 'flex-end',
        fontFamily: 'Barlow',
        fontWeight: 600,
        fontSize: 12,
        letterSpacing: 1.4,
        color: '#e07070',
      }}
    >
      {text}
    </div>
  );
}

function RankRow({
  side,
  rank,
  compRank,
  comp,
}: {
  side: string;
  rank: number | null;
  compRank: number | null;
  comp: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div
        style={{
          display: 'flex',
          width: 14,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 13,
          letterSpacing: 1,
          color: FAINT,
        }}
      >
        {side}
      </div>
      {/* An em dash, not a blank. A member can sit on one ladder and not the
          other, and an empty cell would read as a rendering fault. */}
      <RankCell text={rank === null ? '—' : `#${rank}`} dim={rank === null} />
      {comp ? (
        <RankCell text={compRank === null ? '—' : `#${compRank}`} dim={compRank === null} />
      ) : null}
    </div>
  );
}

function RankGrid({ profile }: { profile: DiscordProfile }) {
  const comp = hasComp(profile);
  const { doubles, singles } = profile;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        width: rankBlockWidth(profile, false),
        height: 106,
        justifyContent: 'center',
        padding: '0 14px',
        background: 'rgba(204,0,0,0.13)',
        border: '1px solid rgba(204,0,0,0.45)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', width: 14 }} />
        <RankHead text="OPEN" />
        {comp ? <RankHead text="COMP" /> : null}
      </div>
      <RankRow
        side="D"
        rank={doubles ? doubles.rank : null}
        compRank={doubles ? doubles.compRank : null}
        comp={comp}
      />
      <RankRow
        side="S"
        rank={singles ? singles.rank : null}
        compRank={singles ? singles.compRank : null}
        comp={comp}
      />
    </div>
  );
}

function RankBadge({ rank, label }: { rank: number; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        width: 132,
        height: 106,
        background: 'rgba(204,0,0,0.13)',
        border: `1px solid rgba(204,0,0,0.45)`,
      }}
    >
      <div
        style={{
          display: 'flex',
          fontFamily: 'Barlow Condensed',
          fontWeight: 700,
          fontSize: 58,
          lineHeight: 1,
          color: INK,
        }}
      >
        {`#${rank}`}
      </div>
      <div
        style={{
          display: 'flex',
          marginTop: 6,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 13,
          letterSpacing: 1.6,
          color: '#e07070',
        }}
      >
        {label}
      </div>
    </div>
  );
}

/** A small outlined tag — the handle and the moderation status. */
function Chip({ text, tone }: { text: string; tone: 'quiet' | 'warn' }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 26,
        padding: '0 10px',
        border: `1px solid ${tone === 'warn' ? 'rgba(204,0,0,0.55)' : LINE}`,
        background: tone === 'warn' ? 'rgba(204,0,0,0.12)' : 'rgba(255,255,255,0.03)',
        fontFamily: 'Barlow',
        fontWeight: 600,
        fontSize: 14,
        letterSpacing: 1.1,
        color: tone === 'warn' ? '#e58a8a' : MUTE,
      }}
    >
      {text}
    </div>
  );
}

/**
 * A name cut down to fit, e.g. "Christopher Wong" -> "Christopher W.".
 *
 * satori supports neither text-overflow nor a measured width, so anything that
 * has to fit is shortened by rule rather than by the layout. A doubles row can
 * carry two names and the card is a fixed 1000px, so the pair is abbreviated
 * together or not at all -- one full name beside one initial reads as a
 * mistake.
 */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (parts.length < 2 || !last) return name;
  return `${parts[0]} ${last[0]}.`;
}

/**
 * The opposing side, named if the card is allowed to name them.
 *
 * The budget is 22 characters now, not 30: the recent block shares its row with
 * the rival panel and lost about a third of its width. A name that does not fit
 * is abbreviated, then dropped to a count -- never clipped, because satori
 * clips by overflowing the box rather than by truncating the string.
 */
function opponentLine(opponents: string[]): string | null {
  const first = opponents[0];
  if (!first) return null;
  const full = opponents.join(', ');
  if (full.length <= 22) return `vs ${full}`;
  const short = opponents.map(shortName).join(', ');
  if (short.length <= 22) return `vs ${short}`;
  return `vs ${shortName(first)} +${opponents.length - 1}`;
}

/**
 * One recent match.
 *
 * W AND L AS LETTERS, not a tick and a cross. Barlow ships here as latin,
 * latin-ext and vietnamese only, and satori draws a glyph outside those subsets
 * as a tofu box with no warning anywhere -- see CardAward. Every mark on this
 * row is a letter, a digit, a hyphen or the middot the card already uses.
 *
 * The partner in a doubles match is deliberately not named: two more names
 * would double the row's width budget on a card that cannot measure text, and
 * the D marker already says there was one.
 */
function MatchRow({ match }: { match: CardMatch }) {
  const versus = opponentLine(match.opponents);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 34 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          background: match.won ? RED : 'rgba(255,255,255,0.05)',
          border: `1px solid ${match.won ? RED : LINE}`,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 15,
          color: match.won ? '#ffffff' : MUTE,
        }}
      >
        {match.won ? 'W' : 'L'}
      </div>
      <div
        style={{
          display: 'flex',
          width: 14,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 15,
          color: FAINT,
        }}
      >
        {match.type === 'doubles' ? 'D' : 'S'}
      </div>
      <div
        style={{
          display: 'flex',
          width: 218,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 19,
          color: INK,
        }}
      >
        {match.score ?? 'no score recorded'}
      </div>
      <div
        style={{
          display: 'flex',
          fontFamily: 'Barlow',
          fontWeight: 400,
          fontSize: 17,
          color: MUTE,
        }}
      >
        {versus ?? ''}
      </div>
    </div>
  );
}

/**
 * Recent form, and the empty case is a finished thing rather than a gap.
 *
 * A member with no confirmed matches is a normal member -- new, or one who has
 * only ever played casually without a result being entered -- and the block
 * says so in the same voice the Unranked block uses.
 */
function RecentPanel({
  recent,
  discipline,
}: {
  recent: CardMatch[];
  discipline: MatchDiscipline | null;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        height: 156,
        padding: '14px 16px',
        background: PANEL,
        border: `1px solid ${PANEL_LINE}`,
      }}
    >
      <Label text="RECENT" />
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 6 }}>
        {recent.length > 0 ? (
          recent.map((m, i) => <MatchRow key={i} match={m} />)
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 34,
              fontFamily: 'Barlow',
              fontWeight: 400,
              fontSize: 18,
              color: MUTE,
            }}
          >
            {discipline ? `No ${discipline} matches on the record yet` : 'No matches on the record yet'}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The rival, as a panel rather than a line.
 *
 * It used to sit in a bare label/value row under recent form, where "none yet"
 * read as something missing from the card. A panel that is present and says
 * "none yet" reads as an answer -- and it gives the recent block a right-hand
 * edge to end against, which is what stops three match rows of different
 * lengths looking ragged.
 */
function RivalPanel({
  rival,
  discipline,
}: {
  rival: DiscordProfile['rival'];
  discipline: MatchDiscipline | null;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 268,
        height: 156,
        padding: '14px 16px',
        background: PANEL,
        border: `1px solid ${PANEL_LINE}`,
      }}
    >
      <Label text="RIVAL" />
      {rival ? (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
          <div
            style={{
              display: 'flex',
              fontFamily: 'Barlow Condensed',
              fontWeight: 700,
              // The panel is 268px wide with 32px of padding. Barlow Condensed
              // at 34px runs about 15 characters in what is left, so a longer
              // name steps down once and then abbreviates -- the same rule the
              // member's own name follows in the hero.
              fontSize: rival.name.length > 15 ? 26 : 34,
              lineHeight: 1.15,
              color: INK,
            }}
          >
            {rival.name.length > 20 ? shortName(rival.name) : rival.name}
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 8,
              fontFamily: 'Barlow Condensed',
              fontWeight: 700,
              fontSize: 40,
              lineHeight: 1,
              color: rival.wins >= rival.losses ? INK : MUTE,
            }}
          >
            {`${rival.wins}-${rival.losses}`}
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 4,
              fontFamily: 'Barlow',
              fontWeight: 400,
              fontSize: 15,
              color: FAINT,
            }}
          >
            {rival.wins >= rival.losses ? 'ahead in the series' : 'behind in the series'}
          </div>
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            marginTop: 10,
            height: 34,
            fontFamily: 'Barlow',
            fontWeight: 400,
            fontSize: 18,
            color: MUTE,
          }}
        >
          {discipline ? `Nobody played twice in ${discipline}` : 'Nobody played twice yet'}
        </div>
      )}
    </div>
  );
}

/**
 * The bottom rail — and the reserved home for awards.
 *
 * IT IS NOT AN EMPTY ROW WAITING TO BE FILLED. The rail exists in its own right
 * as the card's footer, carrying the club line every card needs; awards fill it
 * from the right when there are any. So the empty case — which is the only case
 * that exists today — is not a gap, and the day awards ship the layout does not
 * change at all.
 */
function Rail({
  awards,
  provisional,
  ranked,
}: {
  awards: CardAward[];
  provisional: boolean;
  /** Only a ranked card draws rating panels, so only it has clocks to explain. */
  ranked: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 'auto',
        borderTop: `1px solid ${LINE}`,
        paddingTop: 13,
      }}
    >
      {/* THE FOOTNOTE LIVES HERE, beside the club name, and it is the reason
          the rail's left half is a row rather than one label. The asterisk is
          drawn on the rating in the panel above; without this line the card
          shows an unexplained `*` on an image Discord caches publicly and
          forever, and a provisional rating with no footnote reads as settled.
          The rail is a fixed height with spare width, so this costs the card
          nothing -- which is why it is here and not in its own block. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            display: 'flex',
            fontFamily: 'Barlow',
            fontWeight: 600,
            fontSize: 14,
            letterSpacing: 1.7,
            color: FAINT,
          }}
        >
          SFU BADMINTON CLUB
        </div>
        {provisional ? (
          <div
            style={{
              display: 'flex',
              fontFamily: 'Barlow',
              fontWeight: 600,
              fontSize: 14,
              letterSpacing: 1.7,
              color: MUTE,
            }}
          >
            * RATING STILL PROVISIONAL
          </div>
        ) : null}
        {/* THE TWO NUMBERS IN A RATING PANEL ARE ON DIFFERENT CLOCKS, and the
            card never said so. activate_season REBASES elo at a rollover but
            resets no other counter, so the "24W 9L" and the "73% · W4" drawn
            under that big figure are cumulative across every season the member
            has played while the figure itself is not.

            HERE AND NOT IN THE PANEL. StatPanel is a fixed 132px with room for
            exactly two sub-lines, and satori CLIPS a fixed-height box rather
            than overflowing it, so a third line would vanish in silence and
            fail nothing -- the same trap rankSub records above. The rail is
            this card's footnote home for precisely that reason, which is why
            the provisional note already lives here.

            DELIBERATELY TERSE. Awards fill this rail from the right and the row
            is space-between, so every character spent here is headroom taken
            from the day they ship. Measured against the rendered cards: the
            club line and the provisional note together end near x=460 of 1000,
            and this adds roughly 250px to a rail with about 490px spare. */}
        {ranked ? (
          <div
            style={{
              display: 'flex',
              fontFamily: 'Barlow',
              fontWeight: 600,
              fontSize: 14,
              letterSpacing: 1.7,
              color: FAINT,
            }}
          >
            SEASON ELO · ALL-TIME RECORD
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {awards.slice(0, 4).map((a, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: `1px solid ${LINE}`,
              padding: '4px 10px',
              fontFamily: 'Barlow',
              fontWeight: 600,
              fontSize: 14,
              color: INK,
            }}
          >
            <div style={{ display: 'flex' }}>{a.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Win rate as a whole percent, or null when there is nothing to divide.
 *
 * A member with no completed matches has no win rate, and "0%" is a different
 * and much worse claim than nothing at all.
 */
function winRate(w: number, l: number): string | null {
  const played = w + l;
  if (played === 0) return null;
  return `${Math.round((w / played) * 100)}%`;
}

/** Win rate and streak, the two figures already in the payload and unused. */
function formLine(w: number, l: number, streak: number): string | null {
  const parts = [winRate(w, l), formatStreak(streak)?.label].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function record(w: number, l: number) {
  return `${w}W ${l}L`;
}

/**
 * The two sub-lines of a rating tile. What they carry depends on whether the
 * RANK BLOCK above has already said it.
 *
 *   default (RankGrid drawn):  "24W 9L"              /  "73% · W4"
 *   focused (RankBadge drawn): "#3 open · #1 comp"   /  "24W 9L · 73% · W4"
 *
 * A default card's grid lists every rank the member holds, so repeating one in
 * the tile underneath is noise -- the tile gives the space back to the record.
 * A focused card headlines ONE rank, so its tiles are the only place the other
 * three can appear, and they carry them.
 *
 * In the focused shape the record moves down a line rather than a third being
 * added: StatPanel is a fixed 132px with room for exactly two, and satori CLIPS
 * a fixed-height box rather than overflowing it, so a third line would vanish
 * in silence rather than fail anything. Same trap as the bio block; see H_BIO.
 */
function rankSub(l: LadderLine, focused: boolean): string {
  if (!focused) return record(l.wins, l.losses);
  return l.compRank === null
    ? `#${l.rank} · ${record(l.wins, l.losses)}`
    : `#${l.rank} open · #${l.compRank} comp`;
}

function formSub(l: LadderLine, focused: boolean): string | null {
  const form = formLine(l.wins, l.losses, l.streak);
  if (!focused || l.compRank === null) return form;
  return [record(l.wins, l.losses), form].filter(Boolean).join(' · ');
}

const AVATAR = 106;
const HEADER_GAP = 24;

/**
 * Barlow Condensed 700 costs about this much width per character, as a
 * fraction of the font size.
 *
 * MEASURED, not taken from a spec: 'Bartholomew Fitzgerald-Kensington' inks
 * 492px at 38px and 751px at 58px, both 0.392 em/char, and an ordinary two-word
 * name reads 0.420. 0.44 is above both with margin for a name whose letters run
 * wider than either -- a string of capital Ms measures 0.546, which no real
 * name approaches, and the render test asserts the step-downs hold for the
 * worst name the card admits rather than trusting this number alone.
 */
const NAME_EM = 0.44;

/**
 * The name's font size, from its length and the width the rank block leaves it.
 *
 * MEASURED, NOT TUNED. Barlow Condensed 700 runs about 0.40em per character at
 * these sizes, so the widest name that fits is roughly width / (0.40 * size).
 * The render test pins the actual figures at every block width by drawing the
 * name and counting lines -- a name that wraps is a name whose second line the
 * fixed-height header clips away in silence.
 */
/** What the header leaves the name: the card's own 50+40 padding, the avatar,
 *  the rank block, and the two gaps the header's flex row puts either side. */
function nameRoom(blockWidth: number): number {
  return W - 90 - AVATAR - blockWidth - 2 * HEADER_GAP;
}

/** The smallest step. Below this the name stops looking like the card's title. */
const NAME_MIN = 38;

export function nameSize(name: string, blockWidth: number): number {
  const room = nameRoom(blockWidth);
  for (const size of [58, 46, NAME_MIN]) {
    if (name.length * NAME_EM <= room / size) return size;
  }
  return NAME_MIN;
}

/**
 * The name as drawn, truncated if even the smallest step cannot hold it.
 *
 * THE STEP-DOWNS ALONE ARE NOT ENOUGH, which is not obvious and is why this
 * exists. nameSize bottoms out at 38px, so a name longer than 38px can hold
 * wraps -- and the header is a fixed 106px, so satori clips the second line
 * away rather than growing the card. The member's name would simply end
 * mid-word with nothing to say it had. An ellipsis is the honest version of
 * the same loss, and unlike the wrap it is visible.
 *
 * The threshold is not a character count anybody chose: it is whatever fits at
 * NAME_MIN in the room the rank block leaves, which differs between the comp
 * table, the open table and a focused card.
 */
export function cardName(name: string, blockWidth: number): string {
  const max = Math.floor(nameRoom(blockWidth) / (NAME_EM * NAME_MIN));
  if (name.length <= max) return name;
  return `${name.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/**
 * The one rank a focused card headlines, or null when that ladder holds nothing
 * for this member -- `/profile type:comp_singles` from somebody who is not
 * competitive, say. A null focus falls back to the table, which is the honest
 * answer: it shows what they DO hold rather than an empty box.
 */
function focusedRank(profile: DiscordProfile, focus: LadderFocus): number | null {
  const side = focus.endsWith('doubles') ? profile.doubles : profile.singles;
  if (!side) return null;
  return focus.startsWith('comp_') ? side.compRank : side.rank;
}

export function Card({
  profile,
  avatar,
  focus = null,
}: {
  profile: DiscordProfile;
  avatar: string | null;
  focus?: LadderFocus | null;
}) {
  const { doubles, singles } = profile;
  const height = cardHeight(profile);
  const focusRank = profile.ranked && focus ? focusedRank(profile, focus) : null;
  const focused = focusRank !== null;
  // WHICH DISCIPLINE THE BODY IS ABOUT, and it is derived from `focus` rather
  // than from `focused` on purpose. The route filtered recent form and the
  // rival on exactly this, before resolving, so anything else here would let
  // the card's wording disagree with the rows it was handed -- "no matches on
  // the record yet" under a card whose owner has twenty singles matches.
  // `focused` is a narrower question (is there a RANK to headline) and governs
  // the badge alone.
  const shown: MatchDiscipline | null = focus ? focusDiscipline(focus) : null;
  const bio = cardBio(profile.bio);

  return (
    <div style={{ position: 'relative', display: 'flex', width: W, height }}>
      <Background background={profile.background} height={height} />

      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          width: W,
          height,
          padding: '32px 40px 26px 50px',
        }}
      >
        {/* HERO. The avatar, who they are, and the one figure the eye should
            reach first. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, height: 106 }}>
          {avatar ? (
            <img
              src={avatar}
              width={106}
              height={106}
              style={{ width: 106, height: 106, objectFit: 'cover', border: `1px solid ${LINE}` }}
            />
          ) : (
            <div
              style={{
                width: 106,
                height: 106,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#161616',
                border: `1px solid ${LINE}`,
                fontFamily: 'Barlow Condensed',
                fontWeight: 700,
                fontSize: 46,
                color: MUTE,
              }}
            >
              {initials(profile.name)}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
            <div
              style={{
                display: 'flex',
                fontFamily: 'Barlow Condensed',
                fontWeight: 700,
                // satori supports neither text-overflow nor a fitted size, and
                // the card is a fixed 1000px -- so a long name is stepped down
                // by hand. What is left for it depends on which rank block is
                // drawn, so the thresholds are computed from that block's own
                // width rather than pinned to one layout: the widest block (the
                // comp table) leaves the least room and steps down soonest.
                // The measured figures are in the render test.
                fontSize: nameSize(profile.name, rankBlockWidth(profile, focused)),
                lineHeight: 1,
                letterSpacing: -0.5,
                color: INK,
              }}
            >
              {cardName(profile.name, rankBlockWidth(profile, focused))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {profile.handle ? <Chip text={`@${profile.handle}`} tone="quiet" /> : null}
              {profile.status ? <Chip text={profile.status.toUpperCase()} tone="warn" /> : null}
            </div>
          </div>

          {focused && focus ? (
            <RankBadge rank={focusRank} label={FOCUS_LABEL[focus]} />
          ) : profile.ranked ? (
            <RankGrid profile={profile} />
          ) : null}
        </div>

        {/* THE MEMBER'S OWN WORDS. Drawn on the card rather than sent as
            Discord message text, so the card is the whole post: the image is
            what gets forwarded, quoted and cached, and text beside it does not
            travel with it.

            HEIGHT IS FIXED, not measured, and that is what makes the block
            safe: cardHeight has committed the card to exactly H_BIO here, and
            a self-measuring div would let a long bio disagree with that number
            and crop the rail off the bottom. The cost of fixing it is that a
            third line is clipped in silence instead -- see H_BIO -- so cardBio
            truncates before it can come to that. */}
        {bio ? (
          <div
            style={{
              display: 'flex',
              marginTop: 18,
              height: 48,
              fontFamily: 'Barlow',
              fontWeight: 400,
              fontSize: 17,
              lineHeight: '24px',
              color: MUTE,
            }}
          >
            {bio}
          </div>
        ) : null}

        {/* THE GRID. Four panels for a ranked member, one for everyone else --
            and THREE on a focused card, because the discipline that was not
            asked for is dropped rather than dimmed. StatPanel is flex:1, so
            the remaining three widen to fill the row and nothing is left
            hanging; there is no fixed-width gap to patch.

            Dropping it is the same rule the panels below follow. A card
            headlined OPEN DOUBLES that still carried a SINGLES rating, three
            singles matches and a singles rival was the bug -- one line of the
            card was focused and the rest of it was not. */}
        {profile.ranked && doubles && singles ? (
          <div style={{ display: 'flex', gap: 12, marginTop: 22 }}>
            {shown !== 'singles' ? (
              <StatPanel
                label="DOUBLES"
                value={`${doubles.elo}${doubles.provisional ? '*' : ''}`}
                sub={rankSub(doubles, focused)}
                sub2={formSub(doubles, focused)}
                accent
              />
            ) : null}
            {shown !== 'doubles' ? (
              <StatPanel
                label="SINGLES"
                value={`${singles.elo}${singles.provisional ? '*' : ''}`}
                sub={rankSub(singles, focused)}
                sub2={formSub(singles, focused)}
                // The accent stripe marks the discipline the card is ABOUT. It
                // is doubles by default and sits on the panel above; on a
                // singles card that panel is gone, so the stripe moves here
                // rather than leaving the row with no accent at all.
                accent={shown === 'singles'}
              />
            ) : null}
            {/* ALL-TIME, and now it says so on the panel. The points come from
                get_leaderboard()'s SUM over tournament_participants and
                tournament_pairs (00316), which
                joins nothing to `tournaments` and so has no season predicate at
                all. Scoping it is a migration; saying which clock it is on is
                not, and the rail has no room left for a third clause. */}
            <StatPanel
              label="TOURNAMENT"
              value={String(profile.tournamentPoints ?? 0)}
              sub="points"
              sub2="all-time"
            />
            {/* Nights used to sit in a bare meta line with the rival, where a
                single digit beside a name read as an afterthought. It is a
                season-long figure like the three beside it and belongs in the
                same row.

                IT IS ONE NOW. This comment was false until the query behind it
                was joined to `sessions.season_id`: it counted every night the
                member had ever attended, so a long-standing member read NIGHTS
                214 on a card whose rail frames it as the season. See
                discord-profile.ts. */}
            <StatPanel
              label="NIGHTS"
              value={String(profile.nights ?? 0)}
              sub="attended"
            />
          </div>
        ) : (
          // NOT AN ERROR STATE. The member is off the public ladder — their own
          // setting, or a status the club set — and the card says so plainly
          // rather than printing zeroes that read as a real record.
          <div style={{ display: 'flex', marginTop: 22 }}>
            <StatPanel
              label="LADDER"
              value="Unranked"
              sub="not shown on the club ladder"
              dim
            />
          </div>
        )}

        {/* Only for a member the ladder lists. resolveProfile fetches none of
            this for anyone else -- their games are as private as the rating
            they chose to keep off the ladder -- so an unranked card keeps the
            shape it has always had, one block and the rail. */}
        {profile.ranked ? (
          <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
            <RecentPanel recent={profile.recent} discipline={shown} />
            <RivalPanel rival={profile.rival} discipline={shown} />
          </div>
        ) : null}

        <Rail awards={profile.awards} provisional={isProvisional(profile)} ranked={profile.ranked} />
      </div>
    </div>
  );
}
