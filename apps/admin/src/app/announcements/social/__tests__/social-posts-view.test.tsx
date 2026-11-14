import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/components/toast-provider', () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock('@badminton/ui', async () => {
  const { Badge } = await import('@badminton/ui/src/components/Badge');
  const { Card } = await import('@badminton/ui/src/components/Card');
  const { PageHeader } = await import('@badminton/ui/src/components/PageHeader');
  const Button = ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>;
  return { Badge, Card, PageHeader, Button };
});

const { SocialPostsView } = await import('../[eventId]/social-posts-view');

describe('SocialPostsView', () => {
  it('lists each set with its slides, caption and copy button, a superseded set marked', () => {
    const html = renderToStaticMarkup(
      <SocialPostsView
        eventName="Fall Open Mixed Doubles"
        eventHref="/tournaments/t1/events/e1"
        resultsLine="Fall Open Mixed Doubles results: 1st Avery Placeholder & Blake Placeholder"
        sets={[
          { id: 'set-new', kind: 'teams_new', createdAt: 'Nov 10', superseded: false, caption: 'More teams joining.', slides: 1, entries: 1 },
          { id: 'set-old', kind: 'teams_full', createdAt: 'Nov 9', superseded: true, caption: 'Meet the teams!', slides: 2, entries: 20 },
        ]}
      />,
    );
    expect(html).toContain('Copy results');
    expect(html).toContain('New teams');
    expect(html).toContain('1 team / 1 slide');
    expect(html).toContain('20 teams / 2 slides');
    expect(html.match(/Superseded/g)).toHaveLength(1);
    expect(html).toContain('/api/social-posts/set-old/2');
    expect(html).toContain('Open image 2');
    expect(html.match(/Copy caption/g)).toHaveLength(2);
  });

  it('says what will appear when there is nothing yet', () => {
    const html = renderToStaticMarkup(<SocialPostsView eventName="Cup" eventHref="/x" resultsLine={null} sets={[]} />);
    expect(html).toContain('Nothing yet');
  });
});
