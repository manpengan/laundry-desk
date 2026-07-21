import { describe, expect, it } from "vitest";

import {
  IDENTITY_COMMAND_NAMES,
  M1_FIRST_WAVE_COMMAND_NAMES,
  M1_FIRST_WAVE_DEFINITIONS,
  M1_FIRST_WAVE_QUERY_NAMES,
  identityLoginCommand,
  identityPinVerifyCommand,
  isAiProjectableDefinition,
  isContractDefinition,
  parseContractInput,
  platformSettingsSetCommand,
  platformStoreFeaturesGetQuery,
} from "../src/index.js";

describe("A6 first-wave command catalog", () => {
  it("registers every definition through A1 factories", () => {
    for (const definition of M1_FIRST_WAVE_DEFINITIONS) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.description_llm.length).toBeGreaterThan(0);
    }
  });

  it("lists stable identity and platform names", () => {
    expect([...IDENTITY_COMMAND_NAMES]).toEqual([
      "identity.login",
      "identity.refresh",
      "identity.logout",
      "identity.pin_challenge",
      "identity.pin_verify",
    ]);
    expect([...M1_FIRST_WAVE_COMMAND_NAMES]).toContain("platform.settings.set");
    expect([...M1_FIRST_WAVE_QUERY_NAMES]).toEqual([
      "platform.settings.get",
      "platform.store_features.get",
      "platform.audit.list",
    ]);
  });

  it("keeps secret credential commands offline-denied and non-projectable", () => {
    expect(identityLoginCommand.data_classification).toBe("secret");
    expect(identityLoginCommand.risk).toBe("R1");
    expect(identityLoginCommand.offline_mode).toBe("denied");
    expect(identityLoginCommand.input_redaction).toEqual([
      { path: "/password", strategy: "remove" },
    ]);
    expect(isAiProjectableDefinition(identityLoginCommand)).toBe(false);

    expect(identityPinVerifyCommand.data_classification).toBe("secret");
    expect(identityPinVerifyCommand.risk).not.toBe("R5");
    expect(isAiProjectableDefinition(identityPinVerifyCommand)).toBe(false);
  });

  it("marks system settings writes as R5 and non-projectable", () => {
    expect(platformSettingsSetCommand.risk).toBe("R5");
    expect(platformSettingsSetCommand.offline_mode).toBe("denied");
    expect(isAiProjectableDefinition(platformSettingsSetCommand)).toBe(false);
  });

  it("parses login input and rejects missing password", async () => {
    const body = {
      org_code: "demo",
      store_code: "store1",
      username: "staff1",
      password: "not-a-real-password",
      device_id: crypto.randomUUID(),
    };
    await expect(parseContractInput(identityLoginCommand, body)).resolves.toMatchObject({
      username: "staff1",
    });
    await expect(
      parseContractInput(identityLoginCommand, { ...body, password: undefined }),
    ).rejects.toBeTruthy();
  });

  it("parses store features query", async () => {
    const storeId = crypto.randomUUID();
    await expect(
      parseContractInput(platformStoreFeaturesGetQuery, { store_id: storeId }),
    ).resolves.toEqual({ store_id: storeId });
  });
});
