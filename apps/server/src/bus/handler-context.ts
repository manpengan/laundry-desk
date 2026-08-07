import type { SqlClient } from "../db/types.js";
import type { BusContext, HandlerContext } from "./types.js";

export function bindTransactionClient(context: BusContext, client: SqlClient): BusContext {
  return Object.freeze({ ...context, transactionClient: client });
}

export function createHandlerContext(
  client: SqlClient,
  context: BusContext,
  parsed: unknown,
): HandlerContext {
  const authority = context.confirmAuthorization?.authority;
  return Object.freeze({
    client,
    tenant: context.tenant,
    actor: context.actor,
    request: context.request,
    parsed,
    ...(authority === undefined ? {} : { confirmationAuthority: authority }),
  });
}
