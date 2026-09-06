import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WalletTransactionType } from '@prisma/client';
import {
  CREDIT_TYPES,
  DEBIT_TYPES,
  InvalidLedgerEntryError,
  ORDER_LINKED_TYPES,
  replayLedger,
  signedAmountFor,
} from '@/lib/wallet/rules';
import * as ledger from '@/lib/wallet/ledger';

const LEDGER_SOURCE = readFileSync(
  path.resolve(__dirname, '../lib/wallet/ledger.ts'),
  'utf8',
);
const GUARD_SQL = readFileSync(
  path.resolve(__dirname, '../../prisma/sql/wallet_append_only.sql'),
  'utf8',
);

describe('the four hard constraints', () => {
  it('exposes no top-up, transfer, or cash-out API', () => {
    // The constraints are enforced by there being no code path at all. This
    // test makes adding one a failing build rather than a quiet regression.
    const forbidden = [
      'topUp',
      'topup',
      'addFunds',
      'cashIn',
      'transfer',
      'sendCredits',
      'withdraw',
      'cashOut',
      'payout',
      'setBalance',
    ];

    const exported = Object.keys(ledger);
    for (const name of forbidden) {
      const match = exported.find((key) => key.toLowerCase().includes(name.toLowerCase()));
      expect(match, `ledger exports "${match}", which breaks a hard constraint`).toBeUndefined();
    }
  });

  it('has no transaction type that could represent a top-up or a transfer', () => {
    const types = Object.values(WalletTransactionType) as string[];
    for (const forbidden of ['TOP_UP', 'TOPUP', 'TRANSFER_IN', 'TRANSFER_OUT', 'WITHDRAWAL', 'CASH_OUT']) {
      expect(types, `${forbidden} must not exist`).not.toContain(forbidden);
    }
    expect(types.sort()).toEqual(
      ['ADJUSTMENT', 'ORDER_PAYMENT', 'PROMO_CREDIT', 'REFERRAL_BONUS', 'REFUND'].sort(),
    );
  });

  it('declares the constraints so callers and docs cannot drift from the code', () => {
    expect(ledger.WALLET_CONSTRAINTS).toEqual({
      topUpAllowed: false,
      transfersAllowed: false,
      withdrawalAllowed: false,
      spendableOnlyOnOrders: true,
      uiLabel: 'Credits',
    });
  });

  it('requires an order id for every type that moves money in or out of an order', () => {
    expect(ORDER_LINKED_TYPES).toContain(WalletTransactionType.ORDER_PAYMENT);
    expect(ORDER_LINKED_TYPES).toContain(WalletTransactionType.REFUND);
  });

  it('has no function that could name a source and a destination', () => {
    // A transfer needs two parties. No function here accepts a second wallet or
    // user identifier, which is constraint 2 expressed structurally rather than
    // by policy. (Counting `wallet.update` calls would not show this:
    // `reconcileWalletBalance` legitimately writes one wallet as well.)
    const twoPartyIdentifiers = [
      'fromUserId',
      'toUserId',
      'fromWalletId',
      'toWalletId',
      'sourceWalletId',
      'destinationWalletId',
      'recipientUserId',
      'senderUserId',
      'counterpartyId',
    ];
    for (const identifier of twoPartyIdentifiers) {
      expect(LEDGER_SOURCE, `ledger names "${identifier}"`).not.toContain(identifier);
    }
  });
});

describe('signs are forced by transaction type', () => {
  it('makes every credit type positive', () => {
    for (const type of CREDIT_TYPES) {
      expect(signedAmountFor(type, 5_000)).toBe(5_000);
    }
  });

  it('makes every debit type negative', () => {
    for (const type of DEBIT_TYPES) {
      expect(signedAmountFor(type, 5_000)).toBe(-5_000);
    }
  });

  it('rejects a caller trying to supply its own sign', () => {
    expect(() => signedAmountFor(WalletTransactionType.PROMO_CREDIT, -5_000)).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => signedAmountFor(WalletTransactionType.ORDER_PAYMENT, -5_000)).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('allows an ADJUSTMENT in either direction', () => {
    expect(signedAmountFor(WalletTransactionType.ADJUSTMENT, 250)).toBe(250);
    expect(signedAmountFor(WalletTransactionType.ADJUSTMENT, -250)).toBe(-250);
  });

  it('rejects zero and fractional centavos', () => {
    expect(() => signedAmountFor(WalletTransactionType.PROMO_CREDIT, 0)).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => signedAmountFor(WalletTransactionType.PROMO_CREDIT, 10.5)).toThrow(
      InvalidLedgerEntryError,
    );
  });
});

describe('the balance is derived from the ledger', () => {
  it('replays a ledger to the same balance the rows recorded', () => {
    const entries = [
      { type: WalletTransactionType.PROMO_CREDIT, magnitude: 10_000 },
      { type: WalletTransactionType.REFERRAL_BONUS, magnitude: 5_000 },
      { type: WalletTransactionType.ORDER_PAYMENT, magnitude: 12_500 },
      { type: WalletTransactionType.REFUND, magnitude: 2_500 },
    ];

    const signed = entries.map((entry) => ({
      amountCentavos: signedAmountFor(entry.type, entry.magnitude),
    }));

    // 100 + 50 - 125 + 25 = ₱50.00
    expect(replayLedger(signed)).toBe(5_000);

    // And a running replay reproduces every balanceAfter value, which is the
    // property that lets us detect drift in the cached column.
    let running = 0;
    const balancesAfter = signed.map((entry) => (running += entry.amountCentavos));
    expect(balancesAfter).toEqual([10_000, 15_000, 2_500, 5_000]);
  });

  it('writes the derived balance from the ledger sum, not from an increment', () => {
    // An `increment` here would make the column the truth rather than a cache.
    expect(LEDGER_SOURCE).toContain('data: { balanceCentavos: nextBalance }');
    expect(LEDGER_SOURCE).not.toMatch(/balanceCentavos:\s*\{\s*increment/);
  });

  it('reads the prior balance from the ledger rather than the cached column', () => {
    expect(LEDGER_SOURCE).toContain('const priorBalance = await sumLedger(tx, wallet.id)');
  });
});

describe('the SQL guards agree with the application rules', () => {
  it('makes the ledger append-only in the database too', () => {
    expect(GUARD_SQL).toMatch(/BEFORE UPDATE ON "WalletTransaction"/);
    expect(GUARD_SQL).toMatch(/BEFORE DELETE ON "WalletTransaction"/);
  });

  it('enforces the same sign rules as signedAmountFor', () => {
    for (const type of CREDIT_TYPES) {
      expect(GUARD_SQL).toContain(type);
    }
    expect(GUARD_SQL).toMatch(/'ORDER_PAYMENT' AND "amountCentavos" < 0/);
  });

  it('forbids a negative balance', () => {
    expect(GUARD_SQL).toMatch(/"balanceCentavos" >= 0/);
  });
});
