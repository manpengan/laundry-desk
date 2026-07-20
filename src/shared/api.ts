import type {
  ApiResponse,
  BackupInfoDto,
  CustomerDto,
  OrderDto,
  OrderSearchResultDto,
  OrderWithDetailsDto,
  StatsDto,
  ReportDataDto,
} from "./index";
import type {
  CreateOrderInput,
  PickupInput,
  UpsertCustomerInput,
} from "./schemas";

export type InvokeFn = (
  channel: string,
  payload?: unknown,
) => Promise<ApiResponse<unknown>>;

export interface LaundryDeskApi {
  orders: {
    create: (data: CreateOrderInput) => Promise<ApiResponse<OrderDto>>;
    findAll: (params?: { limit?: number; offset?: number }) => Promise<
      ApiResponse<OrderWithDetailsDto[]>
    >;
    findById: (id: number) => Promise<ApiResponse<OrderWithDetailsDto | undefined>>;
    getStats: () => Promise<ApiResponse<StatsDto>>;
    getReport: (params: { type: "daily" | "monthly" }) => Promise<
      ApiResponse<ReportDataDto[]>
    >;
    pickup: (input: PickupInput) => Promise<ApiResponse<OrderDto>>;
    searchForPickup: (query: string) => Promise<ApiResponse<OrderSearchResultDto[]>>;
    getOverdue: () => Promise<ApiResponse<OrderWithDetailsDto[]>>;
  };
  customers: {
    upsert: (data: UpsertCustomerInput) => Promise<ApiResponse<CustomerDto>>;
    findByPhone: (phone: string) => Promise<ApiResponse<CustomerDto | undefined>>;
    findAll: (params?: { query?: string }) => Promise<ApiResponse<CustomerDto[]>>;
  };
  settings: {
    get: <T = unknown>(key: string) => Promise<ApiResponse<T | null>>;
    set: (key: string, value: unknown) => Promise<ApiResponse<unknown>>;
  };
  excel: {
    exportOrders: () => Promise<ApiResponse<string | null>>;
    exportCustomers: () => Promise<ApiResponse<string | null>>;
    importOrders: () => Promise<ApiResponse<{ successCount: number; skipCount: number }>>;
    importCustomers: () => Promise<ApiResponse<{ successCount: number; skipCount: number }>>;
  };
  photos: {
    save: (orderId: number, base64Data: string) => Promise<ApiResponse<unknown>>;
  };
  printer: {
    printReceipt: (orderId: number) => Promise<ApiResponse<boolean>>;
    printPickup: (orderId: number) => Promise<ApiResponse<boolean>>;
  };
  backup: {
    runNow: () => Promise<ApiResponse<string>>;
    list: () => Promise<ApiResponse<BackupInfoDto[]>>;
  };
}

export function buildApi(invoke: InvokeFn): LaundryDeskApi {
  const p = <T>(c: string, x?: unknown) => invoke(c, x) as Promise<ApiResponse<T>>;
  return {
    orders: {
      create: (d) => p("orders:create", d),
      findAll: (x) => p("orders:findAll", x),
      findById: (id) => p("orders:findById", id),
      getStats: () => p("orders:getStats"),
      getReport: (x) => p("orders:getReport", x),
      pickup: (x) => p("orders:pickup", x),
      searchForPickup: (q) => p("orders:searchForPickup", { query: q }),
      getOverdue: () => p("orders:getOverdue"),
    },
    customers: {
      upsert: (d) => p("customers:upsert", d),
      findByPhone: (ph) => p("customers:findByPhone", ph),
      findAll: (x) => p("customers:findAll", x),
    },
    settings: {
      get: (k) => p("settings:get", k),
      set: (k, v) => p("settings:set", { key: k, value: v }),
    },
    excel: {
      exportOrders: () => p("excel:exportOrders"),
      exportCustomers: () => p("excel:exportCustomers"),
      importOrders: () => p("excel:importOrders"),
      importCustomers: () => p("excel:importCustomers"),
    },
    photos: { save: (id, b) => p("photos:save", { orderId: id, base64Data: b }) },
    printer: {
      printReceipt: (id) => p("printer:printReceipt", id),
      printPickup: (id) => p("printer:printPickup", id),
    },
    backup: { runNow: () => p("backup:runNow"), list: () => p("backup:list") },
  };
}
