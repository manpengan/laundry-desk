import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  AssistanceTrustSchema,
  verifySupportCommand,
} from "../../apps/server/dist/remote-assistance/protocol.js";
import { assistanceBrokerOrigin } from "../../apps/server/dist/remote-assistance/transport.js";
import {
  createPinnedProviderHttp,
  readProviderJson,
} from "../../apps/server/dist/ai/provider-http.js";
const { z } = createRequire(new URL("../../apps/server/package.json", import.meta.url))("zod");

const publicTrust = AssistanceTrustSchema.omit({ broker_token: true });
const base = {
  trust: publicTrust,
  operator_access_token: z.string().regex(/^[A-Za-z0-9._~-]{16,8192}$/u),
  session_id: z.uuid(),
};
const Input = z.discriminatedUnion("operation", [
  z.strictObject({ ...base, operation: z.literal("challenge") }),
  z.strictObject({
    ...base,
    operation: z.literal("submit"),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    proof: z.string().max(8192),
  }),
  z.strictObject({
    ...base,
    operation: z.literal("result"),
    request_id: z.uuid(),
    command: z.enum(["runtime.health", "runtime.version", "maintenance.summary"]),
  }),
]);

/** The identity provider supplies the signed proof. This client never asserts MFA or signs identities. */
export async function supportOperation(raw, http, now = Date.now()) {
  const input = Input.parse(raw);
  const origin = assistanceBrokerOrigin(input.trust.broker_url);
  const transport = http ?? createPinnedProviderHttp([new URL(origin).hostname]);
  let command;
  if (input.operation === "submit")
    command = verifySupportCommand(
      input.proof,
      { ...input.trust, broker_token: "unused-verification-only-placeholder" },
      { sessionId: input.session_id, nonce: input.nonce, now },
    );
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("SUPPORT_TIMEOUT"));
    }, 10000);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await transport.request({
          url: `${origin}/v1/support/${input.operation}`,
          method: "POST",
          signal: controller.signal,
          timeoutMs: 10000,
          headers: {
            authorization: `Bearer ${input.operator_access_token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            input.operation === "challenge"
              ? { session_id: input.session_id }
              : input.operation === "submit"
                ? { session_id: input.session_id, proof: input.proof }
                : { session_id: input.session_id, request_id: input.request_id },
          ),
        });
        const result = await readProviderJson(response, 16384);
        if (input.operation === "challenge")
          return z
            .strictObject({
              session_id: z.literal(input.session_id),
              nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
              expires_at: z.number().int().positive(),
            })
            .parse(result);
        if (input.operation === "result") {
          const data = {
            "runtime.health": z.strictObject({
              database: z.literal("ready"),
              mode: z.literal("windows_local"),
            }),
            "runtime.version": z.strictObject({
              protocol: z.literal(1),
              release: z
                .string()
                .max(128)
                .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
              schema_head: z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/u),
            }),
            "maintenance.summary": z.strictObject({
              window_days: z.literal(30),
              restore_events: z.number().int().nonnegative().max(2147483647),
            }),
          }[input.command];
          return z
            .discriminatedUnion("ready", [
              z.strictObject({ ready: z.literal(false), request_id: z.literal(input.request_id) }),
              z.strictObject({
                ready: z.literal(true),
                request_id: z.literal(input.request_id),
                command: z.literal(input.command),
                result: data,
              }),
            ])
            .parse(result);
        }
        return z
          .strictObject({ accepted: z.literal(true), request_id: z.literal(command.jti) })
          .parse(result);
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
async function main() {
  const chunks = [];
  let length = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error("INPUT_TIMEOUT")), 10000);
  let bytes;
  try {
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 16384) throw new Error("INPUT_TOO_LARGE");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
    const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    process.stdout.write(`${JSON.stringify(await supportOperation(input))}\n`);
  } finally {
    clearTimeout(timer);
    bytes?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(() => {
    process.stderr.write("SUPPORT_OPERATION_FAILED\n");
    process.exitCode = 1;
  });
