export type CustomerPortalTabLockCoordinator = Readonly<{
  claim(name: string, owner: string): Promise<boolean>;
  release(name: string, owner: string): void;
}>;

type BrowserLock = Readonly<{ name: string }>;
type BrowserLockManager = Readonly<{
  request(
    name: string,
    options: Readonly<{ ifAvailable: true; mode: "exclusive" }>,
    callback: (lock: BrowserLock | null) => Promise<void>,
  ): Promise<void>;
}>;

type HeldLock = Readonly<{ owner: string; release: () => void }>;

function browserLockManager(): BrowserLockManager | null {
  if (typeof navigator === "undefined") return null;
  const candidate = navigator.locks as BrowserLockManager | undefined;
  return candidate ?? null;
}

export function createCustomerPortalTabLockCoordinator(
  manager: BrowserLockManager | null = browserLockManager(),
): CustomerPortalTabLockCoordinator {
  let held: ReadonlyMap<string, HeldLock> = new Map();

  const claim = async (name: string, owner: string): Promise<boolean> => {
    if (manager === null) return false;
    const existing = held.get(name);
    if (existing !== undefined) return existing.owner === owner;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        void manager
          .request(name, { ifAvailable: true, mode: "exclusive" }, async (lock) => {
            if (lock === null) {
              settle(false);
              return;
            }
            let releaseHold: (() => void) | null = null;
            const hold = new Promise<void>((release) => {
              releaseHold = release;
            });
            held = new Map(held).set(name, {
              owner,
              release: () => releaseHold?.(),
            });
            settle(true);
            await hold;
          })
          .catch(() => settle(false));
      } catch {
        settle(false);
      }
    });
  };

  const release = (name: string, owner: string): void => {
    const existing = held.get(name);
    if (existing === undefined || existing.owner !== owner) return;
    const next = new Map(held);
    next.delete(name);
    held = next;
    existing.release();
  };

  return Object.freeze({ claim, release });
}
