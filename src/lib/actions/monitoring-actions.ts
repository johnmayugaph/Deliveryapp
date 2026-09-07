'use server';

import { ErrorSource } from '@prisma/client';
import { reportError } from '@/lib/monitoring/report';
import { getCurrentUser } from '@/lib/auth/session';

/**
 * The one way a browser can report an error.
 *
 * Narrow on purpose. This endpoint is reachable by anybody who can post to the
 * app, which makes it a way to write rows into our database — so it takes a
 * message and a digest and nothing else, it never trusts a stack from the
 * client, and everything it does record goes through the same redaction and
 * the same grouping as a server error. A flood of junk becomes ONE row with a
 * high count, which is the same protection the table's shape gives everything
 * else.
 *
 * The alternative — no client reporting at all — loses the entire class of
 * error the customer actually sees: a component that throws while rendering
 * on their phone and nowhere else.
 */
export async function reportClientErrorAction(input: {
  message: string;
  digest?: string | undefined;
  route?: string | undefined;
}): Promise<void> {
  const user = await getCurrentUser();

  // Rebuilt as an Error here so the reporter's own kind/message handling is
  // the only code that interprets it. The `stack` is left off deliberately:
  // a client-supplied stack is unverifiable text, and the digest is what
  // actually ties this to the server-side row.
  const error = new Error(String(input.message ?? '').slice(0, 2_000));
  error.name = 'ClientError';

  await reportError(error, {
    source: ErrorSource.CLIENT,
    route: input.route ?? null,
    digest: input.digest ?? null,
    userId: user?.id ?? null,
  });
}
