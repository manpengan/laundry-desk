import assert from "node:assert/strict";
import test from "node:test";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { deriveMiniappProfileAuthorityKey } from "../customer-miniapp/profile-authority.js";
import { prepareMiniappProfileAuthority } from "./miniapp-authority-bootstrap.js";

const urls = resolvePgUrls();
test(
  "owner authority initialization is idempotent, rotates on secret change and remains app-private",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin, max: 1 });
    const app = createPgPool({ connectionString: urls.app, max: 1 });
    const first = "synthetic-old-runtime-authority-secret-32-bytes";
    const next = "synthetic-new-runtime-authority-secret-32-bytes";
    try {
      await admin.query(
        "INSERT INTO orgs(id,code,name,created_at,updated_at) VALUES($1,'authority-fixture','Synthetic',now(),now()) ON CONFLICT(id) DO NOTHING",
        [LOCAL_PROFILE.orgId],
      );
      await admin.query(
        "INSERT INTO stores(id,org_id,code,name,timezone,created_at,updated_at) VALUES($1,$2,'authority-fixture','Synthetic','Asia/Taipei',now(),now()) ON CONFLICT(id) DO NOTHING",
        [LOCAL_PROFILE.storeId, LOCAL_PROFILE.orgId],
      );
      const read = async () =>
        (
          await admin.query<{ hmac_key: Buffer; revision: string }>(
            "SELECT hmac_key,xmin::text AS revision FROM miniapp_profile_authority WHERE org_id=$1 AND store_id=$2",
            [LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId],
          )
        ).rows[0]!;
      await prepareMiniappProfileAuthority(admin, first);
      const before = await read();
      await prepareMiniappProfileAuthority(admin, first);
      assert.deepEqual(await read(), before);
      await prepareMiniappProfileAuthority(admin, next);
      const after = await read();
      assert.notEqual(after.revision, before.revision);
      assert.notDeepEqual(after.hmac_key, before.hmac_key);
      const expected = deriveMiniappProfileAuthorityKey(next);
      try {
        assert.deepEqual(after.hmac_key, expected);
      } finally {
        expected.fill(0);
      }
      for (const sql of [
        "SELECT * FROM miniapp_profile_authority",
        "DELETE FROM miniapp_profile_authority",
      ])
        await assert.rejects(app.query(sql), (error: unknown) => {
          assert.equal(Reflect.get(Object(error), "code"), "42501");
          return true;
        });
      await assert.rejects(
        prepareMiniappProfileAuthority(app, first),
        /RUNTIME_MINIAPP_AUTHORITY_FAILED/u,
      );
      assert.deepEqual(await read(), after);
    } finally {
      await Promise.allSettled([admin.end(), app.end()]);
    }
  },
);
