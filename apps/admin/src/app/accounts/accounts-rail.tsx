'use client';

import { useEffect, useState } from 'react';

export type AccountsRailSection = {
  id: string;
  label: string;
  sub: string;
  badge?: string;
  tone?: 'success' | 'warning';
};

/**
 * The /accounts section rail, with the highlight following the page.
 *
 * The rail was server-rendered with the first link always marked active, so
 * scrolling or clicking left "Member pages" lit whatever was on screen. This
 * is the scroll-spy /ratings uses: the "current" line sits where a link's
 * scroll-mt lands its section, below the sticky console header.
 */
export function AccountsRail({ sections }: { sections: AccountsRailSection[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');
  const sectionKey = sections.map((section) => section.id).join(' ');

  useEffect(() => {
    const ids = sectionKey.split(' ').filter(Boolean);
    const nodes = ids
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);
    if (nodes.length === 0) return;
    // The line is where a rail link lands its section: the section's own
    // scroll-margin-top. The header height alone sits higher than that, so a
    // click left the section above still across the line and lit it instead.
    const css = getComputedStyle(document.documentElement);
    const landing = parseFloat(getComputedStyle(nodes[0]!).scrollMarginTop);
    const line =
      (Number.isFinite(landing) && landing > 0
        ? landing
        : (parseFloat(css.getPropertyValue('--console-header-h')) || 0) +
          (parseFloat(css.getPropertyValue('--sticky-gap')) || 0)) + 1;

    // The last sections are short, so at the foot of the page they never climb
    // to the line. Reaching the bottom selects the last one instead, and the
    // observer checks it too: it fires after the scroll event and would
    // otherwise hand the highlight back to the section above.
    const lastId = ids[ids.length - 1]!;
    const atBottom = () => {
      const scroller = document.scrollingElement ?? document.documentElement;
      return scroller.scrollTop + window.innerHeight >= scroller.scrollHeight - 4;
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (atBottom()) {
          setActive(lastId);
          return;
        }
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target.id) setActive(visible.target.id);
      },
      { rootMargin: `-${line}px 0px -70% 0px`, threshold: 0 },
    );
    nodes.forEach((node) => observer.observe(node));

    const onScroll = () => {
      if (atBottom()) setActive(lastId);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, [sectionKey]);

  // Guarded on the count, not just on `lg`: a viewer holding neither
  // capability gets no sections at all, and an empty bordered nav is the blank
  // panel that reads as broken. The rule in globals.css must not set
  // `display`, so visibility stays on these utilities.
  return (
    <nav
      className={`settings-rail is-pill gap-1 lg:flex-col lg:sticky lg:self-start ${
        sections.length > 0 ? 'hidden lg:flex' : 'hidden'
      }`}
    >
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          className={section.id === active ? 'active' : undefined}
          aria-current={section.id === active ? 'true' : undefined}
          onClick={() => setActive(section.id)}
        >
          <span className="min-w-0">
            <span className="rail-label block">{section.label}</span>
            <span className="rail-sub block">{section.sub}</span>
          </span>
          {section.badge && (
            <span className={`rail-badge${section.tone ? ` is-${section.tone}` : ''}`}>{section.badge}</span>
          )}
        </a>
      ))}
    </nav>
  );
}
