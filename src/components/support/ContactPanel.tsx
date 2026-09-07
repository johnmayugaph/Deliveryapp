import type { ContactDetails } from '@/lib/support/contact';

/**
 * How to reach a person without signing in.
 *
 * Rendered on /help and on /recover, and both of those are public routes — that
 * is the entire point. Somebody who cannot get a code on their old SIM cannot
 * raise a ticket, so a ticket form is not a support channel for them.
 *
 * When nothing is configured it says so, in the plainest words available. The
 * alternative — showing nothing — leaves a screen that looks finished and a
 * person with no idea that there is no way through.
 */

const GLYPH: Readonly<Record<ContactDetails['channels'][number]['kind'], string>> = {
  phone: '📞',
  email: '✉️',
  facebook: '💬',
};

export function ContactPanel({
  contact,
  /** On /recover the framing is different: this is the only path left. */
  tone = 'help',
}: {
  contact: ContactDetails;
  tone?: 'help' | 'recovery';
}) {
  if (contact.channels.length === 0) {
    return (
      <section
        aria-labelledby="contact-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="contact-heading" className="text-sm font-semibold">
          Talk to a person
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          There is no phone number or email set up on this deployment yet. If you
          are signed in you can still send us a message and we will reply in the
          app.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="contact-heading"
      className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
    >
      <h2 id="contact-heading" className="text-sm font-semibold">
        Talk to a person
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        {tone === 'recovery'
          ? 'You do not need to be signed in for this. Have your old number and ' +
            'a recent order ready — it is how we know the account is yours.'
          : 'You do not need an account for this.'}
      </p>

      <ul className="mt-3 space-y-2">
        {contact.channels.map((channel) => (
          <li key={channel.href}>
            <a
              href={channel.href}
              className="flex items-center gap-2.5 rounded-xl bg-surface-sunken px-3 py-2.5 text-sm font-semibold text-brand-700"
            >
              <span aria-hidden className="text-base leading-none">
                {GLYPH[channel.kind]}
              </span>
              {channel.label}
            </a>
          </li>
        ))}
      </ul>

      {contact.hours ? (
        <p className="mt-2 text-[11px] text-ink-faint">{contact.hours}</p>
      ) : null}
    </section>
  );
}
