import type { FastifyReply } from "fastify";
import { z } from "zod";

import { AiGatewayEventSchema, type AiGatewayEvent } from "./gateway.js";

const AiSseEnvelopeSchema = z.object({ ok: z.literal(true), data: AiGatewayEventSchema }).strict();

function serializeEvent(event: AiGatewayEvent): string {
  return JSON.stringify(AiSseEnvelopeSchema.parse({ ok: true, data: event }));
}

/** SSE is a sequence of the normal `{ok,data}` envelope; no unvalidated chunks are emitted. */
export async function writeAiEventStream(
  reply: FastifyReply,
  events: AsyncIterable<AiGatewayEvent>,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  for await (const event of events) {
    reply.raw.write(`event: message\ndata: ${serializeEvent(event)}\n\n`);
  }
  reply.raw.end();
}
