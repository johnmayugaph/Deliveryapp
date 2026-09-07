import { tryNormalisePhilippineMobile, formatPhilippineMobile } from '@/lib/auth/phone';

/**
 * How to reach a person WITHOUT signing in.
 *
 * This module exists because of a hole the ticket system cannot fill. A ticket
 * needs an account; the person who most urgently needs support is the one who
 * cannot get into their account — they lost the SIM, the code never arrives,
 * the number now belongs to somebody else. For them, an in-app form is not a
 * support channel. It is a locked door with a note on it.
 *
 * So there are two paths and they are not alternatives:
 *
 *   - signed in  → a ticket, which is a thread with a record on both sides
 *   - signed out → a phone number, an email address, a Facebook page: whatever
 *                  is configured here, shown on /help and on /recover
 *
 * Everything is optional and NOTHING is invented. A hardcoded number that
 * nobody answers is worse than no number, because somebody will ring it during
 * the one hour they needed help. When none of it is set, the screens say so
 * plainly and /admin/health reports it — see `contactPosture`.
 */

export interface ContactChannel {
  kind: 'phone' | 'email' | 'facebook';
  /** What a person reads. */
  label: string;
  /** `tel:`, `mailto:` or an https URL. */
  href: string;
}

export interface ContactDetails {
  channels: ContactChannel[];
  /** Free text from the environment: "9am–9pm, every day". */
  hours: string | null;
}

/**
 * Reads the environment. Takes the environment as an argument so the tests can
 * pass one in rather than mutating `process.env` and racing each other.
 */
export function contactDetails(
  env: Record<string, string | undefined> = process.env,
): ContactDetails {
  const channels: ContactChannel[] = [];

  // Validated, not just trimmed: a mistyped number renders as a `tel:` link
  // that silently dials nothing, and nobody testing the happy path would ever
  // notice.
  const phone = tryNormalisePhilippineMobile(env.SUPPORT_PHONE ?? '');
  if (phone !== null) {
    channels.push({
      kind: 'phone',
      label: formatPhilippineMobile(phone),
      href: `tel:${phone}`,
    });
  }

  const email = (env.SUPPORT_EMAIL ?? '').trim();
  // Deliberately the crudest possible check. Validating an address properly is
  // a losing game, and the failure this needs to catch is an empty variable or
  // a placeholder, not an exotic RFC 5322 form.
  if (email.length > 3 && email.includes('@') && !email.includes(' ')) {
    channels.push({ kind: 'email', label: email, href: `mailto:${email}` });
  }

  const facebook = (env.SUPPORT_FACEBOOK ?? '').trim();
  // https only, because this is rendered as a link somebody taps. It is a
  // Facebook page rather than an oversight: in the Philippines a Page inbox is
  // how most people expect to reach a business, and it costs nothing to run.
  if (facebook.startsWith('https://')) {
    channels.push({
      kind: 'facebook',
      label: facebook.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, ''),
      href: facebook,
    });
  }

  const hours = (env.SUPPORT_HOURS ?? '').trim();
  return { channels, hours: hours.length > 0 ? hours : null };
}

export type ContactPosture = 'none' | 'configured';

/**
 * Whether somebody locked out of their account can reach anybody at all.
 *
 * `none` is a launch blocker rather than a warning, and the health page says
 * so: every other gap in this application costs somebody a feature, and this
 * one costs them their account with no way to say so.
 */
export function contactPosture(
  env: Record<string, string | undefined> = process.env,
): ContactPosture {
  return contactDetails(env).channels.length > 0 ? 'configured' : 'none';
}

/** One sentence for the health page. */
export function describeContactPosture(
  env: Record<string, string | undefined> = process.env,
): string {
  const { channels } = contactDetails(env);
  if (channels.length === 0) {
    return (
      'Nobody who cannot sign in has any way to reach you. Set SUPPORT_PHONE, ' +
      'SUPPORT_EMAIL or SUPPORT_FACEBOOK — a number in a group chat is enough, ' +
      'as long as somebody is watching it.'
    );
  }
  return `${channels.map((channel) => channel.label).join(', ')} — shown on the help and recovery screens.`;
}
