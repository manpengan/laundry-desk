export const DESKTOP_API_BASE_URL = "http://127.0.0.1:8787" as const;
export const DESKTOP_REQUEST_ORIGIN = DESKTOP_API_BASE_URL;

export type DesktopHttpRequest = Readonly<{
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  credentials: "include";
  redirect: "error";
  origin: typeof DESKTOP_REQUEST_ORIGIN;
  body?: string | Uint8Array;
}>;

export type DesktopRequestOptions = Readonly<{
  body?: Readonly<Record<string, unknown>> | Uint8Array;
  contentType?: string;
  accessToken?: string;
  csrfToken?: string;
}>;

export function createDesktopRequest(
  method: "GET" | "POST",
  path: string,
  options: DesktopRequestOptions = {},
): DesktopHttpRequest {
  const target = new URL(path, `${DESKTOP_API_BASE_URL}/`);
  if (target.origin !== DESKTOP_API_BASE_URL || !path.startsWith("/")) {
    throw new TypeError("Desktop HTTP route escaped the fixed loopback origin");
  }
  const headers = Object.freeze({
    Origin: DESKTOP_REQUEST_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    ...(options.body === undefined
      ? {}
      : { "Content-Type": options.contentType ?? "application/json" }),
    ...(options.accessToken === undefined
      ? {}
      : { Authorization: `Bearer ${options.accessToken}` }),
    ...(options.csrfToken === undefined ? {} : { "X-CSRF-Token": options.csrfToken }),
  });
  if (Object.keys(headers).some((name) => /^x-forwarded-/iu.test(name))) {
    throw new TypeError("Forwarded headers are forbidden on the desktop transport");
  }
  const body =
    options.body === undefined
      ? undefined
      : options.body instanceof Uint8Array
        ? Uint8Array.from(options.body)
        : JSON.stringify(options.body);
  return Object.freeze({
    method,
    url: target.href,
    headers,
    credentials: "include",
    redirect: "error",
    origin: DESKTOP_REQUEST_ORIGIN,
    ...(body === undefined ? {} : { body }),
  });
}
