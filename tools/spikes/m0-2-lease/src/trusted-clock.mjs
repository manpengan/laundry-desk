export const databaseTrustedClock = Object.freeze({
  async now(client) {
    const result = await client.query(
      "SELECT clock_timestamp() AS trusted_now",
    );
    return result.rows[0].trusted_now;
  },
});
