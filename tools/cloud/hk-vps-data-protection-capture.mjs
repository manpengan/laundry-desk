import { join } from "node:path";

import { createDataProtectionManifest } from "./hk-vps-data-protection-contract.mjs";
import {
  createDataProtectionDump,
  dataProtectionVerificationFromDrill,
  drillDataProtectionSet,
  readDataProtectionSourceEvidence,
} from "./hk-vps-data-protection-db.mjs";
import {
  captureDataProtectionPhotos,
  publishDataProtectionSet,
  verifyDataProtectionSet,
  writeDataProtectionJson,
} from "./hk-vps-data-protection-files.mjs";

export async function captureVerifiedDataProtectionSet(input, dependencies = {}) {
  const evidence = await (dependencies.readSourceEvidence ?? readDataProtectionSourceEvidence)(
    input.signal,
  );
  await input.onPhase?.("capturing");
  const database = await (dependencies.createDump ?? createDataProtectionDump)(
    join(input.stagingPath, "database.dump"),
    input.signal,
  );
  const photos = await (dependencies.capturePhotos ?? captureDataProtectionPhotos)(
    input.stagingPath,
    evidence.photos,
    { sourceIdentity: input.sourceIdentity },
  );
  const manifest = createDataProtectionManifest({
    set_id: input.setId,
    kind: input.kind,
    code_sha: evidence.codeSha,
    created_at: input.createdAt.toISOString(),
    migration: evidence.migration,
    database,
    photos,
  });
  await (dependencies.writeJson ?? writeDataProtectionJson)(
    join(input.stagingPath, "manifest.json"),
    manifest,
  );
  const preliminary = await (dependencies.verifySet ?? verifyDataProtectionSet)(input.stagingPath, {
    expectedSetId: input.setId,
    requireVerification: false,
  });
  await input.onPhase?.("verifying");
  const drill = await (dependencies.drillSet ?? drillDataProtectionSet)(preliminary, input.signal);
  await (dependencies.writeJson ?? writeDataProtectionJson)(
    join(input.stagingPath, "verification.json"),
    dataProtectionVerificationFromDrill(
      preliminary,
      drill,
      (dependencies.now?.() ?? new Date()).toISOString(),
    ),
  );
  await (dependencies.verifySet ?? verifyDataProtectionSet)(input.stagingPath, {
    expectedSetId: input.setId,
  });
  const setPath = await (dependencies.publishSet ?? publishDataProtectionSet)(
    input.stagingPath,
    input.setId,
  );
  const verified = await (dependencies.verifySet ?? verifyDataProtectionSet)(setPath, {
    expectedSetId: input.setId,
  });
  return Object.freeze({ evidence, setPath, verified });
}
