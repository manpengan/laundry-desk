const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const postgresIntegerMax = 2_147_483_647;

export function validatePromotion(input) {
  for (const field of ["org_id", "store_id", "device_id"]) {
    if (!uuidPattern.test(input[field]))
      throw new Error(`${field} must be a UUID`);
  }
  if (
    !Number.isSafeInteger(input.ttl_ms) ||
    input.ttl_ms <= 0 ||
    input.ttl_ms > postgresIntegerMax
  ) {
    throw new Error("ttl_ms must fit a positive PostgreSQL integer");
  }
  if (
    !Number.isSafeInteger(input.max_clock_skew_ms) ||
    input.max_clock_skew_ms < 0 ||
    input.max_clock_skew_ms > postgresIntegerMax
  ) {
    throw new Error(
      "max_clock_skew_ms must fit a non-negative PostgreSQL integer",
    );
  }
}

export function validateRelease(input) {
  for (const field of ["org_id", "store_id"]) {
    if (!uuidPattern.test(input?.[field]))
      throw new Error(`${field} must be a UUID`);
  }
  const ack = input?.ack;
  for (const field of ["lease_id", "device_id"]) {
    if (!uuidPattern.test(ack?.[field]))
      throw new Error(`ack.${field} must be a UUID`);
  }
  if (!Number.isSafeInteger(ack.primary_epoch) || ack.primary_epoch <= 0) {
    throw new Error("ack.primary_epoch must be a positive safe integer");
  }
  if (typeof ack.nonce !== "string" || ack.nonce.length === 0) {
    throw new Error("ack.nonce is required");
  }
  if (typeof ack.sig !== "string" || ack.sig.length === 0) {
    throw new Error("ack.sig is required");
  }
}

export function validateReplay(command) {
  for (const field of ["org_id", "store_id", "lease_id"]) {
    if (!uuidPattern.test(command[field]))
      throw new Error(`${field} must be a UUID`);
  }
  if (
    !Number.isSafeInteger(command.primary_epoch) ||
    command.primary_epoch <= 0
  ) {
    throw new Error("primary_epoch must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(command.per_lease_seq) ||
    command.per_lease_seq <= 0
  ) {
    throw new Error("per_lease_seq must be a positive safe integer");
  }
  if (
    typeof command.command_name !== "string" ||
    command.command_name.length === 0
  ) {
    throw new Error("command_name is required");
  }
}
