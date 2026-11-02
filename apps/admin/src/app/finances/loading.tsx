// --bg-elevated, as /fees uses: the admin theme defines no `secondary`
// background, so a block painted with one renders transparent.
export default function FinancesLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-10 w-48 bg-[var(--bg-elevated)] rounded" />
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-[var(--bg-elevated)] rounded-lg" />
        ))}
      </div>
    </div>
  );
}
