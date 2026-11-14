import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/toast-provider', () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock('@/lib/tournament-actions', () => ({ enterReserveAndCheckIn: vi.fn(), substituteEntry: vi.fn() }));
vi.mock('@/lib/tournament-actions/on-the-spot', () => ({ addExecOnTheSpot: vi.fn() }));
vi.mock('@badminton/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Dialog: ({ title, children }: { title: string; children: React.ReactNode }) => <div data-title={title}>{children}</div>,
}));

const { SubstituteDialog } = await import('../SubstituteDialog');
const { substitutionSummary } = await import('@/lib/substitution-summary');

const props = {
  eventId: 'e1',
  entryId: 'pair-1',
  isDoubles: true,
  label: 'Alice Out / Bob Partner',
  members: [{ id: 'alice', name: 'Alice Out' }, { id: 'bob', name: 'Bob Partner' }],
  spares: [{ id: 'carol', full_name: 'Carol Spare', avatar_url: null }],
  waitlist: [{ id: 'w1', player_id: 'res', joined_at: '2026-11-01T00:00:00Z', player: { id: 'res', full_name: 'Reserve One', avatar_url: null } }],
  execs: [{ id: 'x1', full_name: 'Exec One', avatar_url: null }],
  canEnterSpares: true,
  canOverride: false,
  summary: 'Takes over 3 unplayed matches in Group B.',
  onClose: () => {},
};

describe('SubstituteDialog', () => {
  it('asks partner or team, who goes out, and who comes in from each source, with the summary', () => {
    const html = renderToStaticMarkup(<SubstituteDialog {...props} initialOut="alice" onAddGuest={() => {}} />);
    expect(html).toContain('Sub for Alice Out / Bob Partner');
    expect(html).toContain('One partner');
    expect(html).toContain('The whole team');
    expect(html).toContain('Who goes out');
    expect(html).toContain('In for Alice Out');
    expect(html).toContain('Here and not playing');
    expect(html).toContain('Carol Spare');
    expect(html).toContain('Reserves, in order');
    expect(html).toContain('Reserve One');
    // A reserve is waiting, so no exec is offered yet.
    expect(html).toContain('Call or remove the reserves first.');
    expect(html).not.toContain('Exec One');
    expect(html).toContain('Add them on the spot');
    expect(html).toContain('Takes over 3 unplayed matches in Group B.');
    expect(html).toContain('A sub on its own adds no warning.');
    expect(html).not.toContain('restricted from entering events');
  });

  it('offers the execs once nobody waits, and says reserves wait for check-in during play', () => {
    const playing = renderToStaticMarkup(<SubstituteDialog {...props} initialOut="alice" reservesOpen={false} />);
    expect(playing).toContain('Reserves enter only during registration and check-in.');
    expect(playing).not.toContain('Reserve One');
    const empty = renderToStaticMarkup(<SubstituteDialog {...props} initialOut="alice" waitlist={[]} />);
    expect(empty).toContain('Exec One');
  });

  it('offers only who is here when reserves and execs cannot be entered, and the override to an exec', () => {
    const html = renderToStaticMarkup(<SubstituteDialog {...props} isDoubles={false} members={[{ id: 'alice', name: 'Alice Out' }]} canEnterSpares={false} canOverride />);
    expect(html).not.toContain('One partner');
    expect(html).toContain('In for Alice Out');
    expect(html).not.toContain('Reserve One');
    expect(html).toContain('restricted from entering events');
  });
});

describe('substitutionSummary', () => {
  const match = (status: string, group: number | null) => ({ status, group_number: group, a: 'pair-1', b: 'other', is_bye: false });
  it('counts the unplayed matches and their groups, and says the played ones stay', () => {
    expect(substitutionSummary([match('pending', 2), match('ready', 2), match('completed', 2), match('live', 2)], 'pair-1'))
      .toBe('Takes over 2 unplayed matches in Group B. 1 played match stays with whoever played it.');
    expect(substitutionSummary([], 'pair-1')).toBe('No unplayed matches yet: they take the place in the draw.');
  });
});
