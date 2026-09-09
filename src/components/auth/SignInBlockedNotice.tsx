import { describeSmsSetup } from '@/lib/auth/sms';
import type { SignInBlocker } from '@/lib/deploy/sign-in-readiness';

/**
 * Says, on the login screen, why nobody can sign in.
 *
 * **Why this is shown to whoever loads the page, rather than logged.** Every
 * other misconfiguration in this app is reported on `/admin/health`, behind a
 * session. Neither of these can be: both of them are the reason there is no
 * session. In this state the deployment has no customers — it cannot have
 * any, nobody can get in — so the only person who can be reading it is the
 * one deploying it, and that is who it is written for. The alternative,
 * measured during a deployment rehearsal, was a generic "something on our
 * side broke" page and a server log nobody thinks to open.
 *
 * It names the variable and the header for the same reason. A panel that says
 * "misconfigured" and makes somebody go looking is barely better than the 500
 * it replaced.
 */

const BLOCKER_NOTICE: Readonly<
  Record<SignInBlocker, { title: string; body: string; fix: string }>
> = {
  NO_SMS_GATEWAY: {
    title: 'This deployment cannot send login codes.',
    body:
      'No SMS gateway is configured, so asking for a code will not send one — ' +
      'to anybody, including whoever set this up. Nothing is broken and ' +
      'waiting will not change it.',
    fix: `${describeSmsSetup()} — then restart`,
  },
  INSECURE_TRANSPORT: {
    title: 'This deployment is being served over plain http.',
    body:
      'The session cookie is marked Secure in production, so a browser will ' +
      'take the code, accept the sign-in, and then discard the session — the ' +
      'next page comes back signed out, with no error anywhere. Codes will ' +
      'send fine; nobody will stay signed in.',
    fix: 'terminate TLS in front of this app and forward X-Forwarded-Proto: https',
  },
};

export function SignInBlockedNotice({ blockers }: { blockers: SignInBlocker[] }) {
  if (blockers.length === 0) return null;

  return (
    <div className="mt-6 space-y-3">
      {blockers.map((blocker) => {
        const notice = BLOCKER_NOTICE[blocker];
        return (
          <div
            key={blocker}
            className="rounded-xl bg-red-50 px-4 py-3 text-xs leading-relaxed text-red-900 ring-1 ring-red-200"
          >
            <p className="font-semibold">{notice.title}</p>
            <p className="mt-1">{notice.body}</p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-black/5 px-2.5 py-2 text-[11px]">
              {notice.fix}
            </pre>
          </div>
        );
      })}
    </div>
  );
}
