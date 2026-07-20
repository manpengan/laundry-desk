import { withTransaction } from "./db.mjs";
import { validateReplay } from "./validation.mjs";

async function lockReplayHead(client, command) {
  const result = await client.query(
    `SELECT current_epoch, current_lease_id
     FROM primary_lease_heads
     WHERE org_id = $1 AND store_id = $2
     FOR UPDATE`,
    [command.org_id, command.store_id],
  );
  if (result.rowCount !== 1) throw new Error("primary lease head is missing");
  return result.rows[0];
}

async function findExactPriorAudit(client, command) {
  const result = await client.query(
    `SELECT decision, reason FROM offline_command_audit
     WHERE org_id = $1 AND store_id = $2 AND lease_id = $3
       AND primary_epoch = $4 AND per_lease_seq = $5 AND command_name = $6`,
    [
      command.org_id,
      command.store_id,
      command.lease_id,
      command.primary_epoch,
      command.per_lease_seq,
      command.command_name,
    ],
  );
  return result.rows[0];
}

async function hasSequenceCollision(client, command) {
  const result = await client.query(
    `SELECT 1 FROM offline_command_audit
     WHERE org_id = $1 AND store_id = $2 AND lease_id = $3
       AND per_lease_seq = $4 LIMIT 1`,
    [command.org_id, command.store_id, command.lease_id, command.per_lease_seq],
  );
  return result.rowCount > 0;
}

async function loadLease(client, command) {
  const result = await client.query(
    `SELECT released_at FROM primary_leases
     WHERE org_id = $1 AND store_id = $2 AND lease_id = $3
       AND primary_epoch = $4`,
    [command.org_id, command.store_id, command.lease_id, command.primary_epoch],
  );
  return result.rows[0];
}

async function lockReplayState(client, command) {
  await client.query(
    `INSERT INTO primary_lease_replay_state (org_id, store_id, lease_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [command.org_id, command.store_id, command.lease_id],
  );
  const result = await client.query(
    `SELECT last_seq FROM primary_lease_replay_state
     WHERE org_id = $1 AND store_id = $2 AND lease_id = $3
     FOR UPDATE`,
    [command.org_id, command.store_id, command.lease_id],
  );
  return result.rows[0];
}

function replayDecision(head, lease, state, command) {
  const current =
    Number(head.current_epoch) === command.primary_epoch &&
    head.current_lease_id === command.lease_id;
  if (!lease)
    return Object.freeze({ decision: "arbitrate", reason: "unknown-lease" });
  if (!current)
    return Object.freeze({ decision: "arbitrate", reason: "stale-epoch" });
  if (lease.released_at)
    return Object.freeze({ decision: "arbitrate", reason: "released-lease" });
  if (command.per_lease_seq !== Number(state.last_seq) + 1) {
    return Object.freeze({ decision: "arbitrate", reason: "out-of-order" });
  }
  return Object.freeze({ decision: "apply", reason: "current-sequence" });
}

async function advanceSequence(client, command, state) {
  if (command.per_lease_seq !== Number(state.last_seq) + 1) return;
  await client.query(
    `UPDATE primary_lease_replay_state SET last_seq = $4
     WHERE org_id = $1 AND store_id = $2 AND lease_id = $3`,
    [command.org_id, command.store_id, command.lease_id, command.per_lease_seq],
  );
}

async function recordAudit(client, command, outcome) {
  await client.query(
    `INSERT INTO offline_command_audit (
       org_id, store_id, lease_id, primary_epoch, per_lease_seq,
       command_name, decision, reason, arbitration_required
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      command.org_id,
      command.store_id,
      command.lease_id,
      command.primary_epoch,
      command.per_lease_seq,
      command.command_name,
      outcome.decision,
      outcome.reason,
      outcome.decision === "arbitrate",
    ],
  );
}

export function replayOfflineCommand(pool, command, applyDomain) {
  validateReplay(command);
  return withTransaction(pool, async (client) => {
    const head = await lockReplayHead(client, command);
    const prior = await findExactPriorAudit(client, command);
    if (prior) {
      return Object.freeze({
        decision: prior.decision,
        applied: false,
        duplicate: true,
        reason: prior.reason,
      });
    }

    if (await hasSequenceCollision(client, command)) {
      const collision = Object.freeze({
        decision: "arbitrate",
        reason: "sequence-collision",
      });
      await recordAudit(client, command, collision);
      return Object.freeze({
        ...collision,
        applied: false,
        duplicate: false,
      });
    }

    const [lease, state] = await Promise.all([
      loadLease(client, command),
      lockReplayState(client, command),
    ]);
    const outcome = replayDecision(head, lease, state, command);
    await advanceSequence(client, command, state);
    await recordAudit(client, command, outcome);
    if (outcome.decision === "apply") await applyDomain(client);
    return Object.freeze({
      ...outcome,
      applied: outcome.decision === "apply",
      duplicate: false,
    });
  });
}
