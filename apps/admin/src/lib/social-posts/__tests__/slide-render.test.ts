import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ImageResponse } from 'next/og';
import { Slide, SLIDE_FONTS } from '../slides';
import { SLIDE_HEIGHT, SLIDE_PADDING, SLIDE_WIDTH, paginate, type SlideBlock } from '../layout';

// THE SLIDE IS ACTUALLY RENDERED HERE (the player card's render test explains
// why: satori never reports overflow, it crops). The bottom padding of a
// correct slide is clean black; a slide whose body ran past its box has ink
// there. Set SLIDE_RENDER_OUT to a directory to look at the PNGs.
//
// createElement rather than JSX, as in that test, so this stays a .ts file.

/** The brightest pixel in the bottom padding band, minus the row's median. */
function bottomPaddingInk(buf: Buffer): number {
  const png = PNG.sync.read(buf);
  let worst = 0;
  for (let y = png.height - SLIDE_PADDING + 4; y < png.height; y++) {
    const values: number[] = [];
    for (let x = 0; x < png.width; x++) {
      const index = (png.width * y + x) << 2;
      values.push(0.299 * (png.data[index] ?? 0) + 0.587 * (png.data[index + 1] ?? 0) + 0.114 * (png.data[index + 2] ?? 0));
    }
    const sorted = [...values].sort((a, b) => a - b);
    worst = Math.max(worst, Math.max(...values) - (sorted[sorted.length >> 1] ?? 0));
  }
  return worst;
}

async function render(blocks: SlideBlock[], name: string, total = 1) {
  const response = new ImageResponse(
    createElement(Slide, { eyebrow: 'MEET THE TEAMS', eventName: 'Sandpiper Open Mixed Doubles', detail: 'Saturday, November 21, West Gym', blocks, index: 1, total }),
    { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, fonts: SLIDE_FONTS },
  );
  const buf = Buffer.from(await response.arrayBuffer());
  const out = process.env.SLIDE_RENDER_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}.png`), buf);
  }
  return buf;
}

const LONG = 'Alexandria Placeholder-Featherstonehaugh & Bartholomew Placeholder-Montgomery';

describe('slide render', () => {
  it('a full page of teams, long names included, stays inside the slide', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? LONG : `Avery Placeholder & Team ${i + 1}`));
    const pages = paginate([{ title: null, lines }]);
    expect(pages.length).toBeGreaterThan(1);
    const buf = await render(pages[0]!, 'teams-full', pages.length);
    const png = PNG.sync.read(buf);
    expect({ width: png.width, height: png.height }).toEqual({ width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
    expect(bottomPaddingInk(buf)).toBeLessThan(20);
  }, 30_000);

  it('a full page of groups stays inside the slide', async () => {
    const blocks = Array.from({ length: 8 }, (_, g) => ({ title: `Group ${g + 1}`, lines: Array.from({ length: 4 }, (_, i) => `Entry ${g + 1}-${i + 1} & Partner Placeholder`) }));
    const pages = paginate(blocks);
    const buf = await render(pages[0]!, 'groups', pages.length);
    expect(bottomPaddingInk(buf)).toBeLessThan(20);
  }, 30_000);

  it('detects a body that overflows', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Overflowing Placeholder ${i + 1}`);
    const buf = await render([{ title: null, lines }], 'overflow');
    expect(bottomPaddingInk(buf)).toBeGreaterThan(60);
  }, 30_000);
});

describe('the slide fonts reach the container', () => {
  it('are traced into the slide route', () => {
    const config = readFileSync(join(process.cwd(), 'next.config.js'), 'utf8');
    expect(config).toContain("'/api/social-posts/[setId]/[slide]': ['./src/fonts/*.ttf']");
  });

  it('are TrueType, which satori can read', () => {
    for (const file of ['BarlowCondensed-Bold.ttf', 'Barlow-Regular.ttf', 'Barlow-SemiBold.ttf']) {
      expect(readFileSync(join(process.cwd(), 'src/fonts', file)).readUInt32BE(0), file).toBe(0x00010000);
    }
  });
});
