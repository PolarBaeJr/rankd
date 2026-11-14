import { describe, it, expect } from 'vitest';
import {
  BODY_HEIGHT,
  FOOTER_HEIGHT,
  HEADER_HEIGHT,
  SLIDE_HEIGHT,
  SLIDE_PADDING,
  pageHeight,
  paginate,
  type SlideBlock,
} from '../layout';

const teams = (n: number): SlideBlock[] => [{ title: null, lines: Array.from({ length: n }, (_, i) => `Team ${i + 1}`) }];
const groups = (count: number, size: number): SlideBlock[] =>
  Array.from({ length: count }, (_, g) => ({ title: `Group ${g + 1}`, lines: Array.from({ length: size }, (_, i) => `Entry ${g}-${i}`) }));

describe('slide layout', () => {
  it('adds up to the slide', () => {
    expect(2 * SLIDE_PADDING + HEADER_HEIGHT + BODY_HEIGHT + FOOTER_HEIGHT).toBe(SLIDE_HEIGHT);
  });

  it('never puts more on a slide than its body holds, for 1 to 64 teams', () => {
    for (let n = 1; n <= 64; n++) {
      const pages = paginate(teams(n));
      for (const page of pages) expect(pageHeight(page), `${n} teams`).toBeLessThanOrEqual(BODY_HEIGHT);
      expect(pages.flatMap((page) => page.flatMap((block) => block.lines))).toHaveLength(n);
    }
  });

  it('never overflows for 1 to 16 groups of 2 to 8, and keeps every entry once', () => {
    for (let count = 1; count <= 16; count++) {
      for (let size = 2; size <= 8; size++) {
        const pages = paginate(groups(count, size));
        for (const page of pages) expect(pageHeight(page), `${count}x${size}`).toBeLessThanOrEqual(BODY_HEIGHT);
        expect(pages.flatMap((page) => page.flatMap((block) => block.lines))).toHaveLength(count * size);
      }
    }
  });

  it('cuts a group too tall for one slide, keeping its title as continued', () => {
    const pages = paginate(groups(1, 40));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[1]![0]!.title).toBe('Group 1 (continued)');
  });

  it('is deterministic and never empty', () => {
    expect(paginate(groups(7, 5))).toEqual(paginate(groups(7, 5)));
    expect(paginate([])).toEqual([[]]);
  });
});
