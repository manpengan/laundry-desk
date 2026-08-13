import { isIP } from "node:net";

import { z } from "zod";

const HOST_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);

const INJECTION_PATTERNS = Object.freeze([
  /ignore (?:all |any )?(?:previous|prior|above) instructions/iu,
  /(?:reveal|print|return|dump).{0,32}(?:system|developer) prompt/iu,
  /(?:bypass|disable|override).{0,32}(?:policy|guard|permission|safety)/iu,
  /(?:call|invoke|execute).{0,32}(?:refund|shell|sql|http|tool)/iu,
  /(?:exfiltrate|steal|reveal).{0,32}(?:secret|token|password|api.?key)/iu,
  /(?:忽略|无视|覆盖).{0,16}(?:之前|以上|系统|开发者).{0,16}(?:指令|提示词|规则)/u,
  /(?:泄露|显示|输出).{0,16}(?:系统提示词|密钥|令牌|密码)/u,
  /(?:执行|调用).{0,16}(?:退款|命令行|SQL|任意网址|未授权工具)/iu,
  /<\/?(?:system|developer|tool|assistant)>/iu,
]);

const PII_RULES: readonly Readonly<{ pattern: RegExp; replacement: string }>[] = Object.freeze([
  Object.freeze({
    pattern: /\b1[3-9]\d{9}\b/gu,
    replacement: "[PHONE_REDACTED]",
  }),
  Object.freeze({
    pattern: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx]\b/gu,
    replacement: "[ID_REDACTED]",
  }),
  Object.freeze({
    pattern: /\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,190}\.[A-Z]{2,63}\b/giu,
    replacement: "[EMAIL_REDACTED]",
  }),
  Object.freeze({
    pattern: /\b(?:\d[ -]?){15,19}\b/gu,
    replacement: "[ACCOUNT_REDACTED]",
  }),
  Object.freeze({
    pattern: /\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{12,8000}\b/giu,
    replacement: "[SECRET_REDACTED]",
  }),
  Object.freeze({
    pattern:
      /\b(?:api[_ -]?key|authorization|token|secret)\s*[:=]\s*(?:bearer\s+)?[A-Za-z0-9._~+/=-]{8,8000}\b/giu,
    replacement: "[SECRET_REDACTED]",
  }),
  Object.freeze({
    pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,8000}\b/giu,
    replacement: "[SECRET_REDACTED]",
  }),
]);

export type AiTextRedaction = Readonly<{
  text: string;
  redactionCount: number;
}>;

export function redactAiText(value: string): AiTextRedaction {
  let text = value;
  let redactionCount = 0;
  for (const rule of PII_RULES) {
    text = text.replace(rule.pattern, () => {
      redactionCount += 1;
      return rule.replacement;
    });
  }
  return Object.freeze({ text, redactionCount });
}

export function detectsPromptInjection(value: string): boolean {
  const bounded = value.slice(0, 8_000);
  return INJECTION_PATTERNS.some((pattern) => pattern.test(bounded));
}

export type AiSafeToolPayload = Readonly<{
  content: string;
  blocked: boolean;
  redactionCount: number;
}>;

export function sanitizeAiToolPayload(value: unknown): AiSafeToolPayload {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    return Object.freeze({
      content: '{"error":"invalid_tool_result"}',
      blocked: true,
      redactionCount: 0,
    });
  }
  if (serialized.length > 8_192) {
    return Object.freeze({
      content: '{"error":"oversized_tool_result"}',
      blocked: true,
      redactionCount: 0,
    });
  }
  const redacted = redactAiText(serialized);
  if (redacted.text.length > 8_192) {
    return Object.freeze({
      content: '{"error":"oversized_tool_result"}',
      blocked: true,
      redactionCount: redacted.redactionCount,
    });
  }
  const blocked = detectsPromptInjection(redacted.text);
  return Object.freeze({
    content: blocked ? '{"error":"unsafe_tool_result"}' : redacted.text,
    blocked,
    redactionCount: redacted.redactionCount,
  });
}

function ipv4Private(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [first = -1, second = -1, third = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

export function isForbiddenAiAddress(address: string): boolean {
  if (address.includes("%")) return true;
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  const version = isIP(normalized);
  if (version === 4) return ipv4Private(normalized);
  if (version !== 6) return true;
  const words = expandIpv6(normalized);
  if (words === null) return true;
  const [first = 0, second = 0] = words;
  if ((first & 0xe000) !== 0x2000) return true;
  return (
    (first === 0x2001 && (second === 0 || second === 2 || second === 0x0db8)) ||
    first === 0x2002 ||
    (first === 0x3fff && (second & 0xf000) === 0)
  );
}

function expandIpv6(address: string): readonly number[] | null {
  let canonical = address;
  if (canonical.includes(".")) {
    const separator = canonical.lastIndexOf(":");
    const tail = canonical.slice(separator + 1);
    if (separator < 0 || isIP(tail) !== 4) return null;
    const octets = tail.split(".").map(Number);
    canonical = `${canonical.slice(0, separator)}:${((octets[0] ?? 0) * 256 + (octets[1] ?? 0)).toString(16)}:${((octets[2] ?? 0) * 256 + (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = canonical.split("::");
  if (halves.length > 2) return null;
  const left = halves[0]?.split(":").filter(Boolean) ?? [];
  const right = halves[1]?.split(":").filter(Boolean) ?? [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((word) =>
    Number.parseInt(word, 16),
  );
  return words.length === 8 && words.every((word) => Number.isInteger(word))
    ? Object.freeze(words)
    : null;
}

export type AiEgressTarget = Readonly<{
  url: string;
  hostname: string;
  addresses: readonly string[];
}>;

/** Validate each initial or redirect hop; callers must connect only to one returned address. */
export async function validateAiEgressUrl(
  rawUrl: string,
  allowedHosts: readonly string[],
  resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<AiEgressTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("AI_EGRESS_URL_REJECTED");
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = new Set(allowedHosts.map((host) => HOST_SCHEMA.parse(host.toLowerCase())));
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    isIP(hostname) !== 0 ||
    !HOST_SCHEMA.safeParse(hostname).success ||
    !allowed.has(hostname)
  ) {
    throw new Error("AI_EGRESS_URL_REJECTED");
  }
  let resolved: readonly string[];
  try {
    resolved = await resolveHost(hostname);
  } catch {
    throw new Error("AI_EGRESS_ADDRESS_REJECTED");
  }
  const addresses = Object.freeze([...resolved]);
  if (addresses.length === 0 || addresses.some(isForbiddenAiAddress)) {
    throw new Error("AI_EGRESS_ADDRESS_REJECTED");
  }
  return Object.freeze({ url: url.toString(), hostname, addresses });
}

export function estimateCostMicros(
  inputTokens: number,
  outputTokens: number,
  inputMicrosPerMillion: number,
  outputMicrosPerMillion: number,
): number {
  if (
    ![inputTokens, outputTokens, inputMicrosPerMillion, outputMicrosPerMillion].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    throw new Error("AI_COST_INPUT_INVALID");
  }
  const numerator =
    BigInt(inputTokens) * BigInt(inputMicrosPerMillion) +
    BigInt(outputTokens) * BigInt(outputMicrosPerMillion);
  const value = (numerator + 999_999n) / 1_000_000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("AI_COST_OVERFLOW");
  return Number(value);
}
