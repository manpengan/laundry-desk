import type { EdgeAuthorityData } from "@laundry/contracts";

export type VerifiedOfflineReadAuthority = Readonly<{
  serverPublicKeySpki: string;
  offlineGrant: EdgeAuthorityData["offline_grant"];
}>;
