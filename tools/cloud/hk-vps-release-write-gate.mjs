import { fail } from "./hk-vps-release-core.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";

const APP_ROLE = "laundry_app";
const WRITE_GATE_STATES = new Set([null, "intent", "active", "released"]);
const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});

export const INSPECT_WRITE_GATE_SQL = `SELECT CASE WHEN rolcanlogin THEN 't' ELSE 'f' END || E'\\t' ||
       CASE WHEN rolsuper THEN 't' ELSE 'f' END || E'\\t' ||
       CASE WHEN rolbypassrls THEN 't' ELSE 'f' END
  FROM pg_catalog.pg_roles WHERE rolname = '${APP_ROLE}'`;

export const ACTIVATE_WRITE_GATE_SQL = `DO $write_gate$
DECLARE app_role record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolbypassrls INTO app_role
    FROM pg_catalog.pg_roles WHERE rolname = '${APP_ROLE}';
  IF NOT FOUND OR app_role.rolsuper OR app_role.rolbypassrls THEN
    RAISE EXCEPTION 'invalid application role';
  END IF;
  EXECUTE 'ALTER ROLE ${APP_ROLE} NOLOGIN';
END
$write_gate$;
WITH targets AS MATERIALIZED (
  SELECT pid FROM pg_catalog.pg_stat_activity
   WHERE datname = current_database() AND usename = '${APP_ROLE}'
     AND pid <> pg_catalog.pg_backend_pid()
), stopped AS MATERIALIZED (
  SELECT pid, pg_catalog.pg_terminate_backend(pid, 5000) AS terminated FROM targets
), summary AS MATERIALIZED (
  SELECT count(*)::integer AS targeted,
         count(*) FILTER (WHERE terminated)::integer AS terminated FROM stopped
)
SELECT targeted || E'\\t' || terminated FROM summary;
`;

export const VERIFY_WRITE_GATE_SQL = `SELECT (SELECT count(*) FROM pg_catalog.pg_stat_activity
         WHERE datname = current_database() AND usename = '${APP_ROLE}'
           AND pid <> pg_catalog.pg_backend_pid()) || E'\\t' ||
       CASE WHEN role.rolcanlogin THEN 't' ELSE 'f' END || E'\\t' ||
       CASE WHEN role.rolsuper THEN 't' ELSE 'f' END || E'\\t' ||
       CASE WHEN role.rolbypassrls THEN 't' ELSE 'f' END
  FROM pg_catalog.pg_roles role WHERE role.rolname = '${APP_ROLE}'`;

export const RELEASE_WRITE_GATE_SQL = `DO $write_gate$
DECLARE app_role record;
BEGIN
  SELECT rolcanlogin, rolsuper, rolbypassrls INTO app_role
    FROM pg_catalog.pg_roles WHERE rolname = '${APP_ROLE}';
  IF NOT FOUND OR app_role.rolsuper OR app_role.rolbypassrls THEN
    RAISE EXCEPTION 'invalid application role';
  END IF;
  EXECUTE 'ALTER ROLE ${APP_ROLE} LOGIN';
END
$write_gate$;
SELECT CASE WHEN rolcanlogin THEN 't' ELSE 'f' END || E'\\t' ||
       CASE WHEN rolsuper THEN 't' ELSE 'f' END || E'\\t' ||
       CASE WHEN rolbypassrls THEN 't' ELSE 'f' END
  FROM pg_catalog.pg_roles WHERE rolname = '${APP_ROLE}'`;

export function isTransitionWriteGateStateValid(record) {
  const state = record.write_gate_state;
  if (
    !WRITE_GATE_STATES.has(state) ||
    (state === null) !== (record.app_role_original_can_login === null) ||
    (state !== null && record.app_role_original_can_login !== true)
  ) {
    return false;
  }
  if (record.outcome === "committed") return state === "released";
  if (record.outcome === "rolled_back") return [null, "released"].includes(state);
  if (["write_frozen", "recovery_ready", "migrating"].includes(record.phase)) {
    return state === "active";
  }
  if (record.phase === "switched" && !["active", "released"].includes(state)) return false;
  if (record.phase === "awaiting_external_verification" && state !== "released") return false;
  return true;
}

function commandOptions(label, signal) {
  return Object.freeze({
    cwd: "/",
    environment: COMMAND_ENVIRONMENT,
    label,
    signal,
    timeoutMs: 2 * 60_000,
  });
}

function psqlArguments(sql) {
  return [
    "--no-psqlrc",
    "--quiet",
    "--set=ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "--dbname",
    "laundry_v2",
    "--command",
    sql,
  ];
}

async function executeSql(sql, label, signal, dependencies) {
  const run = dependencies.runCloudCommand ?? runCloudCommand;
  return await run(
    "/usr/bin/sudo",
    ["-u", "postgres", "--", "/usr/bin/psql", ...psqlArguments(sql)],
    commandOptions(label, signal),
  );
}

export function parseWriteGateRole(source, expectedCanLogin) {
  const match = /^(t|f)\t(t|f)\t(t|f)\n?$/u.exec(source);
  const canLogin = match?.[1] === "t";
  const superuser = match?.[2] === "t";
  const bypassRls = match?.[3] === "t";
  if (match === null || canLogin !== expectedCanLogin || superuser || bypassRls) {
    fail("CLOUD_RELEASE_WRITE_GATE_ROLE_INVALID");
  }
  return Object.freeze({ bypassRls, canLogin, superuser });
}

export function parseWriteGateActivation(activationSource, verificationSource) {
  const activation = /^(\d+)\t(\d+)\n?$/u.exec(activationSource);
  const verification = /^(\d+)\t(f)\t(f)\t(f)\n?$/u.exec(verificationSource);
  if (activation === null || verification === null) {
    fail("CLOUD_RELEASE_WRITE_GATE_ACTIVATION_INVALID");
  }
  const [targeted, terminated, remaining] = [
    Number(activation[1]),
    Number(activation[2]),
    Number(verification[1]),
  ];
  if (
    ![targeted, terminated, remaining].every(Number.isSafeInteger) ||
    targeted !== terminated ||
    remaining !== 0
  ) {
    fail("CLOUD_RELEASE_WRITE_GATE_ACTIVATION_INVALID");
  }
  return Object.freeze({ terminatedSessions: terminated });
}

export async function inspectDatabaseWriteGate(signal, dependencies = {}) {
  const result = await executeSql(
    INSPECT_WRITE_GATE_SQL,
    "CLOUD_RELEASE_WRITE_GATE_INSPECT",
    signal,
    dependencies,
  );
  return parseWriteGateRole(result.stdout, true);
}

export async function activateDatabaseWriteGate(signal, dependencies = {}) {
  const activation = await executeSql(
    ACTIVATE_WRITE_GATE_SQL,
    "CLOUD_RELEASE_WRITE_GATE_ACTIVATE",
    signal,
    dependencies,
  );
  const verification = await executeSql(
    VERIFY_WRITE_GATE_SQL,
    "CLOUD_RELEASE_WRITE_GATE_VERIFY",
    signal,
    dependencies,
  );
  return parseWriteGateActivation(activation.stdout, verification.stdout);
}

export async function releaseDatabaseWriteGate(signal, dependencies = {}) {
  const result = await executeSql(
    RELEASE_WRITE_GATE_SQL,
    "CLOUD_RELEASE_WRITE_GATE_RELEASE",
    signal,
    dependencies,
  );
  return parseWriteGateRole(result.stdout, true);
}
