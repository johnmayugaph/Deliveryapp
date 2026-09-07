'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ErrorSource, type ServiceKey } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth/session';
import {
  addCustomerMessage,
  createSupportTicket,
  TicketClosedError,
  TicketNotFoundError,
} from '@/lib/support/tickets';
import { MessageTooShortError } from '@/lib/support/policy';
import { reportError } from '@/lib/monitoring/report';

/**
 * What a customer can do about a problem.
 *
 * Both actions need an account, and that is a real limit rather than an
 * oversight: a thread has to belong to somebody or there is nowhere to put the
 * reply. The path for a person who CANNOT sign in is a phone number or an
 * email address on the help and recovery screens — see `lib/support/contact.ts`,
 * which exists precisely because this file cannot help them.
 */

export interface SupportActionResult {
  ok: boolean;
  message: string;
  /** Where to go next, on success. */
  ticketId?: string;
}

const SIGN_IN_FIRST: SupportActionResult = {
  ok: false,
  message: 'Sign in first, and your messages will be kept with your account.',
};

export async function openTicketAction(
  _previous: SupportActionResult | null,
  formData: FormData,
): Promise<SupportActionResult> {
  const user = await getCurrentUser();
  if (!user) return SIGN_IN_FIRST;

  const body = String(formData.get('body') ?? '');
  const subject = String(formData.get('subject') ?? '');
  const categorySlug = String(formData.get('categorySlug') ?? '').trim();
  const relatedOrderId = String(formData.get('relatedOrderId') ?? '').trim();
  // Cast, then validated against the registry inside `createSupportTicket`,
  // which throws for anything that is not a registered key. Nothing here
  // decides anything per service.
  const serviceType = String(formData.get('serviceType') ?? '').trim() as ServiceKey;

  let ticketId: string;
  try {
    const ticket = await createSupportTicket({
      userId: user.id,
      body,
      ...(subject.length > 0 ? { subject } : {}),
      ...(categorySlug.length > 0 ? { categorySlug } : {}),
      ...(relatedOrderId.length > 0 ? { relatedOrderId } : {}),
      ...(serviceType.length > 0 ? { serviceType } : {}),
    });
    ticketId = ticket.id;
  } catch (error) {
    if (error instanceof MessageTooShortError) {
      return { ok: false, message: error.message };
    }
    // Anything else is ours, not theirs. It goes to the monitoring pipeline so
    // a broken support form does not fail silently — which would be the single
    // worst thing in the application to have break quietly.
    await reportError(error, {
      source: ErrorSource.SERVER_ACTION,
      route: 'openTicketAction',
      userId: user.id,
    });
    return {
      ok: false,
      message:
        'Something went wrong sending that. Please try again — and if it keeps ' +
        'failing, the phone number on the help screen still works.',
    };
  }

  revalidatePath('/help/tickets');
  // OUTSIDE the try, because `redirect` works by throwing and the catch above
  // would treat a successful submission as an internal fault and report it.
  //
  // Redirecting from the server rather than pushing from the client is what
  // makes this form work with no JavaScript at all: the browser follows the
  // response. On the one screen somebody reaches when everything else has
  // failed, that is worth more than a nicer transition.
  redirect(`/help/tickets/${ticketId}`);
}

export async function replyToTicketAction(
  _previous: SupportActionResult | null,
  formData: FormData,
): Promise<SupportActionResult> {
  const user = await getCurrentUser();
  if (!user) return SIGN_IN_FIRST;

  const ticketId = String(formData.get('ticketId') ?? '').trim();
  const body = String(formData.get('body') ?? '');

  try {
    await addCustomerMessage({ ticketId, userId: user.id, body });
    revalidatePath(`/help/tickets/${ticketId}`);
    revalidatePath('/help/tickets');
    return { ok: true, ticketId, message: 'Sent.' };
  } catch (error) {
    if (
      error instanceof MessageTooShortError ||
      error instanceof TicketClosedError ||
      error instanceof TicketNotFoundError
    ) {
      return { ok: false, message: error.message };
    }
    await reportError(error, {
      source: ErrorSource.SERVER_ACTION,
      route: 'replyToTicketAction',
      userId: user.id,
    });
    return { ok: false, message: 'Something went wrong sending that. Please try again.' };
  }
}
