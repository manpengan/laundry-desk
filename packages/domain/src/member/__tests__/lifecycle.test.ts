import { describe, expect, it } from "vitest";

import {
  MEMBER_ACCOUNT_STATUSES,
  planMemberLifecycle,
  type MemberLifecycleAction,
} from "../lifecycle.js";

const balance = Object.freeze({ principal_cents: 1_000, bonus_cents: 200 });

describe("member account lifecycle", () => {
  it("exhaustively permits only active→frozen and frozen→active for reversible actions", () => {
    const actions = ["freeze", "unfreeze"] as const satisfies readonly MemberLifecycleAction[];
    for (const status of MEMBER_ACCOUNT_STATUSES) {
      for (const action of actions) {
        const outcome = planMemberLifecycle({ action, current_status: status, ...balance });
        const allowed =
          (status === "active" && action === "freeze") ||
          (status === "frozen" && action === "unfreeze");
        expect(outcome.ok, `${status} ${action}`).toBe(allowed);
      }
    }
  });

  it.each(["active", "frozen"] as const)(
    "closes %s by refunding all principal and forfeiting all bonus",
    (status) => {
      expect(
        planMemberLifecycle({
          action: "close",
          current_status: status,
          expected_status: status,
          expected_principal_cents: 1_000,
          expected_bonus_cents: 200,
          ...balance,
        }),
      ).toEqual({
        ok: true,
        plan: {
          previous_status: status,
          status: "closed",
          refunded_principal_cents: 1_000,
          forfeited_bonus_cents: 200,
        },
      });
    },
  );

  it("keeps zero closure movements as positive zero", () => {
    const outcome = planMemberLifecycle({
      action: "close",
      current_status: "active",
      expected_status: "active",
      principal_cents: 0,
      bonus_cents: 0,
      expected_principal_cents: 0,
      expected_bonus_cents: 0,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.is(outcome.plan.refunded_principal_cents, -0)).toBe(false);
    expect(Object.is(outcome.plan.forfeited_bonus_cents, -0)).toBe(false);
  });

  it("keeps a safe-integer bonus as one exact forfeiture", () => {
    const outcome = planMemberLifecycle({
      action: "close",
      current_status: "active",
      expected_status: "active",
      principal_cents: 0,
      bonus_cents: Number.MAX_SAFE_INTEGER,
      expected_principal_cents: 0,
      expected_bonus_cents: Number.MAX_SAFE_INTEGER,
    });
    expect(outcome).toEqual({
      ok: true,
      plan: {
        previous_status: "active",
        status: "closed",
        refunded_principal_cents: 0,
        forfeited_bonus_cents: Number.MAX_SAFE_INTEGER,
      },
    });
  });

  it("makes closed terminal", () => {
    for (const action of ["freeze", "unfreeze", "close"] as const) {
      const outcome = planMemberLifecycle({
        action,
        current_status: "closed",
        expected_status: "closed",
        expected_principal_cents: 0,
        expected_bonus_cents: 0,
        principal_cents: 0,
        bonus_cents: 0,
      });
      expect(outcome).toEqual({ ok: false, reason: "invalid_transition" });
    }
  });

  it("refuses a stale status or either stale balance component", () => {
    expect(
      planMemberLifecycle({
        action: "close",
        current_status: "frozen",
        expected_status: "active",
        expected_principal_cents: 1_000,
        expected_bonus_cents: 200,
        ...balance,
      }),
    ).toEqual({ ok: false, reason: "stale_status" });

    for (const expected of [
      { expected_principal_cents: 999, expected_bonus_cents: 200 },
      { expected_principal_cents: 1_000, expected_bonus_cents: 199 },
    ]) {
      expect(
        planMemberLifecycle({
          action: "close",
          current_status: "active",
          expected_status: "active",
          ...expected,
          ...balance,
        }),
      ).toEqual({ ok: false, reason: "stale_balance" });
    }
  });

  it.each([
    [-1, 0],
    [0, -1],
    [1.5, 0],
    [Number.MAX_SAFE_INTEGER, 1],
  ])("refuses corrupt or unsafe balance (%s, %s)", (principal, bonus) => {
    expect(
      planMemberLifecycle({
        action: "freeze",
        current_status: "active",
        principal_cents: principal,
        bonus_cents: bonus,
      }),
    ).toEqual({ ok: false, reason: "invalid_balance" });
  });
});
