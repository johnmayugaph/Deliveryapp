import { StoreRole } from '@prisma/client';
import {
  areasAddedBy,
  roleCanHandOverTheShop,
  roleSeesTakings,
} from '@/lib/merchant/roles';
import { STORE_ROLE_LABELS } from '@/lib/merchant/staff-policy';

/**
 * What each role a person may grant actually lets somebody do.
 *
 * Both places a role is chosen were a bare dropdown reading &ldquo;May-ari /
 * Manager / Staff&rdquo;. Nothing in the app said what those meant, so the
 * decision that governs who can see a shop&rsquo;s takings was made from three
 * words &mdash; and it became more consequential twice over: the tabs are
 * hidden by role now, and the Payouts statement gained the commission on every
 * order and the reference on every payout.
 *
 * Every sentence here comes from `BACK_OFFICE_AREAS`, the same map the tab bar
 * renders from. It cannot promise access that the gate does not give, and a
 * new screen shows up here without anybody remembering to write about it.
 *
 * Framed as what a rung ADDS, because nobody needs telling that a manager can
 * accept orders.
 */
export function RoleGrantNote({ grantable }: { grantable: StoreRole[] }) {
  // Least first, so it reads as a ladder rather than a list.
  const ladder = [StoreRole.STAFF, StoreRole.MANAGER, StoreRole.OWNER].filter(
    (role) => grantable.includes(role),
  );
  if (ladder.length === 0) return null;

  return (
    <div className="rounded-xl bg-surface-sunken px-3 py-2.5 text-[11px] leading-relaxed">
      <p className="font-semibold text-ink">What each one can do</p>
      <ul className="mt-1 space-y-1.5">
        {ladder.map((role) => {
          const added = areasAddedBy(role);
          return (
            <li key={role}>
              <span className="font-semibold text-ink">
                {STORE_ROLE_LABELS[role]}
              </span>
              {added.length === 0 ? (
                <span className="text-ink-muted">
                  {' '}
                  &mdash; the same as the role below, and cannot be removed by
                  anyone but themselves.
                </span>
              ) : (
                <ul className="mt-0.5 space-y-0.5 text-ink-muted">
                  {added.map((area) => (
                    <li key={area.key} className="flex gap-1.5">
                      <span aria-hidden className="shrink-0">
                        {area.sensitive ? '₱' : '·'}
                      </span>
                      <span>
                        {area.grants}
                        {area.sensitive ? (
                          <strong className="font-semibold text-ink">
                            {' '}
                            This is the shop&rsquo;s money.
                          </strong>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {/* The half of this decision that is hard to undo. Somebody who has seen
          a month of takings has seen them; removing the role afterwards does
          not unsee it. */}
      {ladder.some((role) => roleSeesTakings(role)) ? (
        <p className="mt-1.5 text-ink-muted">
          Give somebody a role that sees the money only if you would tell them
          the takings anyway. Taking it back later does not unsee what they have
          already read.
        </p>
      ) : null}
      {/* The other irreversible one, and read off the grant ceiling rather
          than asserted: a role that can appoint an owner can appoint anybody,
          including in place of the person granting it. */}
      {ladder.some((role) => roleCanHandOverTheShop(role)) ? (
        <p className="mt-1 text-ink-muted">
          Appointing another <strong className="font-semibold text-ink">
            May-ari
          </strong>{' '}
          is how a shop changes hands. They can remove people, including you.
        </p>
      ) : null}
    </div>
  );
}
