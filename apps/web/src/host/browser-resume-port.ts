import type { AuthPort } from "../auth/AuthClient.js";
import type { ResumePort } from "./desktop-resume-port.js";

/**
 * Restore a browser session from the rotated refresh/CSRF cookie pair.
 * The access token remains inside the browser host credential closure.
 */
export function createBrowserResumePort(auth: Pick<AuthPort, "refreshSession">): ResumePort {
  return Object.freeze({
    async resume() {
      const result = await auth.refreshSession();
      return result.ok
        ? Object.freeze({ ok: true as const, session: result.data, mode: "online" as const })
        : Object.freeze({ ok: false as const });
    },
  });
}
