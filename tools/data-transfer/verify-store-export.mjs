import { verifyStoreExport } from "../../apps/server/dist/data-transfer/store-export-verify.js";
const [directory, expectedSha256, ...rest] = process.argv.slice(2);
if (!directory || !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "") || rest.length) {
  process.stderr.write(
    "Usage: node tools/data-transfer/verify-store-export.mjs <data-directory> <manifest-sha256>\n",
  );
  process.exitCode = 1;
} else {
  try {
    const manifest = await verifyStoreExport(directory, expectedSha256);
    process.stdout.write(
      `${JSON.stringify({ verified: true, tables: manifest.tables.length, photos: manifest.photos.length })}\n`,
    );
  } catch {
    process.stderr.write("STORE_EXPORT_INTEGRITY_FAILED\n");
    process.exitCode = 1;
  }
}
