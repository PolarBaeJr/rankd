import { featureAccessFor, featureGate } from '@badminton/shared';
import { getFeatureFlags } from './feature-gate';
import { createServerSupabaseClient } from './supabase-server';
import type { MatchupPrediction, PredictionFormat } from './prediction-match';

// WIN PREDICTIONS POSTED THROUGH THE DATA API (00282), on the members' side.
// They have no page of their own, so the `predictions` switch is enforced here
// rather than by a FeatureGate: every card that shows one asks
// predictionsVisible first. A viewer holding `page.access.predictions` still
// sees them while the switch is off, the same as any switched-off page.
//
// Both reads are SECURITY DEFINER functions granted to authenticated. They
// hide any matchup naming a member who is not published, and never say which
// consumer made a prediction. A failed read is "no prediction", never an error
// on the page around it.

export async function predictionsVisible(
  viewer: Parameters<typeof featureAccessFor>[0],
): Promise<boolean> {
  const flags = await getFeatureFlags();
  return featureGate(flags.predictions, featureAccessFor(viewer).includes('predictions')) !== 'redirect';
}

type Row = {
  format: PredictionFormat;
  side_a: string[];
  side_b: string[];
  side_a_win_probability: number | string;
  model: string;
  made_at: string;
};

function toPrediction(row: Row): MatchupPrediction {
  return {
    format: row.format,
    sideA: row.side_a,
    sideB: row.side_b,
    probability: Number(row.side_a_win_probability),
    model: row.model,
    madeAt: row.made_at,
  };
}

/** The newest prediction for one matchup, oriented to `sideA`, or null. */
export async function getMatchupPrediction(
  format: PredictionFormat,
  sideA: string[],
  sideB: string[],
): Promise<MatchupPrediction | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_matchup_prediction', {
    p_format: format,
    p_side_a: sideA,
    p_side_b: sideB,
  });
  if (error) {
    console.error('[predictions] get_matchup_prediction failed:', error.message);
    return null;
  }
  const row = (data as Omit<Row, 'format' | 'side_a' | 'side_b'>[] | null)?.[0];
  return row ? toPrediction({ ...row, format, side_a: sideA, side_b: sideB }) : null;
}

/** Every prediction naming the viewer, oriented with the viewer on side A. */
export async function getMyPredictions(): Promise<MatchupPrediction[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_my_predictions');
  if (error) {
    console.error('[predictions] get_my_predictions failed:', error.message);
    return [];
  }
  return ((data as Row[] | null) ?? []).map(toPrediction);
}
