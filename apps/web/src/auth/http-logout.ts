const CSRF_HEADER_NAME = "x-csrf-token";

export type HttpLogoutOptions = Readonly<{
  apiBaseUrl: string;
  fetchImpl: typeof fetch;
  readCsrf: () => string | null;
}>;

/** Best-effort server revocation; callers must clear local authority before awaiting it. */
export async function requestHttpLogout(options: HttpLogoutOptions): Promise<void> {
  try {
    const { fetchImpl, readCsrf } = options;
    const csrf = readCsrf();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (csrf !== null) headers[CSRF_HEADER_NAME] = csrf;
    await fetchImpl(`${options.apiBaseUrl}/api/v2/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers,
      body: "{}",
    });
  } catch {
    // Local credentials are already gone; transport failure cannot restore authority.
  }
}
