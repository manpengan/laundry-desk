import type { DeliveryOrderStatus } from "./lifecycle.js";
import type { DeliveryTaskLeg, DeliveryTaskStatus } from "./task-lifecycle.js";

export type DeliveryEvidenceEventKind = "pickup" | "delivered" | "exception";
export type DeliveryEvidenceOutcome = "record_only" | "complete_leg";
export type DeliveryEvidenceAttachmentKind = "photo" | "signature";

export type DeliveryEvidenceRequirements = Readonly<{
  gps: boolean;
  minimumPhotos: number;
  minimumSignatures: number;
}>;

const RECORD_ONLY_REQUIREMENTS = Object.freeze({
  gps: false,
  minimumPhotos: 0,
  minimumSignatures: 0,
});

const COMPLETE_REQUIREMENTS = Object.freeze({
  pickup: Object.freeze({ gps: true, minimumPhotos: 1, minimumSignatures: 0 }),
  return: Object.freeze({ gps: true, minimumPhotos: 1, minimumSignatures: 1 }),
});

export function evidenceRequirements(
  leg: DeliveryTaskLeg,
  outcome: DeliveryEvidenceOutcome,
): DeliveryEvidenceRequirements {
  return outcome === "complete_leg" ? COMPLETE_REQUIREMENTS[leg] : RECORD_ONLY_REQUIREMENTS;
}

export function deliveryEvidenceEventMatchesLeg(
  leg: DeliveryTaskLeg,
  eventKind: DeliveryEvidenceEventKind,
): boolean {
  return (
    eventKind === "exception" ||
    (leg === "pickup" ? eventKind === "pickup" : eventKind === "delivered")
  );
}

export function deliveryEvidenceOrderStatusAllowsRecord(
  leg: DeliveryTaskLeg,
  orderStatus: DeliveryOrderStatus,
): boolean {
  return leg === "pickup"
    ? orderStatus === "pickup_scheduled" || orderStatus === "pickup_in_progress"
    : orderStatus === "return_scheduled" || orderStatus === "return_in_progress";
}

export function deliveryEvidenceOrderStatusAllowsCompletion(
  leg: DeliveryTaskLeg,
  orderStatus: DeliveryOrderStatus,
): boolean {
  return leg === "pickup"
    ? orderStatus === "pickup_in_progress"
    : orderStatus === "return_in_progress";
}

export function deliveryEvidenceCompletionTarget(leg: DeliveryTaskLeg): DeliveryOrderStatus {
  return leg === "pickup" ? "picked_up" : "completed";
}

export function hasRequiredDeliveryEvidence(
  input: Readonly<{
    leg: DeliveryTaskLeg;
    outcome: DeliveryEvidenceOutcome;
    eventKind: DeliveryEvidenceEventKind;
    taskStatus: DeliveryTaskStatus;
    hasGps: boolean;
    attachmentKinds: readonly DeliveryEvidenceAttachmentKind[];
  }>,
): boolean {
  if (
    input.taskStatus !== "accepted" ||
    !deliveryEvidenceEventMatchesLeg(input.leg, input.eventKind)
  ) {
    return false;
  }
  if (input.outcome === "complete_leg" && input.eventKind === "exception") return false;
  if (input.outcome === "record_only") {
    return input.hasGps || input.attachmentKinds.length > 0;
  }
  const requirements = evidenceRequirements(input.leg, input.outcome);
  const photoCount = input.attachmentKinds.filter((kind) => kind === "photo").length;
  const signatureCount = input.attachmentKinds.filter((kind) => kind === "signature").length;
  return (
    (!requirements.gps || input.hasGps) &&
    photoCount >= requirements.minimumPhotos &&
    signatureCount >= requirements.minimumSignatures
  );
}
