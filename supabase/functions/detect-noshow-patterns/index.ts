// Runs daily via cron
// Flags players with 3+ no-shows in rolling 30 days for admin review
// Auto-suspends at configurable threshold

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  // Get thresholds from platform_settings
  const { data: setting } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'walkover_rules')
    .single();

  const flagThreshold: number = (setting?.value as Record<string, number>)?.no_show_auto_flag_threshold ?? 3;
  const rollingDays: number = (setting?.value as Record<string, number>)?.no_show_auto_flag_rolling_days ?? 30;
  const suspendThreshold: number = (setting?.value as Record<string, number>)?.no_show_auto_suspend_threshold ?? 5;

  const cutoff = new Date(Date.now() - rollingDays * 24 * 60 * 60 * 1000).toISOString();

  // Count no-shows per player in rolling window
  const { data: recentWalkovers, error } = await supabase
    .from('walkovers')
    .select('forfeit_player_id')
    .eq('walkover_type', 'no_show')
    .eq('status', 'confirmed')
    .gte('reported_at', cutoff);

  if (error) {
    console.error('detect-noshow-patterns error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  // Count per player
  const counts = new Map<string, number>();
  for (const w of (recentWalkovers ?? [])) {
    const pid = w.forfeit_player_id as string;
    counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }

  let flagged = 0;
  let suspended = 0;

  // Get all admins for notifications
  const { data: admins } = await supabase
    .from('players')
    .select('id')
    .in('role', ['admin', 'super_admin']);

  for (const [playerId, count] of counts) {
    if (count >= flagThreshold) {
      // Flag the player
      await supabase
        .from('reliability_metrics')
        .update({ walkover_flag: true, updated_at: new Date().toISOString() })
        .eq('player_id', playerId);

      // Notify admins
      if (admins && admins.length > 0) {
        const { data: player } = await supabase
          .from('players')
          .select('full_name')
          .eq('id', playerId)
          .single();

        const alerts = admins.map((admin: { id: string }) => ({
          player_id: admin.id,
          type: 'admin_alert',
          title: 'Repeated No-Show Pattern',
          body: `${player?.full_name ?? 'Unknown'} has ${count} no-shows in the last ${rollingDays} days.`,
          metadata: { flagged_player_id: playerId, no_show_count: count },
        }));
        await supabase.from('notifications').insert(alerts);
      }

      flagged++;
    }

    // Auto-suspend check (total no-shows, not just rolling)
    const { data: reliability } = await supabase
      .from('reliability_metrics')
      .select('no_shows')
      .eq('player_id', playerId)
      .single();

    if (reliability && reliability.no_shows >= suspendThreshold) {
      const { data: currentPlayer } = await supabase
        .from('players')
        .select('status')
        .eq('id', playerId)
        .single();

      if (currentPlayer && currentPlayer.status !== 'suspended') {
        await supabase
          .from('players')
          .update({ status: 'suspended', updated_at: new Date().toISOString() })
          .eq('id', playerId);

        await supabase.from('audit_logs').insert({
          actor_id: null,
          action_type: 'auto_suspend',
          target_type: 'player',
          target_id: playerId,
          old_value: { status: currentPlayer.status },
          new_value: { status: 'suspended' },
          reason: `Auto-suspended: ${reliability.no_shows} total no-shows exceeded threshold of ${suspendThreshold}`,
        });

        suspended++;
      }
    }
  }

  console.log(`Flagged ${flagged}, suspended ${suspended}`);
  return jsonResponse({ flagged, suspended });
});
