// Runs hourly via cron
// Auto-escalates walkover reports unreviewed past the admin review window to an
// admin alert. The window is platform_settings.walkover_rules
// .admin_review_window_hours, which the admin panel edits; WALKOVER_REVIEW_HOURS
// is only the fallback for an unreadable row. Previously the constant was used
// unconditionally, so walkovers escalated at 48h no matter what the panel said.

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';
import { WALKOVER_REVIEW_HOURS } from '../_shared/constants.ts';
import { getPlatformSettingNumber } from '../_shared/settings.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  const reviewHours = await getPlatformSettingNumber(
    supabase,
    'walkover_rules',
    'admin_review_window_hours',
    WALKOVER_REVIEW_HOURS,
  );

  const cutoff = new Date(Date.now() - reviewHours * 60 * 60 * 1000).toISOString();

  // Find pending walkovers older than the review window
  const { data: stale, error } = await supabase
    .from('walkovers')
    .select('id, challenge_id, forfeit_player_id, walkover_type, reported_at')
    .eq('status', 'pending')
    .lt('reported_at', cutoff);

  if (error) {
    console.error('expire-walkover-pending error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  if (stale && stale.length > 0) {
    // Get all admin players
    const { data: admins } = await supabase
      .from('players')
      .select('id')
      .in('role', ['admin', 'super_admin']);

    if (admins && admins.length > 0) {
      const alerts = admins.flatMap((admin: { id: string }) =>
        (stale as Array<{ id: string; forfeit_player_id: string; walkover_type: string }>).map((w) => ({
          player_id: admin.id,
          type: 'admin_alert',
          title: 'Stale Walkover Report',
          // Must use the resolved window, not the constant — otherwise the
          // alert claims 48h while the cutoff that selected these rows was 72h.
          body: `Walkover report unreviewed for ${reviewHours}+ hours. Type: ${w.walkover_type}`,
          metadata: { walkover_id: w.id },
        }))
      );
      await supabase.from('notifications').insert(alerts);
    }
  }

  console.log(`Found ${stale?.length ?? 0} stale walkover reports`);
  return jsonResponse({ stale: stale?.length ?? 0 });
});
