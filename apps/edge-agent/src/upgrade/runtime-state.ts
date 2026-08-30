import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  flushDirectoryDurablySync,
  inspectPrivateDirectorySync,
  inspectPrivateFileSync,
  replaceFileWriteThroughSync,
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "@laundry/platform-fs";
import { z } from "zod";

import { compareVersion, isSemVer } from "./version.js";

const SlotSchema = z.strictObject({
  version: z.string().nullable(),
  app_path: z.string().nullable(),
  artifact_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable(),
  healthy: z.boolean(),
});

const RuntimeUpdateStateSchema = z.strictObject({
  version: z.literal(1),
  active_slot: z.enum(["A", "B"]),
  slots: z.strictObject({ A: SlotSchema, B: SlotSchema }),
  minimum_secure_version: z.string(),
  pending_activation: z
    .strictObject({
      slot: z.enum(["A", "B"]),
      previous_slot: z.enum(["A", "B"]),
      nonce: z.uuid(),
      started_at: z.iso.datetime({ offset: true }),
      launch_started: z.boolean(),
    })
    .nullable(),
  history: z
    .array(
      z.strictObject({
        at: z.iso.datetime({ offset: true }),
        event: z.string().min(1).max(64),
        slot: z.enum(["A", "B"]).optional(),
        version: z.string().optional(),
      }),
    )
    .max(200),
});

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type RuntimeSlotName = "A" | "B";
export type RuntimeUpdateState = DeepReadonly<z.output<typeof RuntimeUpdateStateSchema>>;
export const RUNTIME_RECOVERY_CAPABILITIES = Object.freeze(["read_only", "print_only"] as const);
export type RuntimeRecoveryCapabilities = typeof RUNTIME_RECOVERY_CAPABILITIES;
export type RuntimeRollbackDecision =
  | Readonly<{ status: "none"; state: RuntimeUpdateState }>
  | Readonly<{ status: "rolled_back"; state: RuntimeUpdateState }>
  | Readonly<{
      status: "recovery_required";
      state: RuntimeUpdateState;
      capabilities: RuntimeRecoveryCapabilities;
    }>;

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Update state escaped its private root");
  }
}

function freezeState(value: unknown): RuntimeUpdateState {
  const parsed = RuntimeUpdateStateSchema.parse(value);
  return Object.freeze({
    ...parsed,
    slots: Object.freeze({
      A: Object.freeze({ ...parsed.slots.A }),
      B: Object.freeze({ ...parsed.slots.B }),
    }),
    pending_activation:
      parsed.pending_activation === null ? null : Object.freeze({ ...parsed.pending_activation }),
    history: Object.freeze(parsed.history.map((entry) => Object.freeze({ ...entry }))),
  });
}

export class RuntimeUpdateStateStore {
  readonly root: string;
  private readonly path: string;
  private state: RuntimeUpdateState;

  constructor(
    rootPath: string,
    initial: Readonly<{
      currentVersion: string;
      currentAppPath: string;
      minimumSecureVersion: string;
      now?: () => string;
    }>,
  ) {
    if (!isAbsolute(rootPath) || !isAbsolute(initial.currentAppPath)) {
      throw new Error("Update paths must be absolute");
    }
    if (!isSemVer(initial.currentVersion) || !isSemVer(initial.minimumSecureVersion)) {
      throw new Error("Update versions must use exact SemVer");
    }
    mkdirSync(rootPath, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(rootPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Update root must be a real directory");
    }
    securePrivateDirectorySync(rootPath);
    this.root = realpathSync(rootPath);
    inspectPrivateDirectorySync(this.root);
    this.path = join(this.root, "update-state.json");
    assertContained(this.root, this.path);
    if (existsSync(this.path)) {
      const stateMeta = lstatSync(this.path);
      if (!stateMeta.isFile() || stateMeta.isSymbolicLink() || stateMeta.size > 256 * 1_024) {
        throw new Error("Invalid update state file");
      }
      try {
        inspectPrivateFileSync(this.path);
      } catch (error) {
        throw new Error("Invalid update state file", { cause: error });
      }
      this.state = freezeState(JSON.parse(readFileSync(this.path, "utf8")) as unknown);
      return;
    }
    const now = initial.now ?? (() => new Date().toISOString());
    this.state = freezeState({
      version: 1,
      active_slot: "A",
      slots: {
        A: {
          version: initial.currentVersion,
          app_path: initial.currentAppPath,
          artifact_sha256: null,
          healthy: true,
        },
        B: { version: null, app_path: null, artifact_sha256: null, healthy: false },
      },
      minimum_secure_version: initial.minimumSecureVersion,
      pending_activation: null,
      history: [
        { at: now(), event: "state_initialized", slot: "A", version: initial.currentVersion },
      ],
    });
    this.persist(this.state);
  }

  snapshot(): RuntimeUpdateState {
    return this.state;
  }

  standbySlot(): RuntimeSlotName {
    return this.state.active_slot === "A" ? "B" : "A";
  }

  slotRoot(slot: RuntimeSlotName): string {
    const path = join(this.root, "slots", slot);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    securePrivateDirectorySync(path);
    const real = realpathSync(path);
    assertContained(this.root, real);
    inspectPrivateDirectorySync(real);
    return real;
  }

  activate(
    input: Readonly<{
      slot: RuntimeSlotName;
      version: string;
      appPath: string;
      artifactSha256: string;
      nonce: string;
      now: string;
      minimumSecureVersion: string;
    }>,
  ): RuntimeUpdateState {
    if (input.slot === this.state.active_slot || !isAbsolute(input.appPath)) {
      throw new Error("Update activation target must be the standby slot");
    }
    const next = {
      ...this.state,
      active_slot: input.slot,
      slots: {
        ...this.state.slots,
        [input.slot]: {
          version: input.version,
          app_path: input.appPath,
          artifact_sha256: input.artifactSha256,
          healthy: true,
        },
      },
      minimum_secure_version:
        compareVersion(input.minimumSecureVersion, this.state.minimum_secure_version) > 0
          ? input.minimumSecureVersion
          : this.state.minimum_secure_version,
      pending_activation: {
        slot: input.slot,
        previous_slot: this.state.active_slot,
        nonce: input.nonce,
        started_at: input.now,
        launch_started: false,
      },
      history: [
        ...this.state.history.slice(-198),
        { at: input.now, event: "slot_activated", slot: input.slot, version: input.version },
      ],
    };
    this.persist(freezeState(next));
    return this.state;
  }

  raiseSecurityFloor(version: string, now: string): RuntimeUpdateState {
    if (!isSemVer(version)) throw new Error("Security floor must be exact SemVer");
    if (compareVersion(version, this.state.minimum_secure_version) <= 0) return this.state;
    this.persist(
      freezeState({
        ...this.state,
        minimum_secure_version: version,
        history: [
          ...this.state.history.slice(-198),
          { at: now, event: "security_floor_raised", version },
        ],
      }),
    );
    return this.state;
  }

  confirmActivation(slot: RuntimeSlotName, nonce: string, now: string): RuntimeUpdateState {
    const pending = this.state.pending_activation;
    if (pending === null || pending.slot !== slot || pending.nonce !== nonce) {
      throw new Error("Activation confirmation does not match pending state");
    }
    this.persist(
      freezeState({
        ...this.state,
        pending_activation: null,
        history: [
          ...this.state.history.slice(-198),
          { at: now, event: "activation_confirmed", slot },
        ],
      }),
    );
    return this.state;
  }

  markActivationLaunched(nonce: string): RuntimeUpdateState {
    const pending = this.state.pending_activation;
    if (pending === null || pending.nonce !== nonce || pending.launch_started) {
      throw new Error("Activation launch does not match pending state");
    }
    this.persist(
      freezeState({
        ...this.state,
        pending_activation: { ...pending, launch_started: true },
      }),
    );
    return this.state;
  }

  rollbackPending(now: string): RuntimeRollbackDecision {
    const pending = this.state.pending_activation;
    if (pending === null) {
      return Object.freeze({ status: "none", state: this.state });
    }
    const fallbackVersion = this.state.slots[pending.previous_slot].version;
    if (
      fallbackVersion === null ||
      compareVersion(fallbackVersion, this.state.minimum_secure_version) < 0
    ) {
      const lastHistory = this.state.history.at(-1);
      if (
        lastHistory?.event !== "security_floor_recovery_required" ||
        lastHistory.slot !== pending.slot ||
        (lastHistory.version ?? null) !== fallbackVersion
      ) {
        this.persist(
          freezeState({
            ...this.state,
            history: [
              ...this.state.history.slice(-198),
              {
                at: now,
                event: "security_floor_recovery_required",
                slot: pending.slot,
                ...(fallbackVersion === null ? {} : { version: fallbackVersion }),
              },
            ],
          }),
        );
      }
      return Object.freeze({
        status: "recovery_required",
        state: this.state,
        capabilities: RUNTIME_RECOVERY_CAPABILITIES,
      });
    }
    this.persist(
      freezeState({
        ...this.state,
        active_slot: pending.previous_slot,
        slots: {
          ...this.state.slots,
          [pending.slot]: { ...this.state.slots[pending.slot], healthy: false },
        },
        pending_activation: null,
        history: [
          ...this.state.history.slice(-198),
          { at: now, event: "activation_rolled_back", slot: pending.slot },
        ],
      }),
    );
    return Object.freeze({ status: "rolled_back", state: this.state });
  }

  private persist(state: RuntimeUpdateState): void {
    const temp = join(this.root, `.update-state.${randomBytes(12).toString("hex")}.staging`);
    assertContained(this.root, temp);
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let replaced = false;
    try {
      securePrivateFileSync(temp);
      writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      replaceFileWriteThroughSync(temp, this.path);
      replaced = true;
      flushDirectoryDurablySync(this.root);
    } catch (error) {
      if (!replaced) {
        try {
          unlinkSync(temp);
          flushDirectoryDurablySync(this.root);
        } catch {
          // The original persistence failure remains authoritative.
        }
      }
      throw error;
    }
    this.state = freezeState(state);
  }
}
