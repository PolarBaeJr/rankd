import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/components/toast-provider', () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock('@/lib/tournament-actions', () => ({ recordPlayerLeft: vi.fn() }));

const { PlayerLeftDialog } = await import('../PlayerLeftDialog');

describe('PlayerLeftDialog', () => {
  it('asks for a reason, and says only leaving without telling anyone warns', () => {
    const html = renderToStaticMarkup(
      <PlayerLeftDialog eventId="e1" entryId="p1" label="Ann" onClose={() => {}} />,
    );
    for (const label of ['Injured', 'Told the organizers they were leaving', 'An emergency', 'Another reason (say what)', 'Left without telling anyone']) {
      expect(html).toContain(label);
    }
    expect(html.match(/Adds an attendance warning to their record\./g)).toHaveLength(1);
    expect(html).toContain('Any other reason is recorded with no warning.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Mark as left/);
  });
});
