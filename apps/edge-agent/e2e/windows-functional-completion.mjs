/**
 * Publish a passing receipt only after required private-material cleanup succeeds.
 * @param {() => Promise<void>} cleanup
 * @param {() => void | Promise<void>} publish
 * @returns {Promise<void>}
 */
export async function completeFunctionalEvidence(cleanup, publish) {
  await cleanup();
  await publish();
}
