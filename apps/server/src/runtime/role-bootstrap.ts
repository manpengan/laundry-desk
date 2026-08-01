export type RuntimeRoleClient = Readonly<{
  query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

type PasswordStatement = Readonly<{ statement: string }>;

export async function applyRuntimeRoles(
  client: RuntimeRoleClient,
  appPassword: string,
): Promise<void> {
  if (appPassword.length < 32 || /[\0\r\n]/u.test(appPassword)) {
    throw new Error("RUNTIME_ROLE_PASSWORD_INVALID");
  }
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock($1, $2)", [1279345987, 20260801]);
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'laundry_owner') THEN
        CREATE ROLE laundry_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF;
    END $$`);
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'laundry_app') THEN
        CREATE ROLE laundry_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF;
    END $$`);
    await client.query(
      "ALTER ROLE laundry_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    const formatted = await client.query(
      `SELECT pg_catalog.format(
        'ALTER ROLE laundry_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
        $1::text
      ) AS statement`,
      [appPassword],
    );
    const statement = (formatted.rows[0] as PasswordStatement | undefined)?.statement;
    if (typeof statement !== "string" || !statement.startsWith("ALTER ROLE laundry_app ")) {
      throw new Error("RUNTIME_ROLE_FORMAT_INVALID");
    }
    await client.query(statement);
    await client.query("ALTER DATABASE laundry_v2 OWNER TO laundry_owner");
    await client.query("GRANT CONNECT ON DATABASE laundry_v2 TO laundry_app");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
