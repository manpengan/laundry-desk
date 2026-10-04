import type { PgPool } from "../../db/pg-pool.js";
import { withPoolClient } from "../../db/pg-sql-client.js";
import { withWorkerTenantTransaction } from "../../db/worker-transaction.js";
import type { TenantContext } from "../../db/types.js";
import { createWindowsDpapiKms } from "../../ai/windows-dpapi-kms.js";
import type { ByokKmsPort } from "../../ai/byok-kms.js";
import { LOCAL_PROFILE } from "../../local/profile.js";
import type { NotificationHandlerDeps } from "../types.js";
import { createPgNotificationStore } from "../pg-store.js";
import { createPgNotificationDeliveryStore } from "../pg-delivery-store.js";
import {
  createNotificationWorkerController,
  type NotificationWorkerController,
} from "../delivery-worker-controller.js";
import { createAliyunSmsClient } from "./aliyun-client.js";
import { createAliyunNotificationProvider, aliyunCapability } from "./aliyun-provider.js";
import {
  readNotificationSettings,
  notificationCredentials,
  type StoredNotificationSettings,
} from "./settings-store.js";
import { reconcileAliyunReceipts } from "./aliyun-receipts.js";

const TENANT: TenantContext = Object.freeze({
  orgId: LOCAL_PROFILE.orgId,
  storeId: LOCAL_PROFILE.storeId,
  staffId: LOCAL_PROFILE.adminStaffId,
});

export async function createWindowsNotificationRuntime(
  pool: PgPool,
  kms: ByokKmsPort = createWindowsDpapiKms(undefined, "notification"),
): Promise<NotificationHandlerDeps> {
  const store = createPgNotificationStore();
  const deliveryStore = createPgNotificationDeliveryStore(pool);
  const read = () =>
    withPoolClient(pool, (client) =>
      withWorkerTenantTransaction(client, TENANT, (transaction) =>
        readNotificationSettings(transaction, TENANT),
      ),
    );
  let snapshot: StoredNotificationSettings | null = null;
  let worker: NotificationWorkerController | null = null;
  let running = false;
  let reloading: Promise<void> = Promise.resolve();
  const reload = (): Promise<void> => {
    const operation = reloading
      .catch(() => undefined)
      .then(async () => {
        await worker?.stop();
        snapshot = await read();
        worker = null;
        if (snapshot === null) return;
        const selected = snapshot;
        const client = createAliyunSmsClient({
          credentials: async () => {
            const current = await read();
            if (current === null || current.credentialId !== selected.credentialId)
              throw new Error("NOTIFICATION_CREDENTIAL_CHANGED");
            return notificationCredentials(kms, TENANT, current);
          },
        });
        let nextReceiptPoll = 0;
        worker = createNotificationWorkerController({
          store: deliveryStore,
          tenant: TENANT,
          workerId: `notification:${process.pid}`,
          batchLimit: 5,
          provider: createAliyunNotificationProvider(selected.settings, client, async () => {
            const current = await read();
            return (
              current !== null &&
              current.settings.enabled &&
              current.settings.version === selected.settings.version
            );
          }),
          afterCycle: async () => {
            if (Date.now() < nextReceiptPoll) return;
            nextReceiptPoll = Date.now() + 60_000;
            await reconcileAliyunReceipts({
              pool,
              tenant: TENANT,
              store: deliveryStore,
              client,
              templateCode: selected.settings.template_code,
            });
          },
        });
        if (running) worker.start();
      });
    reloading = operation;
    return operation;
  };
  await reload();
  return Object.freeze({
    store,
    delivery: Object.freeze({
      store: deliveryStore,
      tenantScope: TENANT,
      get capability() {
        return aliyunCapability(snapshot?.settings ?? null);
      },
    }),
    externalSettings: Object.freeze({ kms, reload, tenant: TENANT }),
    worker: Object.freeze({
      start() {
        running = true;
        worker?.start();
      },
      async stop() {
        running = false;
        await reloading;
        await worker?.stop();
      },
      async runNow() {
        await reloading;
        await worker?.runNow();
      },
      status: () =>
        worker?.status() ??
        Object.freeze({
          state: running ? ("running" as const) : ("stopped" as const),
          worker_id: `notification:${process.pid}`,
          assurance: "external" as const,
          processed_deliveries: 0,
          attention_required: 0,
          consecutive_failures: 0,
          last_cycle_at: null,
          last_error_code: null,
        }),
    }),
  });
}
