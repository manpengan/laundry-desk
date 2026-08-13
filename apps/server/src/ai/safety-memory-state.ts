import type { AiTurnStartResult, AiTurnUsage } from "./streaming-store.js";
import { estimateCostMicros } from "./safety-guard.js";

export type MemoryAiSafetyPolicy = Readonly<{
  monthlyLimitMicros: number;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  circuitFailureThreshold: number;
  circuitOpenMs: number;
}>;

const DEFAULT_POLICY: MemoryAiSafetyPolicy = Object.freeze({
  monthlyLimitMicros: 10_000_000,
  inputMicrosPerMillion: 1_000_000,
  outputMicrosPerMillion: 4_000_000,
  circuitFailureThreshold: 3,
  circuitOpenMs: 300_000,
});

export class MemoryAiSafetyState {
  private reservations = new Map<string, Readonly<{ amount: number; month: string }>>();
  private consecutiveProviderFailures = 0;
  private circuitOpenUntil: Date | null = null;

  constructor(private readonly policy = DEFAULT_POLICY) {}

  authorize(
    input: Readonly<{
      turnId: string;
      estimatedInputTokens: number;
      maxOutputTokens: number;
      usage: readonly AiTurnUsage[];
      now: Date;
    }>,
  ): AiTurnStartResult {
    const reservation = estimateCostMicros(
      input.estimatedInputTokens,
      input.maxOutputTokens,
      this.policy.inputMicrosPerMillion,
      this.policy.outputMicrosPerMillion,
    );
    const spent = input.usage.reduce((sum, row) => sum + row.estimatedCostMicros, 0);
    const month = input.now.toISOString().slice(0, 7);
    const reserved = [...this.reservations.values()]
      .filter((value) => value.month === month)
      .reduce((sum, value) => sum + value.amount, 0);
    const denialCode =
      this.policy.monthlyLimitMicros <= 0
        ? ("AI_BUDGET_EXCEEDED" as const)
        : this.circuitOpenUntil !== null && this.circuitOpenUntil > input.now
          ? ("AI_CIRCUIT_OPEN" as const)
          : spent + reserved + reservation > this.policy.monthlyLimitMicros
            ? ("AI_BUDGET_EXCEEDED" as const)
            : null;
    this.reservations = new Map(this.reservations).set(
      input.turnId,
      Object.freeze({ amount: denialCode === null ? reservation : 0, month }),
    );
    return Object.freeze({
      started: true,
      denialCode,
      inputMicrosPerMillion: this.policy.inputMicrosPerMillion,
      outputMicrosPerMillion: this.policy.outputMicrosPerMillion,
    });
  }

  finish(
    turnId: string,
    status: "completed" | "failed" | "cancelled",
    errorCode: string | null,
    at: Date,
  ): void {
    this.reservations = new Map(this.reservations);
    this.reservations.delete(turnId);
    if (errorCode === "AI_PROVIDER_FAILED") {
      this.consecutiveProviderFailures += 1;
      if (this.consecutiveProviderFailures >= this.policy.circuitFailureThreshold) {
        this.circuitOpenUntil = new Date(at.getTime() + this.policy.circuitOpenMs);
      }
    } else if (status === "completed") {
      this.consecutiveProviderFailures = 0;
      this.circuitOpenUntil = null;
    }
  }

  status(usage: readonly AiTurnUsage[], now: Date) {
    const cost = usage.reduce((sum, row) => sum + row.estimatedCostMicros, 0);
    const open = this.circuitOpenUntil !== null && this.circuitOpenUntil > now;
    return Object.freeze({
      pii_masking: true as const,
      egress_policy: "https_443_allowlist" as const,
      month: now.toISOString().slice(0, 7),
      input_tokens: usage.reduce((sum, row) => sum + row.inputTokens, 0),
      output_tokens: usage.reduce((sum, row) => sum + row.outputTokens, 0),
      estimated_cost_micros: cost,
      monthly_limit_micros: this.policy.monthlyLimitMicros,
      remaining_micros: Math.max(0, this.policy.monthlyLimitMicros - cost),
      circuit_state: open ? ("open" as const) : ("closed" as const),
      circuit_open_until: open ? (this.circuitOpenUntil?.toISOString() ?? null) : null,
    });
  }
}
