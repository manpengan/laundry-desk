import { V1_MIGRATION_PHOTO_MAX_BYTES } from "@laundry/contracts";
export type MigrationPhotoTarget = Readonly<{
  id: string;
  source_relative_path: string;
  garment_id: string;
}>;
export type MigrationPhotoFile = Readonly<{
  name: string;
  size: number;
  type: string;
  webkitRelativePath?: string;
}>;
export type MigrationPhotoMatch = Readonly<{
  target: MigrationPhotoTarget;
  candidates: readonly number[];
  selected: number | null;
  state: "matched" | "ambiguous" | "missing";
}>;
export type MigrationPhotoPlan = Readonly<{
  matches: readonly MigrationPhotoMatch[];
  rejected: readonly Readonly<{ index: number; reason: string }>[];
  unmatched: readonly number[];
}>;
function normalized(path: string): string | null {
  const value = path.replaceAll("\\", "/").normalize("NFC").toLocaleLowerCase("en-US");
  const parts = value.split("/");
  if (
    value.length > 4096 ||
    parts.some(
      (part) => part === "" || part === "." || part === ".." || /[:\u0000-\u001f]/u.test(part),
    )
  )
    return null;
  return parts.join("/");
}
export function migrationPhotoFileLabel(file: MigrationPhotoFile): string {
  return file.webkitRelativePath || file.name;
}
export function migrationPhotoFileError(file: MigrationPhotoFile): string | null {
  if (file.size < 1 || file.size > V1_MIGRATION_PHOTO_MAX_BYTES)
    return "照片必须在 1 B 至 8 MiB 之间";
  if (
    !/\.(?:jpe?g|png|webp)$/iu.test(file.name) ||
    (file.type !== "" && !["image/jpeg", "image/png", "image/webp"].includes(file.type))
  )
    return "仅支持 JPEG、PNG 或 WebP";
  if (normalized(migrationPhotoFileLabel(file)) === null) return "文件相对路径无效";
  return null;
}
export function matchMigrationPhotos(
  targets: readonly MigrationPhotoTarget[],
  files: readonly MigrationPhotoFile[],
): MigrationPhotoPlan {
  const paths = new Map<string, readonly number[]>();
  const names = new Map<string, readonly number[]>();
  const rejected: { index: number; reason: string }[] = [];
  files.forEach((file, index) => {
    const reason = migrationPhotoFileError(file);
    if (reason !== null) {
      rejected.push({ index, reason });
      return;
    }
    const path = normalized(migrationPhotoFileLabel(file))!;
    const parts = path.split("/");
    for (let segment = 0; segment < parts.length; segment++) {
      const suffix = parts.slice(segment).join("/");
      paths.set(suffix, [...(paths.get(suffix) ?? []), index]);
    }
    names.set(parts.at(-1)!, [...(names.get(parts.at(-1)!) ?? []), index]);
  });
  const sourceNames = new Map<string, number>();
  targets.forEach((target) => {
    const name = normalized(target.source_relative_path)?.split("/").at(-1);
    if (name !== undefined) sourceNames.set(name, (sourceNames.get(name) ?? 0) + 1);
  });
  const used = new Set<number>();
  const matches = targets.map((target): MigrationPhotoMatch => {
    const source = normalized(target.source_relative_path);
    const exact = source === null ? [] : (paths.get(source) ?? []);
    const name = source?.split("/").at(-1);
    const candidates = exact.length > 0 ? exact : name === undefined ? [] : (names.get(name) ?? []);
    candidates.forEach((index) => used.add(index));
    const unique =
      candidates.length === 1 &&
      (exact.length > 0 || (name !== undefined && sourceNames.get(name) === 1));
    return {
      target,
      candidates,
      selected: unique ? candidates[0]! : null,
      state: unique ? "matched" : candidates.length > 0 ? "ambiguous" : "missing",
    };
  });
  const invalid = new Set(rejected.map((row) => row.index));
  return {
    matches,
    rejected,
    unmatched: files.flatMap((_file, index) =>
      used.has(index) || invalid.has(index) ? [] : [index],
    ),
  };
}
