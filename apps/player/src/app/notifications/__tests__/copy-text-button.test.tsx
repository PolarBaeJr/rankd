import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/components/toast-provider', () => ({ useToast: () => ({ toast: () => {} }) }));

const { CopyTextButton } = await import('../CopyTextButton');

describe('CopyTextButton (00333)', () => {
  it('is a real button outside any link, carrying the text it copies', () => {
    const html = renderToStaticMarkup(<CopyTextButton text="Cup results: 1st Avery Placeholder" />);
    expect(html).toContain('<button type="button"');
    expect(html).toContain('Copy text');
    expect(html).toContain('data-copy-text="Cup results: 1st Avery Placeholder"');
    expect(html).not.toContain('<a ');
  });
});
