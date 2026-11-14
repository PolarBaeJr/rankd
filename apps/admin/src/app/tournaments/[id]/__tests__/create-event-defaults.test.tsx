import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { TOURNAMENT_EVENT_FORMAT_LABELS } from '@badminton/shared';

// event_standard_defaults: a new event opens as pools then placement. The
// dialog renders open here so the format picker is in the markup.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('@/components/toast-provider', () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock('@/lib/tournament-actions', () => ({ createTournamentEvent: vi.fn() }));
vi.mock('@badminton/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { CreateEventButton } = await import('../create-event');

// The Select is a listbox button; its value span carries the chosen label.
const selectedFormat = (html: string) => html.match(/id="format"[\s\S]*?<span id="[^"]*-value"[^>]*>([^<]*)<\/span>/)?.[1];

describe('the event standard defaults for a new event', () => {
  it('opens as staged with the flag on and single elimination with it off', () => {
    expect(selectedFormat(renderToStaticMarkup(<CreateEventButton tournamentId="t1" standardDefaults />))).toBe(TOURNAMENT_EVENT_FORMAT_LABELS.staged);
    expect(selectedFormat(renderToStaticMarkup(<CreateEventButton tournamentId="t1" />))).toBe(TOURNAMENT_EVENT_FORMAT_LABELS.single_elimination);
  });
});
