/**
 * Server-owned replay window. Edge currently writes queue envelope v2 and contracts major 0.
 * Lower queue versions are below the security floor; future versions require a newer server.
 */
export const SERVER_EDGE_REPLAY_COMPATIBILITY_POLICY = Object.freeze({
  minimum_secure_queue_version: 2,
  current_queue_version: 2,
  current_contracts_major: 0,
});
