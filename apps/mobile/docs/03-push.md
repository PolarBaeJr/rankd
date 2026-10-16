# Push notifications

Genuinely new, and further from the existing system than it looks.

`public.notifications` is **in app only**. A row there is something the web app
renders when the member next opens it. There is no delivery receipt and nothing
leaves the server.

Real push needs FCM credentials for Android, APNs for iOS, and a sender. Fold the
sender into the existing session reminder job rather than building a second one, and
copy that job's shape exactly: `reminder_attempted_at` is the CLAIM taken before the
send, `reminded_at` is the RECEIPT written after it returns. That split exists
because claiming the receipt up front turned any throw between claim and send into a
silent permanent drop. A push sender has the same failure mode and deserves the same
two columns.

Device tokens are personal data and they rotate. Whatever table holds them needs RLS
that lets a member see only their own, and a cleanup path for tokens the platform
reports as dead, or the club accumulates an ever growing list of phones that no
longer exist.
