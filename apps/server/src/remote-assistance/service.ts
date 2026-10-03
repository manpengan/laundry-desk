import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { RemoteAssistanceStatusSchema, type RemoteAssistanceStatus } from "@laundry/contracts";
import type { AuthorizedSession } from "../auth/session-view.js";
import type { AssistanceRepository, AssistanceGrant } from "./repository.js";
import { verifySupportCommand, supportOperatorHash, type AssistanceTrust } from "./protocol.js";
import type { AssistanceTransport } from "./transport.js";

const commands = ["runtime.health", "runtime.version", "maintenance.summary"] as const;
const storeKey = (auth: AuthorizedSession) => `${auth.session.org_id}:${auth.session.store_id}`;
type Running = Readonly<{
  grant: AssistanceGrant;
  abort: AbortController;
  monotonicDeadline: number;
  timer: ReturnType<typeof setTimeout>;
  task: Promise<void>;
}>;
export function createAssistanceService(
  options: Readonly<{
    repository: AssistanceRepository;
    trust: AssistanceTrust | null;
    transport: AssistanceTransport | null;
    reportFailure: () => void;
    now?: () => number;
    monotonic?: () => number;
    wait?: (signal: AbortSignal) => Promise<void>;
  }>,
) {
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const wait =
    options.wait ??
    (async (signal) => {
      await delay(5000, undefined, { signal, ref: false });
    });
  const active = new Map<string, Running>();
  let closed = false;
  let serial = Promise.resolve();
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = serial.then(operation, operation);
    serial = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const configured = options.trust !== null && options.transport !== null;
  const status = async (auth: AuthorizedSession): Promise<RemoteAssistanceStatus> => {
    const current = active.get(storeKey(auth));
    const row = await options.repository.status(auth, current?.grant.id ?? null);
    const state = !configured
      ? "unconfigured"
      : !row
        ? "idle"
        : row.status !== "active"
          ? row.status
          : row.expires_at.getTime() <= now()
            ? "expired"
            : current?.grant.id === row.id
              ? "active"
              : "interrupted";
    return RemoteAssistanceStatusSchema.parse({
      configured,
      state,
      session_id: row?.id ?? null,
      expires_at: row?.expires_at.getTime() ?? null,
      commands_completed: row?.commands_completed ?? 0,
      allowed_commands: commands,
    });
  };
  const assertLive = (run: Running) => {
    if (
      run.abort.signal.aborted ||
      closed ||
      now() >= run.grant.expiresAt ||
      monotonic() >= run.monotonicDeadline
    )
      throw new Error("ASSISTANCE_SESSION_ENDED");
  };
  const loop = async (run: Running) => {
    let count = 0;
    try {
      while (count < 1000) {
        assertLive(run);
        await options.repository.verify(run.grant);
        const nonce = randomBytes(32).toString("base64url");
        const token = await options.transport!.poll(run.grant.id, nonce, run.abort.signal);
        assertLive(run);
        if (token !== null) {
          const command = verifySupportCommand(token, options.trust!, {
            sessionId: run.grant.id,
            nonce,
            now: now(),
          });
          const result = await options.repository.execute(
            run.grant,
            command.jti,
            command.command,
            supportOperatorHash(command),
          );
          count += 1;
          assertLive(run);
          await options.repository.verify(run.grant);
          assertLive(run);
          if (command.exp * 1000 <= now()) throw new Error("ASSISTANCE_PROOF_EXPIRED");
          await options.transport!.deliver(run.grant.id, command.jti, result, run.abort.signal);
          await options.repository.delivered(run.grant, command.jti);
        }
        await wait(run.abort.signal);
      }
    } catch {
      if (!run.abort.signal.aborted) options.reportFailure();
    } finally {
      run.abort.abort();
      clearTimeout(run.timer);
      if (active.get(storeKey(run.grant.auth)) === run) active.delete(storeKey(run.grant.auth));
      try {
        await options.repository.terminate(
          run.grant,
          now() >= run.grant.expiresAt || monotonic() >= run.monotonicDeadline
            ? "expired"
            : "interrupted",
        );
      } catch {
        options.reportFailure();
      }
    }
  };
  return Object.freeze({
    status: (auth: AuthorizedSession) => exclusive(() => status(auth)),
    async authorize(auth: AuthorizedSession) {
      return exclusive(async () => {
        if (closed || !configured) throw new Error("ASSISTANCE_UNCONFIGURED");
        const previous = active.get(storeKey(auth));
        if (previous) {
          previous.abort.abort();
          await previous.task;
        }
        const approvedAt = now();
        const grant = { id: randomUUID(), auth, approvedAt, expiresAt: approvedAt + 3600_000 };
        await options.repository.approve(grant);
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 3600_000);
        timer.unref();
        // Schedule the worker after its immutable record is registered. No DB
        // row alone can activate an outbound worker, including after restart.
        const run: Running = {
          grant,
          abort,
          timer,
          monotonicDeadline: monotonic() + 3600_000,
          task: Promise.resolve().then(() => loop(run)),
        };
        active.set(storeKey(auth), run);
        return status(auth);
      });
    },
    async revoke(auth: AuthorizedSession, id: string) {
      const current = active.get(storeKey(auth));
      if (current?.grant.id === id) current.abort.abort();
      await options.repository.revoke(auth, id);
      if (current?.grant.id === id) await current.task;
      return status(auth);
    },
    async close() {
      closed = true;
      await serial;
      const runs = [...active.values()];
      for (const run of runs) run.abort.abort();
      await Promise.all(runs.map((run) => run.task));
    },
  });
}
export type AssistanceService = ReturnType<typeof createAssistanceService>;
