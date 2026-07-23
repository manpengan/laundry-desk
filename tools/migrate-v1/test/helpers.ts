import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

export async function createFixtureDatabase(): Promise<
  Readonly<{ path: string; directory: string }>
> {
  const directory = await mkdtemp(join(tmpdir(), "laundry-migrate-fixture-"));
  const path = join(directory, "v1.db");
  const database = new Database(path);
  try {
    const sql = await readFile(new URL("./fixtures/v1-fixture.sql", import.meta.url), "utf8");
    database.exec(sql);
  } finally {
    database.close();
  }
  return Object.freeze({ path, directory });
}
