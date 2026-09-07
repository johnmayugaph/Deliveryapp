import Link from 'next/link';
import { requireAdmin } from '@/lib/admin/access';
import { searchUsers } from '@/lib/admin/queries';
import {
  Empty,
  Panel,
  Pill,
  TableScroll,
  Td,
  Th,
  humaniseEnum,
  manilaTime,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * People, by search only.
 *
 * There is deliberately no "all accounts" list. A console that opens onto
 * everybody's records invites browsing, and browsing other people's records is
 * the behaviour an audit trail exists to discourage — it is much easier to
 * discourage it by not offering the list. Support arrives here with a phone
 * number, which is what the search takes.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireAdmin();
  const { q } = await searchParams;
  const term = q?.trim() ?? '';
  const results = term.length >= 3 ? await searchUsers(term) : [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">People</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          Search by phone, name or email. At least three characters.
        </p>
      </div>

      <form className="flex items-center gap-2">
        <input
          name="q"
          defaultValue={term}
          placeholder="0917 123 4567, or a name"
          aria-label="Search people"
          className="w-72 rounded-lg border border-black/10 bg-surface px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white"
        >
          Search
        </button>
      </form>

      {term.length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-muted">
          Nothing is listed until you search. That is on purpose — an account
          record is somebody&apos;s life, and a list of all of them is an
          invitation to read one you have no reason to.
        </p>
      ) : term.length < 3 ? (
        <p className="text-xs text-ink-muted">Three characters or more, please.</p>
      ) : (
        <Panel title={`${results.length} match${results.length === 1 ? '' : 'es'}`}>
          {results.length === 0 ? (
            <Empty>
              No account matches “{term}”. Phone matching is a substring, so
              “1234567” finds +639171234567.
            </Empty>
          ) : (
            <TableScroll>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Phone</Th>
                  <Th>Roles</Th>
                  <Th numeric>Orders</Th>
                  <Th>State</Th>
                  <Th>Joined</Th>
                </tr>
              </thead>
              <tbody>
                {results.map((user) => (
                  <tr key={user.id}>
                    <Td>
                      <Link
                        href={`/admin/users/${user.id}`}
                        className="font-semibold text-brand-700 hover:underline"
                      >
                        {user.fullName ?? user.displayName ?? '(no name yet)'}
                      </Link>
                    </Td>
                    <Td>
                      <span className="font-mono text-[11px]">{user.phone}</span>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {user.roles.map((role) => (
                          <Pill key={role}>{humaniseEnum(role)}</Pill>
                        ))}
                      </div>
                    </Td>
                    <Td numeric>{user._count.orders}</Td>
                    <Td>
                      {user.isBlocked ? (
                        <Pill tone="bad">Blocked</Pill>
                      ) : user.onboardedAt === null ? (
                        <Pill tone="warn">Not onboarded</Pill>
                      ) : (
                        <Pill tone="good">Active</Pill>
                      )}
                    </Td>
                    <Td muted>{manilaTime(user.createdAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableScroll>
          )}
        </Panel>
      )}
    </div>
  );
}
