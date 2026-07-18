import { contextBridge, ipcRenderer } from "electron";
import type {
  ApiResponse,
  BackupInfoDto,
  CustomerDto,
  OrderDto,
  OrderSearchResultDto,
  OrderWithDetailsDto,
  StatsDto,
  ReportDataDto,
} from "../shared";
import type {
  CreateOrderInput,
  PickupInput,
  UpsertCustomerInput,
} from "../shared/schemas";

export interface LaundryDeskApi {
  orders: {
    create: (data: CreateOrderInput) => Promise<ApiResponse<OrderDto>>;
    findAll: (params?: {
      limit?: number;
      offset?: number;
    }) => Promise<ApiResponse<OrderWithDetailsDto[]>>;
    findById: (
      id: number,
    ) => Promise<ApiResponse<OrderWithDetailsDto | undefined>>;
    getStats: () => Promise<ApiResponse<StatsDto>>;
    getReport: (params: {
      type: "daily" | "monthly";
    }) => Promise<ApiResponse<ReportDataDto[]>>;
    pickup: (input: PickupInput) => Promise<ApiResponse<OrderDto>>;
    searchForPickup: (
      query: string,
    ) => Promise<ApiResponse<OrderSearchResultDto[]>>;
    getOverdue: () => Promise<ApiResponse<OrderWithDetailsDto[]>>;
  };
  customers: {
    upsert: (data: UpsertCustomerInput) => Promise<ApiResponse<CustomerDto>>;
    findByPhone: (
      phone: string,
    ) => Promise<ApiResponse<CustomerDto | undefined>>;
    findAll: (params?: {
      query?: string;
    }) => Promise<ApiResponse<CustomerDto[]>>;
  };
  settings: {
    get: <T = unknown>(key: string) => Promise<ApiResponse<T | null>>;
    set: (key: string, value: unknown) => Promise<ApiResponse<unknown>>;
  };
  excel: {
    exportOrders: () => Promise<ApiResponse<string | null>>;
    exportCustomers: () => Promise<ApiResponse<string | null>>;
    importOrders: () => Promise<
      ApiResponse<{ successCount: number; skipCount: number }>
    >;
    importCustomers: () => Promise<
      ApiResponse<{ successCount: number; skipCount: number }>
    >;
  };
  photos: {
    save: (
      orderId: number,
      base64Data: string,
    ) => Promise<ApiResponse<unknown>>;
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

const api: LaundryDeskApi = {
  orders: {
    create: (data) => ipcRenderer.invoke("orders:create", data),
    findAll: (params) => ipcRenderer.invoke("orders:findAll", params),
    findById: (id) => ipcRenderer.invoke("orders:findById", id),
    getStats: () => ipcRenderer.invoke("orders:getStats"),
    getReport: (params) => ipcRenderer.invoke("orders:getReport", params),
    pickup: (input) => ipcRenderer.invoke("orders:pickup", input),
    searchForPickup: (query) =>
      ipcRenderer.invoke("orders:searchForPickup", { query }),
    getOverdue: () => ipcRenderer.invoke("orders:getOverdue"),
  },
  customers: {
    upsert: (data) => ipcRenderer.invoke("customers:upsert", data),
    findByPhone: (phone) => ipcRenderer.invoke("customers:findByPhone", phone),
    findAll: (params) => ipcRenderer.invoke("customers:findAll", params),
  },
  settings: {
    get: (key) => ipcRenderer.invoke("settings:get", key),
    set: (key, value) => ipcRenderer.invoke("settings:set", { key, value }),
  },
  excel: {
    exportOrders: () => ipcRenderer.invoke("excel:exportOrders"),
    exportCustomers: () => ipcRenderer.invoke("excel:exportCustomers"),
    importOrders: () => ipcRenderer.invoke("excel:importOrders"),
    importCustomers: () => ipcRenderer.invoke("excel:importCustomers"),
  },
  photos: {
    save: (orderId, base64Data) =>
      ipcRenderer.invoke("photos:save", { orderId, base64Data }),
  },
  printer: {
    printReceipt: (orderId) =>
      ipcRenderer.invoke("printer:printReceipt", orderId),
    printPickup: (orderId) =>
      ipcRenderer.invoke("printer:printPickup", orderId),
  },
  backup: {
    runNow: () => ipcRenderer.invoke("backup:runNow"),
    list: () => ipcRenderer.invoke("backup:list"),
  },
};

contextBridge.exposeInMainWorld("api", api);
