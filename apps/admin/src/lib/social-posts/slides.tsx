import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BLOCK_GAP,
  BLOCK_TITLE_HEIGHT,
  BODY_HEIGHT,
  FOOTER_HEIGHT,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  SLIDE_HEIGHT,
  SLIDE_PADDING,
  SLIDE_WIDTH,
  type SlideBlock,
} from './layout';

// ONE SLIDE, 1080 x 1350 (Instagram's portrait post), drawn by satori through
// next/og. True black, pure red, the member app's display face. Every box has
// the height layout.ts gave it, and every line is one line: satori crops what
// overflows, so a long name is cut with an ellipsis rather than wrapped.

const BLACK = '#000000';
const RED = '#cc0000';
const INK = '#ffffff';
const MUTE = '#9a9a9a';
const LINE = 'rgba(255,255,255,0.14)';

// Read once per process. Copied from the player app (see src/fonts/README-ttf.md).
const fontFile = (file: string) => readFileSync(join(process.cwd(), 'src/fonts', file));
export const SLIDE_FONTS = [
  { name: 'Barlow Condensed', data: fontFile('BarlowCondensed-Bold.ttf'), weight: 700 as const, style: 'normal' as const },
  { name: 'Barlow', data: fontFile('Barlow-Regular.ttf'), weight: 400 as const, style: 'normal' as const },
  { name: 'Barlow', data: fontFile('Barlow-SemiBold.ttf'), weight: 600 as const, style: 'normal' as const },
];

const oneLine = {
  display: 'flex',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

export interface SlideProps {
  /** "MEET THE TEAMS", "NEW TEAMS", "THE DRAW". */
  eyebrow: string;
  eventName: string;
  /** Date and place, or null. */
  detail: string | null;
  blocks: SlideBlock[];
  index: number;
  total: number;
}

export function Slide({ eyebrow, eventName, detail, blocks, index, total }: SlideProps) {
  const inner = SLIDE_WIDTH - 2 * SLIDE_PADDING;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        padding: SLIDE_PADDING,
        background: BLACK,
        color: INK,
        fontFamily: 'Barlow',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', width: inner, height: HEADER_HEIGHT }}>
        <div style={{ ...oneLine, height: 40, fontSize: 30, fontWeight: 600, letterSpacing: 6, color: RED }}>{eyebrow}</div>
        <div style={{ ...oneLine, height: 130, alignItems: 'center', fontSize: 84, fontFamily: 'Barlow Condensed', fontWeight: 700 }}>
          {eventName}
        </div>
        <div style={{ ...oneLine, height: 44, fontSize: 32, color: MUTE }}>{detail ?? ''}</div>
        <div style={{ display: 'flex', width: 120, height: 8, marginTop: 28, background: RED }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', width: inner, height: BODY_HEIGHT }}>
        {blocks.map((block, blockIndex) => (
          <div
            key={blockIndex}
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: inner,
              height: (block.title ? BLOCK_TITLE_HEIGHT : 0) + block.lines.length * ROW_HEIGHT,
              marginTop: blockIndex > 0 ? BLOCK_GAP : 0,
            }}
          >
            {block.title ? (
              <div
                style={{
                  ...oneLine,
                  height: BLOCK_TITLE_HEIGHT,
                  alignItems: 'center',
                  fontSize: 40,
                  fontFamily: 'Barlow Condensed',
                  fontWeight: 700,
                  color: RED,
                }}
              >
                {block.title}
              </div>
            ) : null}
            {block.lines.map((line, lineIndex) => (
              <div
                key={lineIndex}
                style={{
                  ...oneLine,
                  height: ROW_HEIGHT,
                  alignItems: 'center',
                  fontSize: 38,
                  fontWeight: 600,
                  borderBottom: `1px solid ${LINE}`,
                }}
              >
                {line}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          width: inner,
          height: FOOTER_HEIGHT,
          alignItems: 'flex-end',
          justifyContent: 'flex-end',
          fontSize: 28,
          color: MUTE,
        }}
      >
        {total > 1 ? `${index} / ${total}` : ''}
      </div>
    </div>
  );
}
