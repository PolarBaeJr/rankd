'use client';

import { RouteError } from '@badminton/ui';

export default function FinancesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError area="FEE" title="Finances Error" error={error} reset={reset} fallback="Failed to load finances." />
  );
}
