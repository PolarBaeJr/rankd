// THE SLIDE GRID, worked out before anything is drawn. satori cannot size a
// box to its content and crops whatever overflows without a word, so every
// height on a slide is a sum of the constants below and a slide never holds
// more than those sums allow. Pages are filled in order, the same way every
// time, so slide 3 of a set is always the same slide.

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;
export const SLIDE_PADDING = 72;
export const HEADER_HEIGHT = 250;
export const FOOTER_HEIGHT = 90;
export const BLOCK_TITLE_HEIGHT = 64;
export const ROW_HEIGHT = 58;
export const BLOCK_GAP = 28;

/** The height a slide gives its blocks. */
export const BODY_HEIGHT = SLIDE_HEIGHT - 2 * SLIDE_PADDING - HEADER_HEIGHT - FOOTER_HEIGHT;

export interface SlideBlock {
  /** "Group A", or none for a plain list of teams. */
  title: string | null;
  lines: string[];
}

export function blockHeight(block: SlideBlock): number {
  return (block.title ? BLOCK_TITLE_HEIGHT : 0) + block.lines.length * ROW_HEIGHT;
}

/** The height of a page's blocks with the gaps between them. */
export function pageHeight(blocks: readonly SlideBlock[]): number {
  return blocks.reduce((sum, block, index) => sum + blockHeight(block) + (index > 0 ? BLOCK_GAP : 0), 0);
}

/**
 * A block too tall for one slide, cut into pieces that each fit. A titled
 * block keeps its title on every piece, marked as continued.
 */
export function splitBlock(block: SlideBlock, capacity = BODY_HEIGHT): SlideBlock[] {
  const titleHeight = block.title ? BLOCK_TITLE_HEIGHT : 0;
  const perPiece = Math.max(1, Math.floor((capacity - titleHeight) / ROW_HEIGHT));
  if (block.lines.length <= perPiece) return [block];
  const pieces: SlideBlock[] = [];
  for (let start = 0; start < block.lines.length; start += perPiece) {
    pieces.push({
      title: block.title && start > 0 ? `${block.title} (continued)` : block.title,
      lines: block.lines.slice(start, start + perPiece),
    });
  }
  return pieces;
}

/**
 * Blocks into slides: each block whole where it fits, in order, a new slide
 * when the next one does not. Never an empty slide, and at least one.
 */
export function paginate(blocks: readonly SlideBlock[], capacity = BODY_HEIGHT): SlideBlock[][] {
  const pages: SlideBlock[][] = [];
  let current: SlideBlock[] = [];
  for (const piece of blocks.flatMap((block) => splitBlock(block, capacity))) {
    if (current.length > 0 && pageHeight([...current, piece]) > capacity) {
      pages.push(current);
      current = [];
    }
    current.push(piece);
  }
  if (current.length > 0 || pages.length === 0) pages.push(current);
  return pages;
}
