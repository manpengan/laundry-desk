import { z } from "zod";

export const ServiceTypeSchema = z.enum(["wash", "dry_clean", "iron"]);
export const PaymentMethodSchema = z.enum([
  "cash",
  "wechat",
  "alipay",
  "card",
  "unpaid",
]);

const centsSchema = z.number().int("金额必须是整数分").min(0, "金额不能为负数");

export const OrderItemInputSchema = z.object({
  itemType: z.string().trim().min(1, "物品类型不能为空"),
  serviceType: ServiceTypeSchema,
  quantity: z.number().int("数量必须是整数").positive("数量必须大于 0"),
  unitPrice: centsSchema,
  itemNotes: z.string().trim().max(500).optional(),
});

export const CreateOrderSchema = z.object({
  customerId: z.number().int().positive(),
  items: z.array(OrderItemInputSchema).min(1, "至少添加一件物品"),
  totalAmount: centsSchema,
  paidAmount: centsSchema,
  paymentMethod: PaymentMethodSchema,
  expectedPickupDate: z.coerce.date().optional(),
  notes: z.string().trim().max(1000).optional(),
  staffId: z.number().int().positive().optional(),
});

export const UpsertCustomerSchema = z.object({
  name: z.string().trim().min(1, "客户姓名不能为空").max(80),
  phone: z
    .string()
    .trim()
    .regex(/^1[3-9]\d{9}$/, "手机号格式不正确"),
});

export const IdSchema = z.number().int().positive();

export const PaginationSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .optional();

export const PickupSchema = z.object({
  orderId: IdSchema,
  paidAmount: centsSchema.optional(),
  staffId: z.number().int().positive().optional(),
});

export const SearchOrdersSchema = z.object({
  query: z.string().trim().min(1).max(80),
});

export const CustomerSearchSchema = z
  .object({
    query: z.string().trim().max(80).optional(),
  })
  .optional();

export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^1[3-9]\d{9}$/, "手机号格式不正确");

export const SettingKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9._-]+$/i, "设置 key 格式不正确");

export const SetSettingSchema = z.object({
  key: SettingKeySchema,
  value: z.unknown(),
});

export const SavePhotoSchema = z.object({
  orderId: IdSchema,
  base64Data: z.string().min(1),
});

export const NoInputSchema = z.undefined();

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
export type UpsertCustomerInput = z.infer<typeof UpsertCustomerSchema>;
export type PickupInput = z.infer<typeof PickupSchema>;
export type SearchOrdersInput = z.infer<typeof SearchOrdersSchema>;
export type CustomerSearchInput = z.infer<typeof CustomerSearchSchema>;
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;
export type ServiceType = z.infer<typeof ServiceTypeSchema>;

export const ReportInputSchema = z.object({
  type: z.enum(["daily", "monthly"]),
});
export type ReportInput = z.infer<typeof ReportInputSchema>;
