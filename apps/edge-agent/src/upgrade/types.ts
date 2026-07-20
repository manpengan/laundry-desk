/** A/B dual-slot upgrade skeleton (ADR-08). Full autoUpdater packaging is M2. */

export type SlotName = "A" | "B";

export type UpgradeMode = "ACTIVE" | "INSTALL_STANDBY" | "REVERT_STANDBY" | "RECOVERY_MODE";

export type SlotInfo = {
  version: string | null;
  healthy: boolean;
};

export type HistoryEntry = {
  at: string;
  event: string;
  detail?: Record<string, unknown>;
};

export type UpgradeState = {
  activeSlot: SlotName;
  slots: Record<SlotName, SlotInfo>;
  queueEmpty: boolean;
  /** When true, no new Primary lease may be issued (ADR-08 §6). */
  primaryLeaseIssuanceBlocked: boolean;
  localSchema: number;
  contractPhaseDone: boolean;
  minSecureVersion: string;
  mode: UpgradeMode;
  history: HistoryEntry[];
};

export type SupportMatrixRow = {
  edge: string;
  rollbackToEdge: string;
  rollbackReadsSchema: boolean;
  notes?: string;
};

export type SupportMatrix = {
  rows: SupportMatrixRow[];
};

export type HealthReport = {
  hardwareOk: boolean;
  localDbOpen: boolean;
  serverHandshakeOk: boolean;
};

export type InstallInput = {
  version: string;
  health: HealthReport;
  /** Demo only: apply schema contract phase after switch (blocks rollback). */
  applyContract?: boolean;
  now?: () => string;
};

export type InstallResult =
  | {
      ok: true;
      switched: boolean;
      state: UpgradeState;
      reason?: string;
    }
  | {
      ok: false;
      error: string;
      state: UpgradeState;
    };

export type RollbackInput = {
  targetVersion?: string;
  matrix: SupportMatrix;
  /** Test seam: force matrix decision without reading rows. */
  forceMatrixAllowed?: boolean;
  now?: () => string;
};

export type RollbackResult =
  | {
      ok: true;
      mode: "ACTIVE";
      state: UpgradeState;
    }
  | {
      ok: false;
      mode: "RECOVERY_MODE" | "REJECTED";
      error: string;
      state: UpgradeState;
      capabilities?: readonly string[];
    };
