import { describe, expect, it } from "vitest";

import {
  M1_FIRST_WAVE_DEFINITIONS,
  M2_SKELETON_COMMAND_NAMES,
  M2_SKELETON_DEFINITIONS,
  M3_PHOTO_COMMAND_DEFINITIONS,
  M3_PHOTO_COMMAND_NAMES,
  M3_PHOTO_QUERY_DEFINITIONS,
  M3_PHOTO_QUERY_NAMES,
  PHOTO_COMMAND_NAMES,
  PHOTO_COMMANDS,
  PHOTO_QUERY_NAMES,
  PHOTO_QUERIES,
  PhotoDeleteInputSchema,
  isContractDefinition,
  parseContractInput,
  photoDeleteCommand,
  photoListByOrderQuery,
  photoRegisterCommand,
} from "../src/index.js";

const SAMPLE_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GARMENT_UUID = "11111111-2222-4333-8444-555555555555";
const STORAGE_KEY = `${SAMPLE_UUID}.jpg`;
const CONTENT_SHA256 = "a".repeat(64);
const VALID_REGISTER = Object.freeze({
  garment_id: GARMENT_UUID,
  order_id: SAMPLE_UUID,
  kind: "receive" as const,
  storage_key: STORAGE_KEY,
  content_type: "image/jpeg" as const,
  content_sha256: CONTENT_SHA256,
  byte_size: 1024,
});

describe("M3 photo.register / photo.list_by_order skeleton", () => {
  it("registers definitions through A1 factory", () => {
    for (const definition of PHOTO_COMMANDS) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("command");
      expect(definition.risk).toBe("R2");
      expect(definition.offline_mode).toBe("denied");
      expect(definition.data_classification).toBe("internal");
    }
    for (const definition of PHOTO_QUERIES) {
      expect(isContractDefinition(definition)).toBe(true);
      expect(definition.kind).toBe("query");
      expect(definition.risk).toBe("R1");
      expect(definition.offline_mode).toBe("denied");
      expect(definition.max_result_rows).toBe(100);
    }
  });

  it("exports stable names and M3 photo aliases", () => {
    expect([...PHOTO_COMMAND_NAMES]).toEqual(["photo.register", "photo.delete"]);
    expect([...PHOTO_QUERY_NAMES]).toEqual(["photo.list_by_order"]);
    expect([...M3_PHOTO_COMMAND_NAMES]).toEqual([...PHOTO_COMMAND_NAMES]);
    expect([...M3_PHOTO_QUERY_NAMES]).toEqual([...PHOTO_QUERY_NAMES]);
    expect(M3_PHOTO_COMMAND_DEFINITIONS).toHaveLength(2);
    expect(M3_PHOTO_QUERY_DEFINITIONS).toHaveLength(1);
  });

  it("wires into M2 skeleton command catalog", () => {
    expect(M2_SKELETON_COMMAND_NAMES).toContain("photo.register");
    expect(M2_SKELETON_COMMAND_NAMES).toContain("photo.delete");
    expect(M2_SKELETON_DEFINITIONS.map((d) => d.name)).toContain("photo.register");
    expect(M2_SKELETON_DEFINITIONS.map((d) => d.name)).toContain("photo.delete");
  });

  it("keeps OpenAPI M1 first-wave free of photo contracts", () => {
    const names = M1_FIRST_WAVE_DEFINITIONS.map((d) => d.name);
    expect(names).not.toContain("photo.register");
    expect(names).not.toContain("photo.delete");
    expect(names).not.toContain("photo.list_by_order");
  });

  it("parses the internal photo.delete input", async () => {
    expect(PhotoDeleteInputSchema.parse({ photo_id: SAMPLE_UUID })).toEqual({
      photo_id: SAMPLE_UUID,
    });
    await expect(
      parseContractInput(photoDeleteCommand, { photo_id: SAMPLE_UUID }),
    ).resolves.toEqual({ photo_id: SAMPLE_UUID });
  });

  it("parses photo.register input", async () => {
    await expect(
      parseContractInput(photoRegisterCommand, {
        ...VALID_REGISTER,
      }),
    ).resolves.toEqual({
      ...VALID_REGISTER,
    });

    await expect(
      parseContractInput(photoRegisterCommand, {
        ...VALID_REGISTER,
        kind: "defect",
        content_type: "image/png",
        taken_at: 1_721_606_400,
      }),
    ).resolves.toMatchObject({
      kind: "defect",
      content_type: "image/png",
      taken_at: 1_721_606_400,
    });
  });

  it("rejects invalid photo.register input", async () => {
    await expect(parseContractInput(photoRegisterCommand, {})).rejects.toBeTruthy();
    await expect(
      parseContractInput(photoRegisterCommand, {
        ...VALID_REGISTER,
        byte_size: 0,
      }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(photoRegisterCommand, {
        ...VALID_REGISTER,
        byte_size: 1.5,
      }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(photoRegisterCommand, {
        ...VALID_REGISTER,
        kind: "unknown",
      }),
    ).rejects.toBeTruthy();
    await expect(
      parseContractInput(photoRegisterCommand, {
        ...VALID_REGISTER,
        garment_id: "not-a-uuid",
      }),
    ).rejects.toBeTruthy();
  });

  it("parses photo.list_by_order input", async () => {
    await expect(
      parseContractInput(photoListByOrderQuery, { order_id: SAMPLE_UUID }),
    ).resolves.toEqual({ order_id: SAMPLE_UUID });
  });

  it("declares metadata floors", () => {
    expect(photoRegisterCommand.name).toBe("photo.register");
    expect(photoRegisterCommand.risk).toBe("R2");
    expect(photoRegisterCommand.invariants).toContain("rbac.order_write");
    expect(photoRegisterCommand.offline_mode).toBe("denied");
    expect(photoRegisterCommand.idempotent).toBe(false);
    expect(photoListByOrderQuery.name).toBe("photo.list_by_order");
    expect(photoListByOrderQuery.risk).toBe("R1");
    expect(photoListByOrderQuery.idempotent).toBe(true);
  });
});
