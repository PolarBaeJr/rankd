import Link from "next/link";
import { ExternalLink, LogIn } from "lucide-react";

// What a signed-out visitor sees where a member's sign-up buttons would be:
// the event's Google Form, which signs them up as a guest, or, when the event
// has no form, a way to sign in.
export function VisitorSignup({
  formUrl,
  open,
}: {
  formUrl: string | null;
  open: boolean;
}) {
  return (
    <div>
      <div>
        <div className="stat-label" style={{ marginBottom: 6 }}>
          Sign up
        </div>
        <div className="event-spot-title">
          {!open
            ? "Sign-ups are not open"
            : formUrl
              ? "Sign up with the Google Form"
              : "Members sign up in the app"}
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          {formUrl && open
            ? "No account needed. Members can also sign in and sign up here."
            : "Sign in to see your place and sign up."}
        </div>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 16 }}>
        {formUrl && open && (
          <a
            href={formUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary row"
            style={{ gap: 6 }}
          >
            Open the form <ExternalLink size={14} />
          </a>
        )}
        <Link
          href="/login"
          className={`btn ${formUrl && open ? "btn-ghost" : "btn-primary"} row`}
          style={{ gap: 6 }}
        >
          <LogIn size={14} /> Sign in
        </Link>
      </div>
    </div>
  );
}
