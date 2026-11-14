import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/toast-provider', () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock('@/lib/tournament-actions', () => ({
  enterReserveAndCheckIn: vi.fn(),
  releaseCheckinNoShows: vi.fn(),
  removeFromWaitlist: vi.fn(),
}));
vi.mock('@/lib/tournament-actions/on-the-spot', () => ({ addExecOnTheSpot: vi.fn() }));
vi.mock('@badminton/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfirm: () => async () => true,
}));

const { FillEmptyPlaces } = await import('../FillEmptyPlaces');

const props = {
  eventId: 'e1',
  unreleased: 2,
  openPlaces: 1,
  execs: [{ id: 'x1', full_name: 'Exec One', avatar_url: null }],
  canRelease: true,
  canAdd: true,
  warns: true,
};

describe('FillEmptyPlaces', () => {
  it('releases first, lists the reserves, and holds the execs back while a reserve waits', () => {
    const html = renderToStaticMarkup(
      <FillEmptyPlaces {...props} waitlist={[{ id: 'w1', player_id: 'p1', joined_at: '2026-11-01T00:00:00Z', player: { id: 'p1', full_name: 'Reserve One', avatar_url: null } }]} />,
    );
    expect(html).toContain('Release 2 not checked in');
    expect(html).toContain('Reserve One');
    expect(html).toContain('Call or remove the reserves first.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Add and check in/);
    expect(html).toContain('1 place open');
  });

  it('offers the execs once nobody is waiting', () => {
    const html = renderToStaticMarkup(<FillEmptyPlaces {...props} waitlist={[]} />);
    expect(html).toContain('Nobody is waiting.');
    expect(html).not.toContain('Call or remove the reserves first.');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]{0,200}Add and check in/);
  });
});
