import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  inspectPrivateDirectory,
  inspectPrivateFile,
  securePrivateDirectory,
  securePrivateFile,
} from "@laundry/platform-fs";
import {
  reconcileMigration,
  transformV1Snapshot,
  validateMigrationPlan,
  type ReconciliationReport,
  type V2MigrationPlan,
} from "@laundry/migrate-v1/plan";
import { assertSupportedLegacySettings } from "./import-legacy.js";
import { migrationHistorySummary } from "./import-history.js";
import { reassignedPickupCount } from "./import-pickup.js";
import { reviewMigrationPhotos } from "./import-photos.js";

import {
  cleanupImportRequest,
  cleanupStaleImportMaterials,
  IMPORT_REQUEST_MARKER,
  importRequestMarker,
} from "./import-cleanup.js";

const MARKER = ".laundry-v1-import-v1";
const MARKER_BYTES = "laundry-v1-import-v1\n";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const MAX_IMPORT_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_PHOTO_BYTES = 8 * 1024 * 1024;
const DRAFT_TTL_MS = 30 * 60_000;

type Draft = Readonly<{
  id: string;
  sessionId: string;
  expiresAt: number;
  plan: V2MigrationPlan;
  report: ReconciliationReport;
  planSha256: string;
  uploadedBytes: number;
  approved: boolean;
}>;
export type ImportPreview = Readonly<{
  reassigned_pickup_codes: number;
  history: ReturnType<typeof migrationHistorySummary>;
  draft_id: string;
  source_sha256: string;
  plan_sha256: string;
  report: ReconciliationReport;
  photos: readonly Readonly<{
    id: string;
    source_relative_path: string;
    garment_id: string;
    association: "first_garment_in_legacy_order";
  }>[];
  warnings: V2MigrationPlan["warnings"];
  expires_at: number;
}>;

async function privateDirectory(path: string): Promise<void> {
  const existing = await lstat(path).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error("V1_MIGRATION_PRIVATE_ROOT_INVALID");
  if (!existing) await mkdir(path, { mode: 0o700 });
  await securePrivateDirectory(path);
  await inspectPrivateDirectory(path);
}

async function privateWrite(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await securePrivateFile(path);
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await inspectPrivateFile(path);
}

export async function openImportRequestRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error("V1_MIGRATION_PRIVATE_ROOT_INVALID");
  await inspectPrivateDirectory(dirname(root));
  const exists = await lstat(root).catch(() => null);
  if (exists) {
    await inspectPrivateDirectory(root);
    await inspectPrivateFile(join(root, MARKER));
    if ((await readFile(join(root, MARKER), "utf8")) !== MARKER_BYTES)
      throw new Error("V1_MIGRATION_PRIVATE_ROOT_INVALID");
  } else {
    await privateDirectory(root);
    await privateWrite(join(root, MARKER), Buffer.from(MARKER_BYTES));
  }
  return root;
}

export function importRequestPaths(root: string, requestId: string) {
  if (!UUID.test(requestId)) throw new Error("V1_MIGRATION_REQUEST_INVALID");
  return Object.freeze({
    directory: join(root, requestId),
    source: join(root, requestId, "source.db"),
    photos: join(root, requestId, "photos"),
  });
}

export async function createImportDraftStore(root: string, now = () => Date.now()) {
  await openImportRequestRoot(root);
  await cleanupStaleImportMaterials(root, now());
  const drafts = new Map<string, Draft>();
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const requireDraft = (id: string, sessionId: string, allowApproved = false) => {
    const draft = drafts.get(id);
    if (
      !draft ||
      draft.sessionId !== sessionId ||
      draft.expiresAt <= now() ||
      (draft.approved && !allowApproved)
    )
      throw new Error("V1_MIGRATION_DRAFT_UNAVAILABLE");
    return draft;
  };
  const preview = (draft: Draft): ImportPreview => ({
    reassigned_pickup_codes: reassignedPickupCount(draft.plan),
    history: migrationHistorySummary(draft.plan),
    draft_id: draft.id,
    source_sha256: draft.plan.sourceBackupSha256,
    plan_sha256: draft.planSha256,
    report: draft.report,
    warnings: draft.plan.warnings,
    expires_at: draft.expiresAt,
    photos: draft.plan.photos.map((photo) => ({
      id: photo.id,
      source_relative_path: photo.sourceRelativePath,
      garment_id: photo.garmentId,
      association: "first_garment_in_legacy_order",
    })),
  });
  const prune = () =>
    serial(async () => {
      for (const draft of drafts.values()) {
        if (draft.expiresAt > now()) continue;
        // Only directories created by this process; approved maintenance materials
        // stay available to the runtime and its explicit completion cleanup.
        if (!draft.approved) {
          await cleanupImportRequest(root, draft.id);
        }
        drafts.delete(draft.id);
      }
      await cleanupStaleImportMaterials(root, now());
    });
  return Object.freeze({
    root,
    prune,
    create: (sessionId: string, bytes: Buffer) =>
      serial(async () => {
        if (
          bytes.length < 100 ||
          bytes.length > MAX_IMPORT_SOURCE_BYTES ||
          bytes.subarray(0, 16).toString("binary") !== "SQLite format 3\u0000"
        ) {
          throw new Error("V1_MIGRATION_SOURCE_INVALID");
        }
        if (
          drafts.size >= 8 ||
          (await readdir(root)).filter((name) => UUID.test(name)).length >= 32
        ) {
          throw new Error("V1_MIGRATION_DRAFT_LIMIT");
        }
        const id = randomUUID();
        const paths = importRequestPaths(root, id);
        await privateDirectory(paths.directory);
        await privateWrite(
          join(paths.directory, IMPORT_REQUEST_MARKER),
          Buffer.from(importRequestMarker(id)),
        );
        await privateDirectory(paths.photos);
        try {
          await privateWrite(paths.source, bytes);
          const { extractV1Snapshot } = await import("@laundry/migrate-v1");
          const source = await extractV1Snapshot(paths.source);
          const plan = transformV1Snapshot(source);
          const report = reconcileMigration(source, plan);
          const { planSha256 } = validateMigrationPlan(plan, report);
          assertSupportedLegacySettings(plan);
          const draft: Draft = {
            id,
            sessionId,
            plan,
            report,
            planSha256,
            expiresAt: now() + DRAFT_TTL_MS,
            uploadedBytes: 0,
            approved: false,
          };
          const view = preview(draft);
          if (Buffer.byteLength(JSON.stringify(view), "utf8") > 480 * 1024) {
            throw new Error("V1_MIGRATION_PREVIEW_LIMIT");
          }
          drafts.set(id, draft);
          return view;
        } catch (error) {
          await rm(paths.directory, { recursive: true });
          throw error;
        }
      }),
    uploadPhoto: (sessionId: string, id: string, photoId: string, bytes: Buffer) =>
      serial(async () => {
        const draft = requireDraft(id, sessionId);
        const photo = draft.plan.photos.find((candidate) => candidate.id === photoId);
        if (
          !photo ||
          bytes.length < 1 ||
          bytes.length > MAX_IMPORT_PHOTO_BYTES ||
          draft.uploadedBytes + bytes.length > 128 * 1024 * 1024
        )
          throw new Error("V1_MIGRATION_PHOTO_INVALID");
        const parts = photo.sourceRelativePath.split("/");
        if (parts.some((part) => !part || part === "." || part === ".." || /[\\:]/u.test(part))) {
          throw new Error("V1_MIGRATION_PHOTO_PATH");
        }
        let directory = importRequestPaths(root, id).photos;
        for (const part of parts.slice(0, -1)) {
          directory = join(directory, part);
          await privateDirectory(directory);
        }
        const destination = join(directory, parts.at(-1)!);
        const existing = await lstat(destination).catch(() => null);
        if (existing !== null) {
          await inspectPrivateFile(destination);
          if (!(await readFile(destination)).equals(bytes))
            throw new Error("V1_MIGRATION_PHOTO_CONFLICT");
          return;
        }
        await privateWrite(destination, bytes);
        drafts.set(id, { ...draft, uploadedBytes: draft.uploadedBytes + bytes.length });
      }),
    review: (sessionId: string, id: string) =>
      serial(async () => {
        const draft = requireDraft(id, sessionId);
        const photos = await reviewMigrationPhotos(draft.plan, importRequestPaths(root, id).photos);
        return { ...preview(draft), photos_sha256: photos.sha256 };
      }),
    approve: (
      sessionId: string,
      id: string,
      operation: (draft: ImportPreview & Readonly<{ photos_sha256: string }>) => Promise<number>,
    ) =>
      serial(async () => {
        const draft = requireDraft(id, sessionId);
        const photos = await reviewMigrationPhotos(draft.plan, importRequestPaths(root, id).photos);
        const expiresAt = await operation({ ...preview(draft), photos_sha256: photos.sha256 });
        drafts.set(id, { ...draft, approved: true, expiresAt });
        return { request_id: id, expires_at: expiresAt };
      }),
  });
}
export type ImportDraftStore = Awaited<ReturnType<typeof createImportDraftStore>>;
