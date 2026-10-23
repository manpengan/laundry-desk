import { createMemoryMemberMap, type MemoryMemberMap } from "./memory-transaction-map.js";
import type { MemberCancellationInput, MemberPaymentLinkInput } from "./cancellation-types.js";
import type { MemberAccountRecord, MemberLedgerRow, MemberStore } from "./types.js";
import { cancellationInvariant } from "./cancellation-errors.js";

export function createMemoryMemberCancellation(
  input: Readonly<{
    accounts: MemoryMemberMap<string, MemberAccountRecord>;
    ledger: MemoryMemberMap<string, readonly MemberLedgerRow[]>;
    newId: () => string;
  }>,
): Pick<MemberStore, "linkPayment" | "reverseOrderPayments"> {
  const links = createMemoryMemberMap<string, MemberPaymentLinkInput>();
  return Object.freeze({
    linkPayment: async (link: MemberPaymentLinkInput): Promise<void> => {
      const source = input.ledger
        .get(link.account_id)
        ?.find((row) => row.ledger_id === link.ledger_id);
      if (
        links.has(link.payment_id) ||
        [...links.values()].some((row) => row.ledger_id === link.ledger_id) ||
        source?.kind !== "pay" ||
        source.order_id !== link.order_id ||
        source.store_id !== link.store_id ||
        -source.principal_delta_cents - source.bonus_delta_cents !== link.amount_cents
      ) {
        cancellationInvariant("member_payment_unlinked");
      }
      links.set(link.payment_id, Object.freeze({ ...link }));
    },
    reverseOrderPayments: async (cancel: MemberCancellationInput): Promise<void> => {
      const planned = cancel.reversals
        .filter((row) => row.method === "balance")
        .map((payment) => {
          const link =
            payment.ref_payment_id === null ? undefined : links.get(payment.ref_payment_id);
          const account = link === undefined ? undefined : input.accounts.get(link.account_id);
          const rows = link === undefined ? [] : (input.ledger.get(link.account_id) ?? []);
          const source = rows.find((row) => row.ledger_id === link?.ledger_id);
          if (
            link === undefined ||
            account === undefined ||
            source === undefined ||
            link.store_id !== cancel.store_id ||
            link.order_id !== cancel.order_id ||
            rows.some((row) => row.ref_ledger_id === source.ledger_id) ||
            -source.principal_delta_cents - source.bonus_delta_cents !== payment.amount_cents
          ) {
            cancellationInvariant("member_payment_unlinked");
          }
          if (account.status === "closed") cancellationInvariant("member_account_closed");
          const row: MemberLedgerRow = Object.freeze({
            ledger_id: input.newId(),
            kind: "reversal",
            ref_ledger_id: source.ledger_id,
            principal_delta_cents: -source.principal_delta_cents,
            bonus_delta_cents: -source.bonus_delta_cents,
            bonus_rule_id: null,
            order_id: cancel.order_id,
            store_id: cancel.store_id,
            tender: null,
            at: cancel.at,
            business_date: cancel.business_date,
            note: cancel.reason,
          });
          return Object.freeze({ accountId: account.account_id, row });
        });
      for (const { accountId, row } of planned) {
        input.ledger.set(accountId, [...(input.ledger.get(accountId) ?? []), row]);
      }
    },
  });
}
