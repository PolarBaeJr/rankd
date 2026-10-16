import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// FIX-LIST #11 — "a suspension is published to every member".
//
// `players.status` carries two unrelated vocabularies. `competitive` and
// `recreational` are the member's own competitive track and are meant to be
// public; `suspended` and `pending_approval` are moderation decisions the club
// made about them. The ladder profile drew whichever one came back, so tapping
// a name in the feed told you the club had suspended that person.
//
// Two things are asserted, and they answer different questions. The unit tests
// pin the collapse itself. The source scan pins that no OTHER file in the
// members' app reaches the raw column through the member's own key — which is
// also the precondition 00151 needs before it can revoke the grant.

const maybeSingle = vi.fn();
vi.mock('../supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  }),
}));

const ROW = {
  id: 'p1',
  full_name: 'Bo Chen',
  avatar_url: null,
  status: 'suspended',
  bio: null,
  hide_from_leaderboard: false,
};

beforeEach(() => {
  maybeSingle.mockReset();
  maybeSingle.mockResolvedValue({ data: { ...ROW }, error: null });
});

describe('the moderation half of players.status does not leave the server', () => {
  it('another member sees no pill at all, not a relabelled one', async () => {
    const { getPublicProfile } = await import('../public-profile');
    const seen = await getPublicProfile('p1', { id: 'someone-else', role: 'player' });

    expect(seen?.visibleStatus).toBeNull();
    // The whole point: the word cannot be anywhere in what the component gets.
    expect(JSON.stringify(seen)).not.toContain('suspended');
  });

  it('the suspended member still sees their own status', async () => {
    const { getPublicProfile } = await import('../public-profile');
    const own = await getPublicProfile('p1', { id: 'p1', role: 'player' });

    // Hiding a suspension from the person under it would be a bug, not a
    // privacy feature — the same carve-out #14 makes for a hidden rating.
    expect(own?.visibleStatus).toBe('suspended');
  });

  it('the track half still reaches everybody, which is the half that is public', async () => {
    const { getPublicProfile } = await import('../public-profile');
    maybeSingle.mockResolvedValue({ data: { ...ROW, status: 'competitive' }, error: null });
    const seen = await getPublicProfile('p1', { id: 'other', role: 'player' });

    // WITHOUT THIS the three tests above all pass against a module that
    // returned null for everyone — which would silently delete a pill the
    // ladder has always drawn.
    expect(seen?.visibleStatus).toBe('competitive');
  });

  it('a pending-approval member is still invisible to other members', async () => {
    const { getPublicProfile } = await import('../public-profile');
    maybeSingle.mockResolvedValue({ data: { ...ROW, status: 'pending_approval' }, error: null });

    // players_select (00005) hides the ROW, not just the value. The service
    // role skips RLS, so dropping this check would have turned a privacy fix
    // into a widening — every unapproved signup's name and photo, readable.
    expect(await getPublicProfile('p1', { id: 'other', role: 'player' })).toBeNull();
    expect(await getPublicProfile('p1', { id: 'p1', role: 'player' })).not.toBeNull();
    expect(await getPublicProfile('p1', { id: 'other', role: 'admin' })).not.toBeNull();
  });
});

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const SRC = join(__dirname, '..', '..');
const rel = (f: string) => f.slice(SRC.length + 1).replace(/\\/g, '/');

// Every file that names `status` in a `players` query, and the client it uses.
// The rule this list encodes: reaching players.status is fine, reaching it with
// the MEMBER'S key is not — that is the read 00151 revokes.
const SERVICE_ROLE_READERS = new Map<string, string>([
  ['lib/public-profile.ts', 'service role, collapses the value before returning'],
  ['lib/discord-profile.ts', 'service role; collapses through statusForViewer(_, false) -- the card is public'],
  ['app/layout.tsx', "service role, own row by the session's verified user id"],
  ['lib/challengeable-opponents.ts', 'service role; status is a filter, never returned'],
  ['lib/reactivate.ts', 'service role, own row by verified user id'],
  ['app/api/calendar/[token]/route.ts', 'service role, row found by the feed token'],
  ['lib/passkey/login-assertion.ts', 'service role, pre-session lookup (both passkey verify routes)'],
  ['lib/discord-signup.ts', "service role; the new member's own row, read to say approved or pending"],
]);

describe('nothing reads players.status with the member\'s own key', () => {
  it('every reader is service-role, so 00151 can revoke the grant', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.includes('__tests__')) continue;
      const source = readFileSync(file, 'utf8');
      // Scoped to the QUERY, not the file. Half these files mention some other
      // `status` — a match result, a session state — and a file-wide grep
      // reports four false positives that then have to be allowlisted, which
      // would blunt the list into a list of files rather than of reads.
      // A chain runs from `from('players')` to the statement's semicolon.
      const queries = source.split(/from\('players'\)/).slice(1)
        .map((tail) => tail.split(';')[0] ?? '');
      // A filter counts as much as a select list: Postgres requires the SELECT
      // privilege for a column named in a WHERE clause too, so `.not('status',
      // ...)` would 403 under 00151 exactly as `select('status')` would.
      if (!queries.some((q) => /['"]status['"]|\bstatus\b/.test(q))) continue;
      if (!SERVICE_ROLE_READERS.has(rel(file))) offenders.push(rel(file));
    }
    expect(
      offenders,
      `these name players.status in a query and are not on the service-role list in ${rel(__filename)}. ` +
      'Either read it server-side with the service role, or 00151 will 403 this page.',
    ).toEqual([]);
  });

  it('the profile page no longer selects the column itself', () => {
    const page = readFileSync(join(SRC, 'app/leaderboard/[playerId]/page.tsx'), 'utf8');
    expect(page).not.toMatch(/from\('players'\)/);
    expect(page).toMatch(/getPublicProfile\(playerId, viewer\)/);
    // And it draws the decided field, never the raw one.
    expect(page).not.toMatch(/player\.status/);
    expect(page).toMatch(/player\.visibleStatus &&/);
  });
});
