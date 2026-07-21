/**
 * Single config surface for web runtime (E1 skeleton).
 * Real OpenAPI base URL will plug in here — do not scatter server URLs.
 */
export type WebConfig = Readonly<{
  /** API origin or empty for same-origin / mock. */
  apiBaseUrl: string;
}>;

export const webConfig: WebConfig = Object.freeze({
  apiBaseUrl: "",
});
