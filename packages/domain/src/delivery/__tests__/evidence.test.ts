import { describe, expect, it } from "vitest";

import {
  deliveryEvidenceCompletionTarget,
  deliveryEvidenceOrderStatusAllowsCompletion,
  evidenceRequirements,
  hasRequiredDeliveryEvidence,
} from "../evidence.js";

describe("delivery evidence policy", () => {
  it("requires GPS plus a photo for pickup and a signature for return completion", () => {
    expect(evidenceRequirements("pickup", "complete_leg")).toEqual({
      gps: true,
      minimumPhotos: 1,
      minimumSignatures: 0,
    });
    expect(
      hasRequiredDeliveryEvidence({
        leg: "return",
        outcome: "complete_leg",
        eventKind: "delivered",
        taskStatus: "accepted",
        hasGps: true,
        attachmentKinds: ["photo"],
      }),
    ).toBe(false);
    expect(
      hasRequiredDeliveryEvidence({
        leg: "return",
        outcome: "complete_leg",
        eventKind: "delivered",
        taskStatus: "accepted",
        hasGps: true,
        attachmentKinds: ["photo", "signature"],
      }),
    ).toBe(true);
  });

  it("keeps exception evidence non-completing and maps controlled completion targets", () => {
    expect(
      hasRequiredDeliveryEvidence({
        leg: "pickup",
        outcome: "complete_leg",
        eventKind: "exception",
        taskStatus: "accepted",
        hasGps: true,
        attachmentKinds: ["photo"],
      }),
    ).toBe(false);
    expect(deliveryEvidenceOrderStatusAllowsCompletion("pickup", "pickup_in_progress")).toBe(true);
    expect(deliveryEvidenceOrderStatusAllowsCompletion("return", "return_scheduled")).toBe(false);
    expect(deliveryEvidenceCompletionTarget("pickup")).toBe("picked_up");
    expect(deliveryEvidenceCompletionTarget("return")).toBe("completed");
  });
});
