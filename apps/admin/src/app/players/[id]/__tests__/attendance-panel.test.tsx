import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/toast-provider', () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock('@/lib/actions/attendance', () => ({
  createEntryRestriction: vi.fn(),
  liftEntryRestriction: vi.fn(),
  rescindAttendanceWarning: vi.fn(),
}));
vi.mock('@badminton/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfirm: () => async () => true,
}));

const { AttendancePanel, activeRestriction } = await import('../attendance-panel');

const NOW = Date.parse('2026-11-14T12:00:00Z');
const warning = (id: string, issued: string, rescinded: string | null = null) => ({
  id, kind: 'no_show', source: 'did_not_come', note: null, issued_at: issued,
  rescinded_at: rescinded, rescind_reason: null, where: 'Open Singles at Fall Open',
});

describe('activeRestriction', () => {
  it('is the one not lifted, started, and not yet ended', () => {
    const rows = [
      { id: 'lifted', reason: 'x', starts_at: '2026-10-01T00:00:00Z', ends_at: null, lifted_at: '2026-10-02T00:00:00Z' },
      { id: 'ended', reason: 'x', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z', lifted_at: null },
      { id: 'live', reason: 'x', starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z', lifted_at: null },
    ];
    expect(activeRestriction(rows, NOW)?.id).toBe('live');
    expect(activeRestriction(rows.slice(0, 2), NOW)).toBeNull();
  });
});

describe('AttendancePanel', () => {
  it('counts the live warnings, strikes the rescinded one, and offers a restriction', () => {
    const html = renderToStaticMarkup(
      <AttendancePanel
        playerId="p1"
        warnings={[
          warning('w1', new Date(Date.now() - 86_400_000).toISOString()),
          warning('w2', new Date(Date.now() - 86_400_000).toISOString(), new Date().toISOString()),
        ]}
        restrictions={[]}
        warningsOn
        restrictionsOn
        canRestrict
        canLift
      />,
    );
    expect(html).toContain('Warnings, 1 in the last 12 months');
    expect(html).toContain('line-through');
    expect(html).toContain('Open Singles at Fall Open');
    expect(html).toContain('Restrict');
  });

  it('shows an active restriction with Lift, and nothing a switch turned off', () => {
    const html = renderToStaticMarkup(
      <AttendancePanel
        playerId="p1"
        warnings={[]}
        restrictions={[{ id: 'r1', reason: 'Two no-shows', starts_at: '2026-01-01T00:00:00Z', ends_at: null, lifted_at: null }]}
        warningsOn={false}
        restrictionsOn
        canRestrict
        canLift
      />,
    );
    expect(html).toContain('Cannot enter events until an exec lifts it');
    expect(html).toContain('Lift');
    expect(html).not.toContain('Warnings,');
  });
});
