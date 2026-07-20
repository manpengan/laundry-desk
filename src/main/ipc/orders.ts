import { z } from "zod";
import {
  CreateOrderSchema,
  IdSchema,
  PaginationSchema,
  PickupSchema,
  ReportInputSchema,
  SearchOrdersSchema,
} from "../../shared/schemas";
import { OrderService } from "../services/orderService";
import { ReportService } from "../services/reportService";
import { registerIpcHandler } from "./helpers";

export function registerOrderIpc(): void {
  registerIpcHandler("orders:create", CreateOrderSchema, (input) =>
    OrderService.createOrder(input),
  );
  registerIpcHandler("orders:findAll", PaginationSchema, (input) =>
    OrderService.findAll(input),
  );
  registerIpcHandler("orders:findById", IdSchema, (id) =>
    OrderService.findById(id),
  );
  registerIpcHandler("orders:getStats", z.undefined(), () =>
    ReportService.getStats(),
  );
  registerIpcHandler("orders:getReport", ReportInputSchema, (input) =>
    ReportService.getReport(input),
  );
  registerIpcHandler("orders:pickup", PickupSchema, (input) =>
    OrderService.pickup(input),
  );
  registerIpcHandler("orders:searchForPickup", SearchOrdersSchema, (input) =>
    OrderService.searchForPickup(input.query),
  );
  registerIpcHandler("orders:getOverdue", z.undefined(), () =>
    OrderService.findOverdue(),
  );
}
