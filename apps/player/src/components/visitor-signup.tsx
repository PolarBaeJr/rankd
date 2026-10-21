import Link from 'next/link';
import { ExternalLink, LogIn } from 'lucide-react';

// What a signed-out visitor sees where a member's sign-up buttons would be:
// the event's Google Form, which signs them up as a guest, or, when the event
// has no form, a way to sign in.
export function VisitorSignup({ formUrl, open }: { formUrl: string | null; open: boolean }) {
  const formOpen = !!formUrl && open;
  return (
    <div>
      <div className="ev-label">{formOpen ? 'Not a member?' : 'Sign up'}</div>
      <div className="ev-spot-title">
        {!open ? 'Sign-ups are not open' : formUrl ? 'Anyone can come' : 'Members sign up in the app'}
      </div>
      <p className="ev-spot-detail">
        {formOpen
          ? "Fill in the club's Google Form and you are on the list as a guest. Google asks you to sign in first."
          : 'Sign in to see your place and sign up.'}
      </p>
      <div className="ev-spot-actions">
        {formOpen && (
          <a href={formUrl ?? undefined} target="_blank" rel="noopener noreferrer" className="btn btn-primary row" style={{ gap: 8 }}>
            Sign up with the form <ExternalLink size={14} />
          </a>
        )}
        <Link href="/login" className={`btn ${formOpen ? 'btn-ghost' : 'btn-primary'} row`} style={{ gap: 8 }}>
          <LogIn size={14} /> {formOpen ? 'Member? Sign in' : 'Sign in'}
        </Link>
      </div>
    </div>
  );
}
