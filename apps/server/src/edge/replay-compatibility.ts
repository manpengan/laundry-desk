/**
 * Server-owned replay window. Edge writes v3; secure legacy v2 Primary envelopes
 * remain readable during the compatibility window. v2 grant lacks durable sequencing.
 */
export const SERVER_EDGE_REPLAY_COMPATIBILITY_POLICY = Object.freeze({
  minimum_secure_queue_version: 2,
  current_queue_version: 3,
  current_contracts_major: 0,
});
