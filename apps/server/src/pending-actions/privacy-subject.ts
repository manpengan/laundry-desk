const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Keep a non-PII relation to the customer whose command body may need erasure.
 * Only canonical parsed command objects are inspected; arbitrary nested values
 * never become database identifiers.
 */
export function customerPrivacySubjectFromCommand(command: string, parsed: unknown): string | null {
  if (
    !command.startsWith("customer.") &&
    !command.startsWith("delivery.appointment.") &&
    !command.startsWith("delivery.order.")
  ) {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const candidate = (parsed as Readonly<Record<string, unknown>>).customer_id;
  return typeof candidate === "string" && UUID_PATTERN.test(candidate) ? candidate : null;
}
