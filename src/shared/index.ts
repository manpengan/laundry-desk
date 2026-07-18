export type ApiErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export type ApiResponse<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: ApiErrorCode;
        message: string;
      };
    };

export const ERROR_CODES = {
  INTERNAL_ERROR: "INTERNAL_ERROR",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
} as const;

export interface CustomerDto {
  id: number;
  name: string;
  phone: string;
  vipLevel: number;
  totalOrders: number;
  totalSpent: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface OrderItemDto {
  id: number;
  orderId: number;
  itemType: string;
  serviceType: "wash" | "dry_clean" | "iron";
  quantity: number;
  unitPrice: number;
  subtotal: number;
  itemNotes: string | null;
}

export interface OrderDto {
  id: number;
  orderNo: string;
  pickupCode: string;
  customerId: number;
  status: "pending" | "ready" | "picked_up" | "cancelled";
  totalAmount: number;
  paidAmount: number;
  paymentMethod: "cash" | "wechat" | "alipay" | "card" | "unpaid";
  receiveDate: Date;
  expectedPickupDate: Date | null;
  actualPickupAt: Date | null;
  staffId: number | null;
  pickedUpBy: number | null;
  notes: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface OrderWithDetailsDto extends OrderDto {
  customer: CustomerDto;
  items: OrderItemDto[];
}

export interface OrderSearchResultDto {
  id: number;
  orderNo: string;
  pickupCode: string;
  status: string;
  totalAmount: number;
  paidAmount: number;
  receiveDate: Date;
  customerName: string;
  customerPhone: string;
}

export interface StatsDto {
  todayIncome: number;
  monthIncome: number;
  todayCount: number;
  monthCount: number;
  pendingCount: number;
  overdueCount: number;
  dueTodayCount: number;
  chartData: Array<{ date: string; count: number; income: number }>;
}

export interface BackupInfoDto {
  fileName: string;
  path: string;
  size: number;
  createdAt: string;
}

export interface ReportDataDto {
  date: string;
  count: number;
  income: number;
}
