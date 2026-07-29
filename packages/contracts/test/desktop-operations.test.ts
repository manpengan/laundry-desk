import { describe, expect, it } from "vitest";
import { z } from "zod";

import { M2_CONTRACT_COMMAND_NAMES, M2_CONTRACT_QUERY_NAMES } from "../src/commands/catalog.js";
import { createCommandError } from "../src/envelope/responses.js";
import {
  DESKTOP_MAX_JSON_BYTES,
  DESKTOP_MAX_JSON_DEPTH,
  DESKTOP_MAX_JSON_NODES,
  DESKTOP_MAX_PHOTO_BYTES,
  DESKTOP_MAX_STAFF_DIRECTORY_SIZE,
  DESKTOP_OPERATION_SCHEMAS,
  DesktopCommandExecuteInputSchema,
  DesktopCommandExecuteResultSchema,
  DesktopCommandNameSchema,
  DesktopHealthGetInputSchema,
  DesktopHealthGetResultSchema,
  DesktopLoginInputSchema,
  DesktopLoginResultSchema,
  DesktopLogoutInputSchema,
  DesktopLogoutResultSchema,
  DesktopPinChallengeInputSchema,
  DesktopPinChallengeResultSchema,
  DesktopPinVerifyInputSchema,
  DesktopPinVerifyResultSchema,
  DesktopPhotoUploadInputSchema,
  DesktopPhotoUploadResultSchema,
  DesktopQueryExecuteInputSchema,
  DesktopQueryExecuteResultSchema,
  DesktopQueryNameSchema,
  DesktopRefreshInputSchema,
  DesktopRefreshResultSchema,
  DesktopSessionViewSchema,
  DesktopStaffDirectorySchema,
} from "../src/desktop/operations.js";
import { DESKTOP_OPERATION_SCHEMAS as PUBLIC_DESKTOP_OPERATION_SCHEMAS } from "../src/index.js";

const ids = Object.freeze({
  session: "10000000-0000-4000-8000-000000000001",
  org: "10000000-0000-4000-8000-000000000002",
  store: "10000000-0000-4000-8000-000000000003",
  staff: "10000000-0000-4000-8000-000000000004",
  device: "10000000-0000-4000-8000-000000000005",
  target: "10000000-0000-4000-8000-000000000006",
  challenge: "10000000-0000-4000-8000-000000000007",
  proof: "10000000-0000-4000-8000-000000000008",
  order: "10000000-0000-4000-8000-000000000009",
  confirm: "10000000-0000-4000-8000-000000000010",
});

const sessionView = Object.freeze({
  session: Object.freeze({
    session_id: ids.session,
    session_version: 1,
    org_id: ids.org,
    store_id: ids.store,
    staff_id: ids.staff,
    device_id: ids.device,
    permission_version: 1,
  }),
  role: "admin" as const,
  features: Object.freeze({ member_enabled: false }),
  display: Object.freeze({
    store_name: "本地门店",
    staff_name: "本地管理员",
    org_code: "local",
    store_code: "main",
  }),
});

const staffDirectory = Object.freeze([
  Object.freeze({
    staff_id: ids.staff,
    display_name: "本地管理员",
    role: "admin" as const,
  }),
  Object.freeze({
    staff_id: ids.target,
    display_name: "店员甲",
    role: "staff" as const,
  }),
]);

const loginInput = Object.freeze({
  org_code: "local",
  store_code: "main",
  username: "admin",
  password: "secret",
});

const pinChallengeInput = Object.freeze({
  purpose: "quick_switch" as const,
  target_staff_id: ids.target,
});

const pinVerifyInput = Object.freeze({
  challenge_id: ids.challenge,
  pin: "1234",
});

const paymentInput = Object.freeze({
  name: "payment.collect" as const,
  body: Object.freeze({
    order_id: ids.order,
    amount_cents: 1_500,
    method: "cash" as const,
  }),
});

const queryInput = Object.freeze({
  name: "order.list" as const,
  body: Object.freeze({ limit: 20 }),
});

const actionableFailure = Object.freeze({
  ok: false as const,
  error: createCommandError("RESOURCE_UNAVAILABLE", {
    kind: "reason",
    reason: "retry_later",
  }),
});

describe("desktop operation registry", () => {
  it("exposes only the named renderer capability namespaces", () => {
    expect(Object.keys(DESKTOP_OPERATION_SCHEMAS)).toEqual([
      "auth",
      "command",
      "query",
      "photo",
      "health",
    ]);
    expect(Object.keys(DESKTOP_OPERATION_SCHEMAS.auth)).toEqual([
      "login",
      "refresh",
      "pinChallenge",
      "pinVerify",
      "logout",
    ]);
    expect(Object.keys(DESKTOP_OPERATION_SCHEMAS.command)).toEqual(["execute"]);
    expect(Object.keys(DESKTOP_OPERATION_SCHEMAS.query)).toEqual(["execute"]);
    expect(Object.keys(DESKTOP_OPERATION_SCHEMAS.photo)).toEqual(["upload"]);
    expect(Object.keys(DESKTOP_OPERATION_SCHEMAS.health)).toEqual(["get"]);
    expect(PUBLIC_DESKTOP_OPERATION_SCHEMAS).toBe(DESKTOP_OPERATION_SCHEMAS);

    Object.values(DESKTOP_OPERATION_SCHEMAS).forEach((namespace) => {
      Object.values(namespace).forEach((operation) => {
        expect(operation.input).toBeInstanceOf(z.ZodType);
        expect(operation.result).toBeInstanceOf(z.ZodType);
        expect(Object.keys(operation)).toEqual(["input", "result"]);
      });
    });
  });

  it("is deeply frozen so renderer capability metadata cannot drift", () => {
    expect(Object.isFrozen(DESKTOP_OPERATION_SCHEMAS)).toBe(true);
    Object.values(DESKTOP_OPERATION_SCHEMAS).forEach((namespace) => {
      expect(Object.isFrozen(namespace)).toBe(true);
      Object.values(namespace).forEach((operation) =>
        expect(Object.isFrozen(operation)).toBe(true),
      );
    });
  });
});

describe("desktop auth and health schemas", () => {
  it("reuses the strict auth inputs while keeping device identity main-owned", () => {
    expect(DesktopLoginInputSchema.parse(loginInput)).toEqual(loginInput);
    expect(DesktopRefreshInputSchema.parse({})).toEqual({});
    expect(DesktopPinChallengeInputSchema.parse(pinChallengeInput)).toEqual(pinChallengeInput);
    expect(DesktopPinVerifyInputSchema.parse(pinVerifyInput)).toEqual(pinVerifyInput);
    expect(DesktopLogoutInputSchema.parse({})).toEqual({});
    expect(DesktopHealthGetInputSchema.parse({})).toEqual({});

    expect(
      DesktopLoginInputSchema.safeParse({ ...loginInput, device_id: ids.device }).success,
    ).toBe(false);
  });

  it.each(["url", "method", "headers", "origin", "cookies", "token"] as const)(
    "rejects renderer-controlled transport key %s from every auth/health argument",
    (key) => {
      expect(DesktopLoginInputSchema.safeParse({ ...loginInput, [key]: "forbidden" }).success).toBe(
        false,
      );
      expect(DesktopRefreshInputSchema.safeParse({ [key]: "forbidden" }).success).toBe(false);
      expect(
        DesktopPinChallengeInputSchema.safeParse({
          ...pinChallengeInput,
          [key]: "forbidden",
        }).success,
      ).toBe(false);
      expect(
        DesktopPinVerifyInputSchema.safeParse({ ...pinVerifyInput, [key]: "forbidden" }).success,
      ).toBe(false);
      expect(DesktopLogoutInputSchema.safeParse({ [key]: "forbidden" }).success).toBe(false);
      expect(DesktopHealthGetInputSchema.safeParse({ [key]: "forbidden" }).success).toBe(false);
    },
  );

  it("projects a strict token-free SessionView and renderer-safe staff directory", () => {
    expect(DesktopSessionViewSchema.parse(sessionView)).toEqual(sessionView);
    expect(DesktopStaffDirectorySchema.parse(staffDirectory)).toEqual(staffDirectory);

    [
      { ...sessionView, access_token: "secret" },
      { ...sessionView, token: "secret" },
      { ...sessionView, headers: { authorization: "Bearer secret" } },
    ].forEach((candidate) =>
      expect(DesktopSessionViewSchema.safeParse(candidate).success).toBe(false),
    );
    expect(
      DesktopStaffDirectorySchema.safeParse([{ ...staffDirectory[0], username: "admin" }]).success,
    ).toBe(false);
  });

  it("uses strict success data and the same actionable failure envelope for all operations", () => {
    const successes = [
      [
        DesktopLoginResultSchema,
        {
          ok: true,
          data: { session_view: sessionView, staff_directory: staffDirectory },
        },
      ],
      [DesktopRefreshResultSchema, { ok: true, data: sessionView }],
      [
        DesktopPinChallengeResultSchema,
        {
          ok: true,
          data: {
            challenge_id: ids.challenge,
            purpose: "quick_switch",
            expires_at: 2_000,
            max_attempts: 5,
          },
        },
      ],
      [DesktopPinVerifyResultSchema, { ok: true, data: sessionView }],
      [
        DesktopPinVerifyResultSchema,
        {
          ok: true,
          data: { step_up_proof_id: ids.proof, expires_at: 2_000 },
        },
      ],
      [DesktopLogoutResultSchema, { ok: true, data: { logged_out: true } }],
      [DesktopHealthGetResultSchema, { ok: true, data: { status: "ready" } }],
      [
        DesktopPhotoUploadResultSchema,
        {
          ok: true,
          data: {
            execution: "executed",
            result: {
              photo_id: ids.confirm,
              garment_id: ids.target,
              order_id: ids.order,
              kind: "receive",
              content_type: "image/jpeg",
              byte_size: 3,
              taken_at: 1_721_606_400,
              created_by_staff_id: ids.staff,
            },
          },
        },
      ],
    ] as const;

    successes.forEach(([schema, value]) => expect(schema.safeParse(value).success).toBe(true));
    [
      DesktopLoginResultSchema,
      DesktopRefreshResultSchema,
      DesktopPinChallengeResultSchema,
      DesktopPinVerifyResultSchema,
      DesktopLogoutResultSchema,
      DesktopCommandExecuteResultSchema,
      DesktopQueryExecuteResultSchema,
      DesktopPhotoUploadResultSchema,
      DesktopHealthGetResultSchema,
    ].forEach((schema) => expect(schema.parse(actionableFailure)).toEqual(actionableFailure));

    expect(
      DesktopHealthGetResultSchema.safeParse({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "custom details" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown response keys and any token-bearing auth projection", () => {
    expect(
      DesktopLoginResultSchema.safeParse({
        ok: true,
        data: {
          session_view: { ...sessionView, access_token: "secret" },
          staff_directory: staffDirectory,
        },
      }).success,
    ).toBe(false);
    expect(
      DesktopRefreshResultSchema.safeParse({
        ok: true,
        data: sessionView,
        access_token: "secret",
      }).success,
    ).toBe(false);
    expect(
      DesktopLogoutResultSchema.safeParse({
        ok: true,
        data: { logged_out: true, cookie: "secret" },
      }).success,
    ).toBe(false);
    expect(
      JSON.stringify(
        DesktopLoginResultSchema.parse({
          ok: true,
          data: { session_view: sessionView, staff_directory: staffDirectory },
        }),
      ),
    ).not.toMatch(/access_token|refresh_token|authorization|cookie|headers?/iu);
    const photoResult = {
      photo_id: ids.confirm,
      garment_id: ids.target,
      order_id: ids.order,
      kind: "receive",
      content_type: "image/jpeg",
      byte_size: 3,
      taken_at: 1_721_606_400,
      created_by_staff_id: ids.staff,
    };
    expect(
      DesktopPhotoUploadResultSchema.safeParse({
        ok: true,
        data: {
          execution: "executed",
          result: { ...photoResult, storage_key: "private.jpg" },
        },
      }).success,
    ).toBe(false);
    expect(
      DesktopPhotoUploadResultSchema.safeParse({
        ok: true,
        data: {
          execution: "executed",
          result: { ...photoResult, photo_id: "not-a-uuid" },
        },
      }).success,
    ).toBe(false);
  });

  it("bounds the staff directory before it crosses into the renderer", () => {
    const oversized = Array.from({ length: DESKTOP_MAX_STAFF_DIRECTORY_SIZE + 1 }, (_, index) => ({
      staff_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      display_name: `staff-${index}`,
      role: "staff",
    }));

    expect(DesktopStaffDirectorySchema.safeParse(oversized).success).toBe(false);
  });
});

describe("desktop command/query schemas", () => {
  it("derives command and query names from the real M2 registries", async () => {
    expect(
      M2_CONTRACT_COMMAND_NAMES.filter((name) => name !== "photo.register").every(
        (name) => DesktopCommandNameSchema.safeParse(name).success,
      ),
    ).toBe(true);
    expect(DesktopCommandNameSchema.safeParse("photo.register").success).toBe(false);
    expect(
      M2_CONTRACT_QUERY_NAMES.every((name) => DesktopQueryNameSchema.safeParse(name).success),
    ).toBe(true);

    for (const name of [
      "identity.login",
      "identity.refresh",
      "identity.pin_challenge",
      "identity.pin_verify",
      "identity.logout",
    ]) {
      expect(DesktopCommandNameSchema.safeParse(name).success).toBe(false);
      expect(DesktopQueryNameSchema.safeParse(name).success).toBe(false);
      expect(
        (await DesktopCommandExecuteInputSchema.safeParseAsync({ name, body: {} })).success,
      ).toBe(false);
      expect(
        (await DesktopQueryExecuteInputSchema.safeParseAsync({ name, body: {} })).success,
      ).toBe(false);
    }
  });

  it("validates bounded photo bytes without accepting transport controls", () => {
    const input = {
      order_id: ids.order,
      garment_id: ids.target,
      kind: "receive",
      content_type: "image/jpeg",
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    };
    expect(DesktopPhotoUploadInputSchema.parse(input)).toEqual(input);
    expect(
      DesktopPhotoUploadInputSchema.safeParse({
        ...input,
        bytes: new Uint8Array(DESKTOP_MAX_PHOTO_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      DesktopPhotoUploadInputSchema.safeParse({
        ...input,
        url: "https://attacker.invalid",
      }).success,
    ).toBe(false);
    expect(
      DesktopPhotoUploadInputSchema.safeParse({
        ...input,
        bytes: [0xff, 0xd8, 0xff],
      }).success,
    ).toBe(false);
  });

  it("validates business bodies with the selected registry definition", async () => {
    await expect(DesktopCommandExecuteInputSchema.parseAsync(paymentInput)).resolves.toEqual(
      paymentInput,
    );
    await expect(DesktopQueryExecuteInputSchema.parseAsync(queryInput)).resolves.toEqual(
      queryInput,
    );

    expect(
      (
        await DesktopCommandExecuteInputSchema.safeParseAsync({
          ...paymentInput,
          body: { ...paymentInput.body, amount_cents: -1 },
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await DesktopCommandExecuteInputSchema.safeParseAsync({
          ...paymentInput,
          body: { ...paymentInput.body, token: "secret" },
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await DesktopQueryExecuteInputSchema.safeParseAsync({
          ...queryInput,
          body: { ...queryInput.body, arbitrary: true },
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await DesktopCommandExecuteInputSchema.safeParseAsync({
          name: "order.list",
          body: queryInput.body,
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await DesktopQueryExecuteInputSchema.safeParseAsync({
          name: "payment.collect",
          body: paymentInput.body,
        })
      ).success,
    ).toBe(false);
  });

  it("forbids transport controls at the bridge while preserving legitimate business method", async () => {
    expect((await DesktopCommandExecuteInputSchema.safeParseAsync(paymentInput)).success).toBe(
      true,
    );

    for (const key of ["url", "method", "headers", "origin", "cookies", "token"] as const) {
      expect(
        (
          await DesktopCommandExecuteInputSchema.safeParseAsync({
            ...paymentInput,
            [key]: "forbidden",
          })
        ).success,
      ).toBe(false);
      expect(
        (
          await DesktopQueryExecuteInputSchema.safeParseAsync({
            ...queryInput,
            [key]: "forbidden",
          })
        ).success,
      ).toBe(false);
    }
  });

  it("allows only an opaque confirmation reference on the confirm path", async () => {
    const confirmation = {
      name: "payment.refund",
      confirm_ref: ids.confirm,
    };
    await expect(DesktopCommandExecuteInputSchema.parseAsync(confirmation)).resolves.toEqual(
      confirmation,
    );
    expect(
      (
        await DesktopCommandExecuteInputSchema.safeParseAsync({
          ...confirmation,
          body: paymentInput.body,
        })
      ).success,
    ).toBe(false);
  });

  it("reuses the common command response envelope for command and query results", () => {
    const response = {
      ok: true as const,
      data: {
        execution: "executed" as const,
        result: { order_id: ids.order },
      },
    };
    expect(DesktopCommandExecuteResultSchema.parse(response)).toEqual(response);
    expect(DesktopQueryExecuteResultSchema.parse(response)).toEqual(response);
    expect(
      DesktopCommandExecuteResultSchema.safeParse({
        ...response,
        data: { ...response.data, url: "http://127.0.0.1:8787" },
      }).success,
    ).toBe(false);
  });

  it("enforces byte, node and depth bounds on arbitrary JSON results", () => {
    const oversizedBytes = {
      ok: true,
      data: {
        execution: "executed",
        result: "x".repeat(DESKTOP_MAX_JSON_BYTES + 1),
      },
    };
    const oversizedNodes = {
      ok: true,
      data: {
        execution: "executed",
        result: Array.from({ length: DESKTOP_MAX_JSON_NODES }, () => null),
      },
    };
    let nested: unknown = null;
    for (let depth = 0; depth <= DESKTOP_MAX_JSON_DEPTH; depth += 1) nested = [nested];
    const oversizedDepth = {
      ok: true,
      data: { execution: "executed", result: nested },
    };

    [oversizedBytes, oversizedNodes, oversizedDepth].forEach((value) => {
      expect(DesktopCommandExecuteResultSchema.safeParse(value).success).toBe(false);
      expect(DesktopQueryExecuteResultSchema.safeParse(value).success).toBe(false);
    });
  });

  it("rejects pathological JSON depth before z.json can overflow the stack", () => {
    let nested: unknown = null;
    for (let depth = 0; depth < 20_000; depth += 1) nested = [nested];
    const response = {
      ok: true,
      data: { execution: "executed", result: nested },
    };

    expect(() => DesktopCommandExecuteResultSchema.safeParse(response)).not.toThrow();
    expect(DesktopCommandExecuteResultSchema.safeParse(response).success).toBe(false);
    expect(() => DesktopQueryExecuteResultSchema.safeParse(response)).not.toThrow();
    expect(DesktopQueryExecuteResultSchema.safeParse(response).success).toBe(false);
  });
});
