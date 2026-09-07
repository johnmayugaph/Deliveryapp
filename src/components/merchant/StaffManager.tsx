'use client';

import { useActionState, useEffect, useState } from 'react';
import { StoreRole } from '@prisma/client';
import {
  changeStaffRoleAction,
  inviteStaffAction,
  removeStaffAction,
  revokeStaffInviteAction,
  type StaffActionResult,
} from '@/lib/actions/staff-actions';
import { STORE_ROLE_LABELS } from '@/lib/merchant/staff-policy';

/**
 * Who works here.
 *
 * The form asks for a phone number because a phone number is the only identity
 * this application has — there are no usernames and no passwords, and a login
 * IS a number plus a code. That also means the person being added may not have
 * an account yet, which the server handles by holding an invitation; this
 * component only has to render which of the two happened.
 *
 * Every control waits for hydration. Each action reads the session to work out
 * who is asking, and a form post made before then runs with no request scope,
 * so `cookies()` throws — the same measured limitation the login screen and
 * the support forms carry.
 */

export interface StaffRow {
  memberId: string;
  userId: string;
  name: string;
  phone: string;
  role: StoreRole;
  isYou: boolean;
  invitedBy: string | null;
  /** From the server: whether the viewer may change or remove this person. */
  canChange: boolean;
  canRemove: boolean;
}

export interface InviteRow {
  inviteId: string;
  phone: string;
  role: StoreRole;
  invitedBy: string;
  window: string;
}

function Outcome({ result }: { result: StaffActionResult | null }) {
  if (!result) return null;
  return (
    <p
      role="status"
      className={`mt-2 text-[11px] leading-relaxed ${
        result.ok ? 'text-emerald-700' : 'text-rose-700'
      }`}
    >
      {result.message}
    </p>
  );
}

const SELECT =
  'rounded-lg border border-black/10 bg-surface px-2 py-1.5 text-[12px] font-semibold';

export function StaffManager({
  storeId,
  members,
  invites,
  grantable,
  canInvite,
  canRevoke,
}: {
  storeId: string;
  members: StaffRow[];
  invites: InviteRow[];
  /** Roles this viewer is allowed to hand out. Empty for staff. */
  grantable: StoreRole[];
  canInvite: boolean;
  canRevoke: boolean;
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const [invited, invite, inviting] = useActionState(inviteStaffAction, null);
  const [changed, change, changing] = useActionState(changeStaffRoleAction, null);
  const [removed, remove, removing] = useActionState(removeStaffAction, null);
  const [revoked, revoke, revoking] = useActionState(revokeStaffInviteAction, null);

  return (
    <div className="space-y-4">
      {canInvite ? (
        <section
          aria-labelledby="add-heading"
          className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
        >
          <h2 id="add-heading" className="text-[13px] font-semibold">
            Add somebody
          </h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
            Their mobile number is all you need. If they do not have TARA yet, the
            invitation waits for them — they get access the first time they sign
            in with that number.
          </p>

          <form action={invite} className="mt-3 space-y-2">
            <input type="hidden" name="storeId" value={storeId} />
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[10rem] flex-1">
                <span className="text-[11px] font-semibold text-ink-muted">
                  Mobile number
                </span>
                <input
                  type="tel"
                  name="phone"
                  required
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="09XX XXX XXXX"
                  className="mt-1 w-full rounded-lg border border-black/10 bg-surface px-3 py-2 text-sm tabular-nums"
                />
              </label>
              <label>
                <span className="block text-[11px] font-semibold text-ink-muted">
                  Role
                </span>
                <select
                  name="role"
                  defaultValue={StoreRole.STAFF}
                  className={`mt-1 ${SELECT}`}
                >
                  {grantable.map((role) => (
                    <option key={role} value={role}>
                      {STORE_ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={inviting || !hydrated}
                className="rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-ink-faint"
              >
                {inviting ? 'Adding…' : 'Add'}
              </button>
            </div>
            <noscript>
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                Adding somebody needs JavaScript. Turn it on, or use another
                browser.
              </p>
            </noscript>
            <Outcome result={invited} />
          </form>
        </section>
      ) : null}

      <section
        aria-labelledby="people-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="people-heading" className="text-[13px] font-semibold">
          Who has access
        </h2>

        <ul className="mt-2 divide-y divide-black/5">
          {members.map((member) => (
            <li key={member.memberId} className="py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">
                    {member.name}
                    {member.isYou ? (
                      <span className="ml-1.5 text-[10px] font-semibold text-brand-700">
                        ikaw
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-[11px] tabular-nums text-ink-faint">
                    {member.phone}
                    {member.invitedBy ? ` · added by ${member.invitedBy}` : ''}
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-2">
                  {member.canChange ? (
                    <form action={change} className="flex items-center gap-1.5">
                      <input type="hidden" name="storeId" value={storeId} />
                      <input type="hidden" name="memberId" value={member.memberId} />
                      <label>
                        <span className="sr-only">Role for {member.name}</span>
                        <select name="role" defaultValue={member.role} className={SELECT}>
                          {grantable.map((role) => (
                            <option key={role} value={role}>
                              {STORE_ROLE_LABELS[role]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="submit"
                        disabled={changing || !hydrated}
                        className="text-[11px] font-semibold text-brand-700 disabled:text-ink-faint"
                      >
                        Save
                      </button>
                    </form>
                  ) : (
                    <span className="text-[11px] font-semibold text-ink-muted">
                      {STORE_ROLE_LABELS[member.role]}
                    </span>
                  )}

                  {member.canRemove ? (
                    <form action={remove}>
                      <input type="hidden" name="storeId" value={storeId} />
                      <input type="hidden" name="memberId" value={member.memberId} />
                      <button
                        type="submit"
                        disabled={removing || !hydrated}
                        className="text-[11px] font-semibold text-rose-700 disabled:text-ink-faint"
                      >
                        {member.isYou ? 'Leave' : 'Remove'}
                      </button>
                    </form>
                  ) : null}
                </span>
              </div>
            </li>
          ))}
        </ul>

        <Outcome result={changed} />
        <Outcome result={removed} />

        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
          Staff: queue lang. Manager: menu at settings din, at makakadagdag ng
          staff. May-ari: lahat, kasama ang pagpapalit ng may-ari. A store always
          keeps at least one owner.
        </p>
      </section>

      {invites.length > 0 ? (
        <section
          aria-labelledby="waiting-heading"
          className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
        >
          <h2 id="waiting-heading" className="text-[13px] font-semibold">
            Waiting to sign in
          </h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
            These numbers have no TARA account yet. They get access the first
            time they sign in — nothing was texted to them, so somebody has to
            tell them.
          </p>
          <ul className="mt-2 divide-y divide-black/5">
            {invites.map((row) => (
              <li
                key={row.inviteId}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5"
              >
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium tabular-nums">
                    {row.phone}
                  </span>
                  <span className="block text-[11px] text-ink-faint">
                    {STORE_ROLE_LABELS[row.role]} · invited by {row.invitedBy} ·{' '}
                    {row.window}
                  </span>
                </span>
                {canRevoke ? (
                  <form action={revoke}>
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="inviteId" value={row.inviteId} />
                    <button
                      type="submit"
                      disabled={revoking || !hydrated}
                      className="shrink-0 text-[11px] font-semibold text-rose-700 disabled:text-ink-faint"
                    >
                      Withdraw
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          <Outcome result={revoked} />
        </section>
      ) : null}
    </div>
  );
}
