import * as Sentry from '@sentry/nextjs';
import { clubToday, consoleAccessLevelFor, permissionsOf, permits } from '@badminton/shared';
import { getCurrentPlayer, createServiceRoleClient } from '@/lib/supabase-server';
import { assembleMemberExport } from '@/lib/data-export/assemble';

// Never cached, for the reason /api/account/export gives: a cached export is
// one person's data served to another.
export const dynamic = 'force-dynamic';

// A GUEST'S DATA EXPORT (00292), downloaded by an exec for them.
//
// A guest is a Google Form entrant given a record to play a linked tournament.
// They cannot sign in, so they cannot use /api/account/export; their access
// request reaches the club by email and an exec downloads the same document a
// member would get, then sends it on. The assembler is the member export's, so
// a guest gets exactly what a member gets.
//
// The gate is the console's own: good standing and players.read, resolved by
// the same functions the console uses. The target must be a guest that has not
// been erased: a member exports their own data, and this route must not become
// a way for an exec to pull any member's file.
export async function GET(_request: Request, { params }: { params: Promise<{ playerId: string }> }) {
  const json = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });

  const viewer = await getCurrentPlayer();
  if (!viewer) return json(401, 'Not authenticated');
  const level = consoleAccessLevelFor(viewer);
  if (!level || !permits(level, permissionsOf(level, viewer), 'players.read')) {
    return json(403, 'Not allowed');
  }

  const { playerId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(playerId)) return json(404, 'Not found');
  const admin = createServiceRoleClient();
  const { data: guest, error } = await admin
    .from('players')
    .select('id, is_guest, user_id, email')
    .eq('id', playerId)
    .maybeSingle();
  if (error) return json(503, 'Could not read the record. Try again.');
  if (!guest || !guest.is_guest || guest.user_id || String(guest.email).endsWith('@deleted.invalid')) {
    return json(404, 'Not a guest');
  }

  const result = await assembleMemberExport(admin, playerId);
  if (!result.ok) {
    Sentry.captureException(new Error(`Guest data export failed: ${result.failures.join('; ')}`), {
      extra: { playerId, failures: result.failures },
    });
    return json(503, 'The export could not be completed, and nothing partial was sent. Try again.');
  }

  const { error: auditError } = await admin.from('audit_logs').insert({
    actor_id: viewer.id,
    action_type: 'guest_data_exported',
    target_type: 'player',
    target_id: playerId,
    new_value: { assembly_completed_at: result.document.manifest.assembly_completed_at },
    reason: "An exec downloaded a guest's data on their request",
  });
  if (auditError) {
    Sentry.captureException(new Error(`Guest export audit write failed: ${auditError.message}`), {
      extra: { playerId },
    });
  }

  return new Response(JSON.stringify(result.document, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="club-ladder-guest-data-${clubToday()}.json"`,
      'Cache-Control': 'no-store, private, max-age=0, must-revalidate',
      'X-Robots-Tag': 'noindex',
    },
  });
}
