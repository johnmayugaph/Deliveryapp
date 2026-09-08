import { requireAdmin } from '@/lib/admin/access';
import { giftCardOverview, type GiftCardRow } from '@/lib/admin/gift-cards';
import { formatCentavos } from '@/lib/money';
import { MAX_GIFT_CARD_CENTAVOS } from '@/lib/gift-cards/policy';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  issueGiftCardAction,
  voidGiftCardAction,
} from '@/lib/actions/admin-actions';
import {
  Empty,
  Panel,
  Pill,
  Stat,
  TableScroll,
  Td,
  Th,
  manilaTime,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * Gift cards.
 *
 * One number carries this screen: **what is still outstanding.** Every other
 * way this app gives credits away needs the recipient to do something first —
 * a promo code needs an order at checkout, a referral needs a signup and a
 * delivery, an adjustment needs an account to name. A gift card needs nothing
 * but the string, so its face value is money sitting on paper we no longer
 * control, and the total of that is the figure an operator should not have to
 * add up themselves.
 *
 * The second thing this screen has to do is tell the truth about the code: it
 * is shown once, at issue, and cannot be recovered. That is not a limitation
 * to apologise for — it is why a leaked backup is not a pile of cash — but
 * somebody who closes the tab has genuinely lost the card, and the screen says
 * so before they click rather than after.
 */
export default async function AdminGiftCardsPage() {
  await requireAdmin();
  const overview = await giftCardOverview();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Gift cards</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
          A card you issue becomes credits for whoever types the code — no
          account needed until they redeem it, which is what makes it useful
          for goodwill and for anything printed. Credits still cannot be topped
          up, sent to anybody or cashed out, so the worst case is discounted
          food rather than lost money.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="Outstanding"
          value={formatCentavos(overview.outstandingCentavos)}
          note={`${overview.outstandingCount} card${overview.outstandingCount === 1 ? '' : 's'} still redeemable`}
        />
        <Stat
          label="Redeemed"
          value={formatCentavos(overview.redeemedCentavos)}
          note={`${overview.redeemedCount} card${overview.redeemedCount === 1 ? '' : 's'}, all time`}
        />
        <Stat
          label="Issued this month"
          value={formatCentavos(overview.issuedThisMonthCentavos)}
          note="Face value, whether redeemed or not"
        />
        <Stat
          label="Lapsed unredeemed"
          value={formatCentavos(overview.expiredCentavos)}
          note={
            overview.expiredCount === 0
              ? 'Nothing has expired'
              : `${overview.expiredCount} card${overview.expiredCount === 1 ? '' : 's'} nobody claimed`
          }
        />
      </div>

      {overview.outstandingCentavos > 0 ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
          <span className="font-semibold">
            {formatCentavos(overview.outstandingCentavos)} is on paper you no
            longer control.
          </span>{' '}
          Every one of those {overview.outstandingCount} cards becomes credits
          the moment somebody types it, whether that is tomorrow or next year.
          Unlike a promo campaign there is no aggregate switch: a card is
          cancelled one at a time, and only while it is unredeemed. Set an
          expiry when you issue one if you want that number to come down on its
          own — but read the note on the form first.
        </p>
      ) : null}

      <Panel
        title="Cards"
        description="Newest first, by reference. The code is not here and cannot be — only its hash was kept."
      >
        {overview.cards.length === 0 ? (
          <Empty>No gift cards issued yet.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Reference</Th>
                <Th numeric>Value</Th>
                <Th>State</Th>
                <Th>Why, and who</Th>
                <Th>What happened</Th>
                <Th>Cancel</Th>
              </tr>
            </thead>
            <tbody>
              {overview.cards.map((card) => (
                <tr key={card.id}>
                  <Td>
                    <span className="font-semibold tracking-wide">{card.reference}</span>
                    <span className="mt-0.5 block text-[11px] text-ink-faint">
                      {manilaTime(card.createdAt)}
                    </span>
                  </Td>

                  <Td numeric>{formatCentavos(card.amountCentavos)}</Td>

                  <Td>
                    <StatePill status={card.status} />
                    {card.expiresAt ? (
                      <span className="mt-1 block text-[11px] text-ink-faint">
                        {card.status === 'EXPIRED' ? 'expired' : 'expires'}{' '}
                        {manilaTime(card.expiresAt)}
                      </span>
                    ) : (
                      <span className="mt-1 block text-[11px] text-ink-faint">
                        never expires
                      </span>
                    )}
                  </Td>

                  <Td muted>
                    <span className="text-[11px]">{card.issuedReason}</span>
                    {card.note ? (
                      <span className="mt-0.5 block text-[11px] text-ink-faint">
                        {card.note}
                      </span>
                    ) : null}
                    {card.issuedByName ? (
                      <span className="mt-0.5 block text-[11px] text-ink-faint">
                        by {card.issuedByName}
                      </span>
                    ) : null}
                  </Td>

                  <Td muted>
                    {card.status === 'REDEEMED' ? (
                      <>
                        <span className="text-[11px]">
                          {card.redeemedByName ?? 'an account since removed'}
                        </span>
                        {card.redeemedByPhone ? (
                          <span className="mt-0.5 block text-[11px] tabular-nums">
                            {formatPhilippineMobile(card.redeemedByPhone)}
                          </span>
                        ) : null}
                        <span className="mt-0.5 block text-[11px] text-ink-faint">
                          {card.redeemedAt ? manilaTime(card.redeemedAt) : ''}
                        </span>
                      </>
                    ) : card.status === 'VOID' ? (
                      <>
                        <span className="text-[11px]">{card.voidReason}</span>
                        <span className="mt-0.5 block text-[11px] text-ink-faint">
                          {card.voidedByName ? `by ${card.voidedByName}, ` : ''}
                          {card.voidedAt ? manilaTime(card.voidedAt) : ''}
                        </span>
                      </>
                    ) : (
                      <span className="text-[11px] text-ink-faint">
                        waiting to be redeemed
                      </span>
                    )}
                  </Td>

                  <Td>
                    {card.status === 'ISSUED' || card.status === 'EXPIRED' ? (
                      <ReasonForm
                        action={voidGiftCardAction}
                        hidden={{ cardId: card.id }}
                        submitLabel="Cancel"
                        tone="danger"
                        placeholder="Lost, printed wrong, issued in error"
                      />
                    ) : (
                      <span className="text-[11px] text-ink-faint">
                        {card.status === 'REDEEMED'
                          ? 'redeemed — correct the balance with an adjustment instead'
                          : 'already cancelled'}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Issue a card"
        description={`The code appears once, in the confirmation, and cannot be recovered afterwards. At most ${formatCentavos(MAX_GIFT_CARD_CENTAVOS)} per card.`}
      >
        <div className="px-4 py-3">
          <ReasonForm
            action={issueGiftCardAction}
            hidden={{}}
            submitLabel="Issue the card"
            placeholder="Which ticket, event or partner this is for"
            extraFields={
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="block">
                    <span className="text-[11px] font-semibold text-ink-muted">
                      Value, pesos
                    </span>
                    <input
                      name="amountPesos"
                      required
                      inputMode="decimal"
                      placeholder="250"
                      className={INPUT}
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-semibold text-ink-muted">
                      Note (optional)
                    </span>
                    <input
                      name="note"
                      maxLength={200}
                      placeholder="Launch event, table 4"
                      className={INPUT}
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-semibold text-ink-muted">
                      Expires (optional)
                    </span>
                    <input name="expiresAt" type="datetime-local" className={INPUT} />
                    <span className="mt-0.5 block text-[10px] text-ink-faint">
                      Blank means never, which is the default.
                    </span>
                  </label>
                </div>

                <p className="rounded-lg bg-brand-50 px-3 py-2 text-[11px] leading-relaxed text-brand-900">
                  <strong>Before you set an expiry:</strong> RA 10962, the Gift
                  Check Act, says gift checks sold in the Philippines may not
                  expire. A card you give away for nothing is arguably not a
                  gift check that was sold — but that is a question for your
                  lawyer and not for this form, which is why the default is
                  never. An expiry you should not have enforced is a
                  consumer-protection problem; no expiry is a number on the
                  screen above.
                </p>

                <p className="rounded-lg bg-surface-sunken px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
                  <strong>The code shows once.</strong> It is stored only as a
                  hash, so nothing — not this screen, not the database, not a
                  backup — can produce it again. Copy it out of the
                  confirmation before you navigate away. If you lose it, cancel
                  the card and issue another; nothing is spent until somebody
                  redeems one.
                </p>
              </div>
            }
          />
        </div>
      </Panel>
    </div>
  );
}

const INPUT =
  'mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500';

/**
 * Four states, and the two that look alike are the point.
 *
 * ISSUED and EXPIRED are both "nobody redeemed this", and only one of them is
 * still a liability. Showing them with the same pill would make the
 * outstanding total look wrong to anybody checking it against the list.
 */
function StatePill({ status }: { status: GiftCardRow['status'] }) {
  switch (status) {
    case 'ISSUED':
      return <Pill tone="good">Live</Pill>;
    case 'REDEEMED':
      return <Pill>Redeemed</Pill>;
    case 'VOID':
      return <Pill tone="bad">Cancelled</Pill>;
    case 'EXPIRED':
      return <Pill tone="warn">Expired</Pill>;
  }
}
