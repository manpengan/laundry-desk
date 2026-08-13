/**
 * HTTP query port → POST /v1/queries/:name (local server).
 * Auth headers mirror createHttpCommandClient (Bearer + CSRF + credentials).
 */

import { requestFailureResult } from "./request-abort.js";
import type { CommandFailure, CommandResult, QueryExecutionOptions, QueryPort } from "./types.js";

/** Matches packages/contracts CSRF_HEADER_NAME. */
const CSRF_HEADER_NAME = "x-csrf-token";

export type HttpQueryClientOptions = Readonly<{
  apiBaseUrl: string;
  getAccessToken: () => string | null;
  /** Optional override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional CSRF reader (defaults to document.cookie). */
  readCsrf?: () => string | null;
}>;

/** Counter price-list row (integer fen). Mirrors domain CatalogItem. */
export type CatalogListItem = Readonly<{
  code: string;
  name: string;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  mnemonic?: string;
}>;

export type CatalogListResult = Readonly<{
  items: readonly CatalogListItem[];
  total: number;
}>;

/** Demo seed aligned with apps/server memory catalog (no packages/* import). */
export const DEMO_CATALOG_ITEMS: readonly CatalogListItem[] = Object.freeze([
  Object.freeze({
    code: "wash_shirt",
    name: "水洗衬衫",
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: 1500,
    mnemonic: "xs",
  }),
  Object.freeze({
    code: "wash_pants",
    name: "水洗西裤",
    service_code: "wash",
    category_code: "pants",
    unit_price_cents: 1800,
    mnemonic: "xk",
  }),
  Object.freeze({
    code: "dry_coat",
    name: "干洗大衣",
    service_code: "dry",
    category_code: "coat",
    unit_price_cents: 4500,
    mnemonic: "dy",
  }),
  Object.freeze({
    code: "dry_suit",
    name: "干洗西装",
    service_code: "dry",
    category_code: "suit",
    unit_price_cents: 3800,
    mnemonic: "xz",
  }),
  Object.freeze({
    code: "iron_shirt",
    name: "熨烫衬衫",
    service_code: "iron",
    category_code: "shirt",
    unit_price_cents: 800,
    mnemonic: "yt",
  }),
  Object.freeze({
    code: "wash_duvet",
    name: "水洗被套",
    service_code: "wash",
    category_code: "duvet",
    unit_price_cents: 3500,
    mnemonic: "bt",
  }),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultReadCsrf(): string | null {
  if (typeof document === "undefined") return null;
  const match = /(?:^|;\s*)(?:__Host-laundry_csrf|laundry_csrf)=([^;]+)/u.exec(document.cookie);
  return match?.[1] ?? null;
}

function parseFailure(body: unknown): CommandFailure {
  if (!isRecord(body) || !isRecord(body.error)) {
    return Object.freeze({ code: "QUERY_FAILED", message: "查询失败" });
  }
  const err = body.error;
  const code = typeof err.code === "string" ? err.code : "QUERY_FAILED";
  const message = typeof err.message === "string" ? err.message : undefined;
  let detail: CommandFailure["detail"];
  if (isRecord(err.detail)) {
    detail = Object.freeze({
      ...(typeof err.detail.kind === "string" ? { kind: err.detail.kind } : {}),
      ...(typeof err.detail.confirm_ref === "string"
        ? { confirm_ref: err.detail.confirm_ref }
        : {}),
      ...(typeof err.detail.message === "string" ? { message: err.detail.message } : {}),
    });
  }
  return Object.freeze({
    code,
    ...(message !== undefined ? { message } : {}),
    ...(detail !== undefined ? { detail } : {}),
  });
}

function matchesCatalog(item: CatalogListItem, key: string): boolean {
  if (item.code.toLowerCase().includes(key)) return true;
  if (item.name.toLowerCase().includes(key)) return true;
  if (item.service_code.toLowerCase().includes(key)) return true;
  if (item.category_code.toLowerCase().includes(key)) return true;
  if (item.mnemonic !== undefined && item.mnemonic.toLowerCase().includes(key)) return true;
  return false;
}

function filterDemoCatalog(query: string, limit: number): CatalogListResult {
  const key = query.trim().toLowerCase();
  const filtered =
    key.length === 0
      ? DEMO_CATALOG_ITEMS.slice()
      : DEMO_CATALOG_ITEMS.filter((item) => matchesCatalog(item, key));
  return Object.freeze({
    items: Object.freeze(filtered.slice(0, Math.max(1, limit))),
    total: filtered.length,
  });
}

export function createHttpQueryClient(options: HttpQueryClientOptions): QueryPort {
  const base = options.apiBaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const readCsrf = options.readCsrf ?? defaultReadCsrf;

  return Object.freeze({
    async execute<T = unknown>(
      name: string,
      body: unknown = {},
      execOptions: QueryExecutionOptions = {},
    ): Promise<CommandResult<T>> {
      const token = options.getAccessToken();
      if (token === null || token.length === 0) {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "AUTHENTICATION_FAILED", message: "未登录" }),
        });
      }
      const csrf = readCsrf();
      if (csrf === null) {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "CSRF_REJECTED", message: "缺少 CSRF cookie" }),
        });
      }
      try {
        const res = await fetchImpl(`${base}/v1/queries/${encodeURIComponent(name)}`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            [CSRF_HEADER_NAME]: csrf,
          },
          body: JSON.stringify(body ?? {}),
          ...(execOptions.signal === undefined ? {} : { signal: execOptions.signal }),
        });
        const json: unknown = await res.json();
        if (isRecord(json) && json.ok === true) {
          return Object.freeze({ ok: true as const, data: json.data as T });
        }
        return Object.freeze({ ok: false as const, error: parseFailure(json) });
      } catch {
        return requestFailureResult(execOptions.signal);
      }
    },
  });
}

/** Empty queue by default so SSR/shell polls stay idle. */
export const DEMO_PRINT_JOBS: readonly Readonly<{
  job_id: string;
  kind: string;
  status: string;
  order_id: string;
  ticket_no: string;
  created_at: number;
  updated_at: number;
  error?: string;
}>[] = Object.freeze([]);

/**
 * In-memory query port for SSR/unit tests.
 * Default handler: DEMO catalog, empty print jobs, stats and reconciliation.
 */
export function createMockQueryClient(handler?: QueryPort["execute"]): QueryPort {
  if (handler !== undefined) {
    return Object.freeze({ execute: handler });
  }
  return Object.freeze({
    async execute<T = unknown>(name: string, body: unknown = {}): Promise<CommandResult<T>> {
      if (name === "catalog.items.list") {
        const input = isRecord(body) ? body : {};
        const query = typeof input.query === "string" ? input.query : "";
        const limit =
          typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
            ? input.limit
            : 50;
        const list = filterDemoCatalog(query, limit);
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            execution: "executed",
            result: list,
          }) as T,
        });
      }
      if (name === "catalog.items.manage.list") {
        const input = isRecord(body) ? body : {};
        const query = typeof input.query === "string" ? input.query : "";
        const limit =
          typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
            ? input.limit
            : 50;
        const list = filterDemoCatalog(query, limit);
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            execution: "executed",
            result: Object.freeze({
              items: Object.freeze(
                list.items.map((item, index) =>
                  Object.freeze({
                    ...item,
                    is_active: true,
                    sort_order: index,
                    version: 1,
                    updated_at: 0,
                  }),
                ),
              ),
              total: list.total,
            }),
          }) as T,
        });
      }
      if (name === "catalog.audit.list") {
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            execution: "executed",
            result: Object.freeze({ items: Object.freeze([]) }),
          }) as T,
        });
      }
      if (name === "order.get") {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({
            code: "RESOURCE_UNAVAILABLE",
            message: "mock 未配置 order.get 数据",
          }),
        });
      }
      if (name === "order.list") {
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            execution: "executed",
            result: Object.freeze({ orders: Object.freeze([]) }),
          }) as T,
        });
      }
      if (name === "payment.ledger.list") {
        const input = isRecord(body) ? body : {};
        const orderId = typeof input.order_id === "string" ? input.order_id : "";
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            execution: "executed",
            result: Object.freeze({
              order_id: orderId,
              order_status: "open",
              payable_cents: 0,
              paid_cents: 0,
              balance_cents: 0,
              payments: Object.freeze([]),
            }),
          }) as T,
        });
      }
      if (name === "pricing.policy.get") {
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            execution: "executed",
            result: Object.freeze({
              policy: Object.freeze({
                version: 0,
                urgent_cents: 0,
                freight_cents: 0,
                addons: Object.freeze([]),
                updated_at: null,
              }),
            }),
          }) as T,
        });
      }
      if (name === "print.jobs.list") {
        const input = isRecord(body) ? body : {};
        const limit =
          typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
            ? Math.min(input.limit, 50)
            : 20;
        const jobs = DEMO_PRINT_JOBS.slice(0, limit);
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            execution: "executed",
            result: Object.freeze({ jobs: Object.freeze(jobs) }),
          }) as T,
        });
      }
      if (name === "stats.day.summary") {
        const input = isRecord(body) ? body : {};
        const businessDate =
          typeof input.business_date === "string" ? input.business_date : "1970-01-01";
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            execution: "executed",
            result: Object.freeze({
              business_date: businessDate,
              order_count: 0,
              garment_count: 0,
              payable_cents: 0,
              paid_cents: 0,
              balance_cents: 0,
              payment_cents: 0,
              picked_garment_count: 0,
            }),
          }) as T,
        });
      }
      if (name === "reconciliation.day.get") {
        const input = isRecord(body) ? body : {};
        const businessDate =
          typeof input.business_date === "string" ? input.business_date : "1970-01-01";
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            execution: "executed",
            result: Object.freeze({
              business_date: businessDate,
              generated_at: "1970-01-01T00:00:00.000Z",
              orders: Object.freeze({
                count: 0,
                payable_cents: 0,
                paid_cents: 0,
                balance_cents: 0,
              }),
              ledger: Object.freeze({
                row_count: 0,
                gross_cents: 0,
                refund_cents: 0,
                net_cents: 0,
                difference_from_orders_cents: 0,
                buckets: Object.freeze([]),
              }),
              shift: null,
              print: Object.freeze({ total: 0, statuses: Object.freeze([]) }),
              edge_replay: Object.freeze({
                total: 0,
                conflict_count: 0,
                decisions: Object.freeze([]),
              }),
            }),
          }) as T,
        });
      }
      return Object.freeze({
        ok: false as const,
        error: Object.freeze({ code: "RESOURCE_UNAVAILABLE", message: "未知查询" }),
      });
    },
  });
}
