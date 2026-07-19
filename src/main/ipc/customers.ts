import {
  CustomerSearchSchema,
  PhoneSchema,
  UpsertCustomerSchema,
} from "../../shared/schemas";
import { CustomerService } from "../services/customerService";
import { registerIpcHandler } from "./helpers";

export function registerCustomerIpc(): void {
  registerIpcHandler("customers:upsert", UpsertCustomerSchema, (input) =>
    CustomerService.upsertByPhone(input.name, input.phone),
  );
  registerIpcHandler("customers:findByPhone", PhoneSchema, (phone) =>
    CustomerService.findByPhone(phone),
  );
  registerIpcHandler("customers:findAll", CustomerSearchSchema, (input) =>
    CustomerService.findAll(input?.query),
  );
}
