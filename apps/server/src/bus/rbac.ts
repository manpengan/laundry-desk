import type { ActorContext } from "./types.js";

/** Permission codes declared by `rbac.<code>` metadata invariants. */
export function requiredPermissionsFromInvariants(
  invariants: readonly string[],
): readonly string[] {
  return Object.freeze(
    invariants
      .filter((name) => name.startsWith("rbac."))
      .map((name) => name.slice("rbac.".length))
      .filter((code) => code.length > 0),
  );
}

export function actorPermissionSet(actor: ActorContext): ReadonlySet<string> {
  return new Set(actor.permissions ?? []);
}

export function actorHasInvariantPermissions(
  actor: ActorContext,
  invariants: readonly string[],
): boolean {
  const required = requiredPermissionsFromInvariants(invariants);
  if (required.length === 0) return true;
  const held = actorPermissionSet(actor);
  return required.every((code) => held.has(code));
}
