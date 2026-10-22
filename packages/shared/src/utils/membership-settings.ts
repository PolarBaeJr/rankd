// HOW A MEMBER PAYS, as one platform_settings row, key `membership_payments`:
//
//   sfss_purchase_url  where the membership is bought. The key says SFSS for
//                      historical reasons; today it is an SFU Recreation page.
//                      '' hides the button.
//   etransfer_email    the Interac e-Transfer recipient for club fees
//   etransfer_payee_name
//                      the name a member's bank shows that recipient as
//                      ("Sfu Badminton"). A receipt read on the server
//                      (00297) confirms itself only when it was sent to the
//                      club: this name, or the address above.
//
// Edited on /accounts by the generic settings form. No migration seeds the
// row: an absent row, or an absent field, reads as the default below. Every
// reader re-applies the rules below, so a hand-edited row cannot put a
// javascript: link on the membership page.
//
// Dependency-free, so a client component, a server page and a test can all
// import it deeply.

export const MEMBERSHIP_PAYMENTS_SETTING_KEY = 'membership_payments';

export const DEFAULT_MEMBERSHIP_PURCHASE_URL =
  'https://athleticsandrecreation.its.sfu.ca/Program/GetProgramDetails?courseId=b20a05ca-2754-4f11-ba1a-4a2ced47446c';

/** The row a first save starts from, and what an absent row stands for. */
export function defaultMembershipPaymentsValue(): {
  sfss_purchase_url: string;
  etransfer_email: string;
  etransfer_payee_name: string;
} {
  return { sfss_purchase_url: DEFAULT_MEMBERSHIP_PURCHASE_URL, etransfer_email: '', etransfer_payee_name: '' };
}

export interface MembershipPaymentSettings {
  sfssPurchaseUrl: string | null;
  etransferEmail: string | null;
  etransferPayeeName: string | null;
}

// Deliberately simple: one @, no whitespace, a dot in the domain. This is not
// an address validator, it is a guard against a typo being shown to members as
// the place to send money.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMAIL_MAX = 254;

const PAYEE_NAME_MAX = 100;

/** An https link, any host, no credentials. Returns it normalised, or null. */
export function safePurchaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.toString();
}

/** A plausible e-mail address, trimmed, or null. */
export function safeEtransferEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > EMAIL_MAX) return null;
  return EMAIL.test(trimmed) ? trimmed : null;
}

/** A payee name, trimmed and with its spaces collapsed, or null. */
export function safePayeeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > PAYEE_NAME_MAX) return null;
  return trimmed;
}

/**
 * The stored row as what the site may show. Never throws. An absent field is
 * its default; a stored value that fails its rule is hidden, not defaulted.
 */
export function parseMembershipPaymentSettings(value: unknown): MembershipPaymentSettings {
  const row =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const defaults = defaultMembershipPaymentsValue();
  const field = (key: keyof typeof defaults) => (Object.hasOwn(row, key) ? row[key] : defaults[key]);
  return {
    sfssPurchaseUrl: safePurchaseUrl(field('sfss_purchase_url')),
    etransferEmail: safeEtransferEmail(field('etransfer_email')),
    etransferPayeeName: safePayeeName(field('etransfer_payee_name')),
  };
}
