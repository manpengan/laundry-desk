const MINIMUM_LAN_PORT = 1024;
const MAXIMUM_PORT = 65_535;

function isPrivateLanIpv4(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(value);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

/** Refuse to aim credential-bearing LAN acceptance at a public or default-port host. */
export function requirePrivateLanHttpsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("LAUNDRY_LAN_ORIGIN must be an exact private HTTPS origin");
  }
  const port = Number(parsed.port);
  if (
    value.length === 0 ||
    value.trim() !== value ||
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !isPrivateLanIpv4(parsed.hostname) ||
    !Number.isSafeInteger(port) ||
    port < MINIMUM_LAN_PORT ||
    port > MAXIMUM_PORT
  ) {
    throw new Error("LAUNDRY_LAN_ORIGIN must be an exact private HTTPS origin");
  }
  return value;
}
