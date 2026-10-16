import Link from 'next/link';
import {
  DISCORD_INVITE_URL,
  LEGAL_DOCUMENT_ORDER,
  LEGAL_DOCUMENT_SLUGS,
  LEGAL_DOCUMENT_SHORT_LABELS,
} from '@badminton/shared';

// Sits at the bottom of every page, inside <main> so it clears the fixed bottom
// nav via the same .pb-safe-nav padding the page content uses.
//
// A server component that FETCHES NOTHING. The legal links are derived from
// LEGAL_DOCUMENT_ORDER, not from a query, and a document with no row yet 404s
// on click, which is the honest outcome and one an admin fixes by publishing
// it. The social links arrive as a prop: the root layout already reads them
// once per request (getClubSocials) and decides whether the socials switch is
// on, so there is still no database round trip here.

export interface FooterSocials {
  showDiscord: boolean;
  instagramUrl: string | null;
}

const linkStyle = { fontSize: 12, textDecoration: 'none' } as const;

export function LegalFooter({ socials = null }: { socials?: FooterSocials | null }) {
  const hasSocials = socials !== null && (socials.showDiscord || socials.instagramUrl !== null);
  return (
    <footer
      style={{
        marginTop: 48,
        paddingTop: 20,
        borderTop: '1px solid var(--line)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px 14px',
        textAlign: 'center',
      }}
    >
      {hasSocials && (
        <nav
          aria-label="Club socials"
          style={{ width: '100%', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '4px 14px', marginBottom: 6 }}
        >
          {socials.showDiscord && (
            <a href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer" className="muted" style={linkStyle}>
              Discord
            </a>
          )}
          {socials.instagramUrl && (
            <a href={socials.instagramUrl} target="_blank" rel="noopener noreferrer" className="muted" style={linkStyle}>
              Instagram
            </a>
          )}
          <Link href="/socials" className="muted" style={linkStyle}>
            All socials
          </Link>
        </nav>
      )}
      {LEGAL_DOCUMENT_ORDER.map((document) => (
        <Link
          key={document}
          href={`/legal/${LEGAL_DOCUMENT_SLUGS[document]}`}
          className="muted"
          style={linkStyle}
        >
          {LEGAL_DOCUMENT_SHORT_LABELS[document]}
        </Link>
      ))}
      <Link href="/whats-new" className="muted" style={linkStyle}>
        What&apos;s new
      </Link>
      <span className="muted" style={{ fontSize: 12, width: '100%', marginTop: 4 }}>
        Club Ladder · Example Sports Centre
      </span>
    </footer>
  );
}
