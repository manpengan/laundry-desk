/**
 * C4 pure listTools — filter projected tool descriptors (no I/O, no model calls).
 */

import { M1_FIRST_WAVE_DEFINITIONS } from "@laundry/contracts";

import { projectCatalogToTools, type LlmToolDescriptor } from "./registry.js";

/** Risk rank for maxRisk ceiling filters (R5 never appears in the projection). */
const RISK_RANK: Readonly<Record<string, number>> = Object.freeze({
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
});

/**
 * M1 AI preset → tool name whitelist (ADR-05 #3 presets).
 * Empty list means the preset exposes no tools (fail-closed).
 * Unknown presets fall back to empty (fail-closed).
 */
export const AI_PRESET_WHITELISTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  /** M2 read-only counter assistant: queries + low-risk session hygiene. */
  counter_readonly: Object.freeze([
    "identity.logout",
    "identity.refresh",
    "identity.pin_challenge",
    "platform.settings.get",
    "platform.store_features.get",
  ]),
  /** Ops assist may also read audit windows (R2 PII — still non-secret). */
  ops_audit_readonly: Object.freeze([
    "identity.logout",
    "platform.settings.get",
    "platform.store_features.get",
    "platform.audit.list",
  ]),
  /** Empty preset for red-team / deny-all smoke. */
  deny_all: Object.freeze([] as string[]),
});

export type ListToolsFilter = Readonly<{
  /** Restrict to these tool names (intersected with projection + preset). */
  names?: readonly string[];
  /** Inclusive risk ceiling (R0–R4). */
  maxRisk?: "R0" | "R1" | "R2" | "R3" | "R4";
  /** AI preset key — applies per-preset whitelist (fail-closed if unknown). */
  preset?: string;
  kind?: "command" | "query";
}>;

function whitelistForPreset(preset: string | undefined): ReadonlySet<string> | null {
  if (preset === undefined) return null;
  const list = AI_PRESET_WHITELISTS[preset];
  if (list === undefined) return new Set();
  return new Set(list);
}

function passesRiskCeiling(tool: LlmToolDescriptor, maxRisk: string | undefined): boolean {
  if (maxRisk === undefined) return true;
  const toolRank = RISK_RANK[tool.risk];
  const ceiling = RISK_RANK[maxRisk];
  if (toolRank === undefined || ceiling === undefined) return false;
  return toolRank <= ceiling;
}

/**
 * Pure list of LLM tool descriptors from the safe command/query catalog projection.
 * Always excludes R5 and secret-classified definitions (via projectCatalogToTools).
 */
export function listTools(filter?: ListToolsFilter): readonly LlmToolDescriptor[] {
  const projected = projectCatalogToTools(M1_FIRST_WAVE_DEFINITIONS);
  const nameAllow = filter?.names === undefined ? null : new Set(filter.names);
  const presetAllow = whitelistForPreset(filter?.preset);

  const filtered = projected.filter((tool) => {
    if (nameAllow !== null && !nameAllow.has(tool.name)) return false;
    if (presetAllow !== null && !presetAllow.has(tool.name)) return false;
    if (filter?.kind !== undefined && tool.kind !== filter.kind) return false;
    if (!passesRiskCeiling(tool, filter?.maxRisk)) return false;
    return true;
  });

  return Object.freeze(filtered);
}

/** Names only — convenient for policy / red-team assertions. */
export function listToolNames(filter?: ListToolsFilter): readonly string[] {
  return Object.freeze(listTools(filter).map((tool) => tool.name));
}
