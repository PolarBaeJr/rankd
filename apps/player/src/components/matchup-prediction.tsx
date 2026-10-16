import { clubDate } from '@badminton/shared';
import { predictionPercent } from '@/lib/prediction-match';

// One win prediction from the Data API, drawn the same on the challenge page
// (for a participant only) and the new-challenge form. No hooks, so it renders from a
// server page and inside the client form alike. It always says it is a
// prediction and that it does not touch ratings, because it sits beside
// figures that do.
export function MatchupPrediction({
  probability,
  sideLabel,
  model,
  madeAt,
  heading = 'Prediction',
}: {
  /** The named side's chance, 0 to 1. */
  probability: number;
  /** Who the percentage is for, as it reads in the sentence: "Team A", "you". */
  sideLabel: string;
  model: string;
  madeAt: string;
  heading?: string;
}) {
  const percent = predictionPercent(probability);
  return (
    <div
      style={{
        padding: 14,
        border: '1px solid var(--line)',
        borderRadius: 10,
        background: 'var(--surface)',
      }}
    >
      <div className="stat-label" style={{ marginBottom: 8 }}>{heading.toUpperCase()}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
        {percent}% chance {sideLabel} {sideLabel === 'you' ? 'win' : 'wins'}
      </div>
      <div
        aria-hidden
        style={{
          marginTop: 10,
          height: 6,
          borderRadius: 3,
          background: 'var(--surface-2)',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${percent}%`, height: '100%', background: 'var(--ink-2)' }} />
      </div>
      <p className="muted" style={{ margin: '10px 0 0', fontSize: 11, lineHeight: 1.5 }}>
        Model {model}, made {clubDate(madeAt)}. A prediction only. It does not affect ratings.
      </p>
    </div>
  );
}
