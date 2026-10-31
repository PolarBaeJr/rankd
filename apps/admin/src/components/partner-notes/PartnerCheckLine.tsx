'use client';

import { Badge, Button } from '@badminton/ui';
import type { PartnerAdvice } from '@/lib/partner-check';

/**
 * The partner check under one sign-up (00311): what they wrote on the Form,
 * whether the desk has chosen, and what is wrong with it. Read-only; the
 * Resolve button opens the contest dialog when somebody asked for by several
 * people can be paired.
 */
export function PartnerCheckLine({
  advice,
  onResolve,
}: {
  advice: PartnerAdvice | undefined;
  onResolve?: () => void;
}) {
  if (!advice) return null;
  const hasWrote = !!advice.wrote && advice.wrote.trim() !== '';
  if (!hasWrote && !advice.desk && advice.badges.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
      {hasWrote && <span className="truncate text-xs text-[var(--mute)]">Wrote: {advice.wrote}</span>}
      {advice.desk && (
        <Badge variant="info">{advice.desk === 'none' ? 'Desk: no preferred partner' : 'Set by the desk'}</Badge>
      )}
      {advice.badges.map((badge) => (
        <Badge key={badge.text} variant={badge.tone}>
          {badge.text}
        </Badge>
      ))}
      {onResolve && advice.contested && advice.pairable.length > 0 && (
        <Button size="sm" variant="secondary" onClick={onResolve}>
          Resolve
        </Button>
      )}
    </div>
  );
}
