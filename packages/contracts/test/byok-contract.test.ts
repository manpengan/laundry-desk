import { describe, expect, it } from "vitest";

import {
  AI_BYOK_OPERATION_MATRIX,
  AiCredentialIntentRequestSchema,
  AiCredentialListResponseSchema,
  AiCredentialSecretIngressRequestSchema,
  AiModelListResponseSchema,
  M2_READ_ONLY_AI_DEFINITIONS,
} from "../src/index.js";

describe("Stage 4.5 Item 12 BYOK contract freeze", () => {
  it("freezes a provider-network-free, R5 secret ingress surface", () => {
    expect(AI_BYOK_OPERATION_MATRIX).toHaveLength(5);
    expect(AI_BYOK_OPERATION_MATRIX.every((row) => row.provider_network === false)).toBe(true);
    expect(AI_BYOK_OPERATION_MATRIX.filter((row) => row.secret_ingress)).toEqual([
      expect.objectContaining({
        operation: "secret_ingress",
        method: "POST",
        risk: "R5",
        csrf: true,
      }),
    ]);
    expect(
      M2_READ_ONLY_AI_DEFINITIONS.some((definition) =>
        definition.name.startsWith("ai.provider_credential"),
      ),
    ).toBe(false);
  });

  it("accepts bounded printable secrets only at the dedicated boundary", () => {
    const valid = {
      confirm_ref: "11111111-1111-4111-8111-111111111111",
      step_up_proof_id: "22222222-2222-4222-8222-222222222222",
      api_key: "sk-safe-key",
    };
    expect(AiCredentialSecretIngressRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      AiCredentialSecretIngressRequestSchema.safeParse({ ...valid, api_key: "secret\nleak" })
        .success,
    ).toBe(false);
    expect(
      AiCredentialIntentRequestSchema.safeParse({
        operation: "replace",
        provider_code: "Vendor A",
        idempotency_key: valid.confirm_ref,
      }).success,
    ).toBe(false);
  });

  it("makes plaintext and encrypted material unrepresentable in API outputs", () => {
    const response = AiCredentialListResponseSchema.parse({
      ok: true,
      data: {
        items: [
          {
            credential_ref: "11111111-1111-4111-8111-111111111111",
            provider_code: "vendor-a",
            credential_version: 1,
            status: "pending_verification",
            last4: "-key",
            created_at: "2026-08-13T00:00:00.000Z",
            updated_at: "2026-08-13T00:00:00.000Z",
          },
        ],
      },
    });
    expect(JSON.stringify(response)).not.toMatch(/api_key|ciphertext|wrapped|kms/i);
    expect(AiModelListResponseSchema.parse({ ok: true, data: { items: [] } })).toEqual({
      ok: true,
      data: { items: [] },
    });
  });
});
