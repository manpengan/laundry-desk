import { HK_VPS_CLOUD_TEST as PROFILE } from "./cloud-environment-profile.mjs";
import { ENV_FILE } from "./hk-vps-release-remote-support.mjs";

export const MIGRATION_SCRIPT = `set -euo pipefail; umask 077
root="$1"; env_file="${ENV_FILE}"
test -f "$env_file" && test ! -L "$env_file"
test "$(stat -c '%U:%G:%a' "$env_file")" = "root:root:600"
. "$env_file"
: "\${POSTGRES_PASSWORD:?CLOUD_RELEASE_POSTGRES_PASSWORD_MISSING}"
postgres_password="$POSTGRES_PASSWORD"
unset POSTGRES_PASSWORD
exec /usr/bin/env -i LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=${PROFILE.paths.postgresDataRoot} TMPDIR=/tmp PGHOST=${PROFILE.services.postgresHost} PGPORT=${PROFILE.services.postgresPort} PGDATABASE=${PROFILE.services.postgresDatabase} \
  POSTGRES_USER=postgres POSTGRES_PASSWORD="$postgres_password" \
  "$root/tools/compose/migrate-v2.sh"`;
