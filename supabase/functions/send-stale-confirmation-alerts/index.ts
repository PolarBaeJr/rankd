// Runs daily via cron
// Alerts admins about match results awaiting confirmation for 48+ hours

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';
import { sendPushToPlayers } from '../_shared/push.ts';
import { WALKOVER_REVIEW_HOURS } from '../_shared/constants.ts';
import { alreadyAlertedIds, RE_ALERT_DAYS } from '../_shared/dedup.ts';

const ALERT_TITLE = 'Stale Match Confirmation';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  // Match confirmations intentionally share the walkover 48h review window.
  const cutoff = new Date(Date.now() - WALKOVER_REVIEW_HOURS * 60 * 60 * 1000).toISOString();

  // Find matches pending confirmation older than the review window
  const { data: stale, error } = await supabase
    .from('matches')
    .select('id, challenge_id, format, created_at')
    .eq('result_status', 'pending_confirmation')
    .lt('created_at', cutoff);

  if (error) {
    console.error('send-stale-confirmation-alerts error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  // Skip the ones already alerted about this week. Nothing clears
  // `pending_confirmation` on a timer — the only exits are a member confirming
  // or disputing — so without this every admin got a row AND a push about the
  // same dead match every single morning, forever. See _shared/dedup.ts.
  //
  // Deduped per MATCH, not per (admin × match): an admin who joins after the
  // first alert waits until the next weekly nudge rather than receiving the
  // whole backlog on their first morning.
  //
  // Not read at all on the common path, where nothing is stale.
  const alerted = (stale ?? []).length > 0
    ? await alreadyAlertedIds(supabase, {
        type: 'admin_alert',
        title: ALERT_TITLE,
        metadataKey: 'match_id',
      })
    : new Set<string>();
  if (!alerted) {
    // Fail CLOSED. Not knowing what has already been sent is exactly the state
    // in which re-sending everything is the wrong guess, and every one of these
    // records has been alerted about at least once already.
    return jsonResponse({ error: 'Could not read the notification ledger; nothing sent' }, 500);
  }

  const due = (stale ?? []).filter((m: { id: string }) => !alerted.has(m.id)) as Array<{
    id: string;
    format: string;
  }>;

  if (due.length > 0) {
    const { data: admins } = await supabase
      .from('players')
      .select('id')
      .in('role', ['admin', 'super_admin']);

    if (admins && admins.length > 0) {
      const alerts = admins.flatMap((admin: { id: string }) =>
        due.map((m) => ({
          player_id: admin.id,
          type: 'admin_alert',
          title: ALERT_TITLE,
          body: `${m.format} match awaiting confirmation for ${WALKOVER_REVIEW_HOURS}+ hours.`,
          metadata: { match_id: m.id },
        }))
      );
      // Inserted BEFORE the pushes, because the insert is what the next run
      // reads to decide it has already alerted. A push that fails after this
      // costs one buzz; an insert that happens after a successful push would
      // re-alert the whole set tomorrow if the function died in between.
      const { error: insertError } = await supabase.from('notifications').insert(alerts);
      if (insertError) {
        console.error('send-stale-confirmation-alerts insert failed:', insertError.message);
        return jsonResponse({ error: insertError.message }, 500);
      }

      const adminIds = admins.map((admin: { id: string }) => admin.id);
      for (const m of due) {
        // 'matches' — the same category the in-app result/dispute notifications
        // use. An admin is a member too, and an operational buzz nobody asked
        // for is how people learn to turn every notification off.
        await sendPushToPlayers(supabase, adminIds, {
          title: ALERT_TITLE,
          body: `${m.format} match awaiting confirmation for ${WALKOVER_REVIEW_HOURS}+ hours.`,
          url: '/notifications',
        }, 'matches');
      }
    }
  }

  console.log(
    `Found ${stale?.length ?? 0} stale match confirmations, alerted about ${due.length} ` +
      `(the rest were alerted within ${RE_ALERT_DAYS} days)`
  );
  return jsonResponse({ stale: stale?.length ?? 0, alerted: due.length });
});
