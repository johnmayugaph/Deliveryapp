'use server';

import { revalidatePath } from 'next/cache';
import { SupportTicketPriority, type SupportTicketStatus } from '@prisma/client';
import {
  AdminAccessRequiredError,
  requireAdmin,
  type AdminActionResult,
} from '@/lib/admin/access';
import {
  addSupportReply,
  assignTicket,
  setTicketStatus,
  TicketNotFoundError,
} from '@/lib/support/tickets';
import { MessageTooShortError, TICKET_STATUS_POLICY } from '@/lib/support/policy';

/**
 * Answering a ticket, and moving one.
 *
 * A SEPARATE FILE FROM `admin-actions.ts`, and the separation is the point.
 * Every action in that file demands a reason of at least eight characters and
 * writes an audit row, and a test asserts it of each one — because everything
 * in there moves money, roles, or somebody's ability to sign in.
 *
 * These three do none of those things, and a better record already exists for
 * them: a support reply is stored verbatim in `SupportTicketMessage` with its
 * author and its timestamp, which is strictly more than an eight-character
 * audit note would say. Demanding a reason as well would produce a column
 * containing the word "replied", eight hundred times.
 *
 * So rather than weakening that invariant with an exemption list, these live
 * here. The line to hold: the moment a support control touches a balance, a
 * role, or a phone number, it moves to `admin-actions.ts` and takes the reason
 * and the audit row with it.
 *
 * What does NOT change is authorisation. A server action is its own entry
 * point — the layout's check does not cover it, and anybody who can post to
 * the app can post to this — so every one of them calls `requireAdmin()`
 * first.
 */

const DENIED: AdminActionResult = {
  ok: false,
  message: 'That is only available to an administrator.',
};

export async function replyToTicketAsSupportAction(
  _previous: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessRequiredError) return DENIED;
    throw error;
  }

  const ticketId = String(formData.get('ticketId') ?? '').trim();
  const body = String(formData.get('body') ?? '');

  try {
    await addSupportReply({ ticketId, agentId: admin.id, body });
  } catch (error) {
    if (error instanceof MessageTooShortError || error instanceof TicketNotFoundError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  revalidatePath(`/admin/support/${ticketId}`);
  revalidatePath('/admin/support');
  revalidatePath('/admin');
  return { ok: true, message: 'Sent. The customer has been notified.' };
}

export async function setTicketStatusAction(
  _previous: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessRequiredError) return DENIED;
    throw error;
  }

  const ticketId = String(formData.get('ticketId') ?? '').trim();
  const status = String(formData.get('status') ?? '') as SupportTicketStatus;
  if (!(status in TICKET_STATUS_POLICY)) {
    return { ok: false, message: 'That is not a state a ticket can be in.' };
  }

  const priorityRaw = String(formData.get('priority') ?? '').trim();
  const priority =
    priorityRaw.length > 0 && priorityRaw in SupportTicketPriority
      ? (priorityRaw as SupportTicketPriority)
      : undefined;

  await setTicketStatus({
    ticketId,
    status,
    ...(priority === undefined ? {} : { priority }),
  });

  revalidatePath(`/admin/support/${ticketId}`);
  revalidatePath('/admin/support');
  revalidatePath('/admin');
  return {
    ok: true,
    message: `Moved to ${TICKET_STATUS_POLICY[status].queueLabel.toLowerCase()}.`,
  };
}

export async function assignTicketToMeAction(
  _previous: AdminActionResult | null,
  formData: FormData,
): Promise<AdminActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessRequiredError) return DENIED;
    throw error;
  }

  const ticketId = String(formData.get('ticketId') ?? '').trim();
  // An empty agent id hands it back to the pile, which is the other half of
  // taking one: somebody who picks up a ticket they cannot finish needs to be
  // able to put it down where another person will see it.
  const release = String(formData.get('release') ?? '') === '1';

  await assignTicket({ ticketId, agentId: release ? null : admin.id });

  revalidatePath(`/admin/support/${ticketId}`);
  revalidatePath('/admin/support');
  return {
    ok: true,
    message: release ? 'Handed back to the queue.' : 'Yours now.',
  };
}
