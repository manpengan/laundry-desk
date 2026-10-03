import type {
  CustomerPortalOrderSummary,
  CustomerPortalWalletResult,
  CustomerPortalBenefitsResult,
  CustomerPortalProfileResult,
  DeliveryAppointment,
} from "@laundry/contracts";
import type { MiniappPublic } from "./client.js";
import type { PaymentIntent, TransactionOptions } from "./transaction-client.js";
import { cents, localTime, statusLabel } from "./model.js";

export type Tab = "orders" | "appointments" | "membership";
export type Form = Readonly<{
  amount: string;
  date: string;
  time: string;
  addressIndex: string;
  areaIndex: string;
  direction: string;
  points: string;
  uses: string;
  address: string;
  recipient: string;
  contactPhone: string;
}>;
export type PortalState = Readonly<{
  configured: boolean;
  authenticated: boolean;
  bindingRequired: boolean;
  busy: boolean;
  error: string;
  notice: string;
  tab: Tab;
  public: MiniappPublic | null;
  orders: readonly CustomerPortalOrderSummary[];
  wallet: CustomerPortalWalletResult["wallet"];
  benefits: CustomerPortalBenefitsResult["benefits"];
  profile: CustomerPortalProfileResult | null;
  appointments: readonly DeliveryAppointment[];
  options: TransactionOptions | null;
  intent: PaymentIntent | null;
  payments: readonly PaymentIntent[];
  selectedOrderId: string;
  detail: readonly Readonly<{ label: string; text: string }>[];
  form: Form;
}>;
export const initialState = (configured: boolean): PortalState => ({
  configured,
  authenticated: false,
  bindingRequired: false,
  busy: false,
  error: "",
  notice: "",
  tab: "orders",
  public: null,
  orders: [],
  wallet: null,
  benefits: null,
  profile: null,
  appointments: [],
  options: null,
  intent: null,
  payments: [],
  selectedOrderId: "",
  detail: [],
  form: {
    amount: "",
    date: "",
    time: "",
    addressIndex: "0",
    areaIndex: "0",
    direction: "0",
    points: "",
    uses: "1",
    address: "",
    recipient: "",
    contactPhone: "",
  },
});
export function portalView(state: PortalState) {
  return {
    ...state,
    orders: state.orders.map((order) => ({
      ...order,
      statusText: statusLabel(order.status),
      payable: cents(order.payable_cents),
      paid: cents(order.paid_cents),
      balance: cents(order.balance_cents),
    })),
    appointments: state.appointments.map((appointment) => ({
      ...appointment,
      time: `${localTime(appointment.scheduled_start_at)} 至 ${localTime(appointment.scheduled_end_at).slice(11)}`,
      fee: cents(appointment.fee_cents),
      statusText: statusLabel(appointment.status),
      directionText: appointment.direction === "pickup" ? "上门收件" : "送衣上门",
    })),
    walletBalance: state.wallet ? cents(state.wallet.balance_cents) : "未开通",
    walletPrincipal: state.wallet ? cents(state.wallet.principal_cents) : "--",
    walletBonus: state.wallet ? cents(state.wallet.bonus_cents) : "--",
    walletLedger:
      state.wallet?.recent.map((item) => ({
        ...item,
        delta: cents(item.principal_delta_cents + item.bonus_delta_cents),
        kindText: {
          topup: "充值",
          pay: "消费",
          reversal: "冲正",
          refund: "退款",
          bonus_forfeit: "赠额失效",
        }[item.kind],
      })) ?? [],
    coupons:
      state.benefits?.coupons.map((item) => ({
        ...item,
        amount: cents(item.discount_cents),
        minimum: cents(item.min_order_cents),
        statusText: statusLabel(item.status),
      })) ?? [],
    punchCards:
      state.benefits?.punch_cards.map((item) => ({
        ...item,
        statusText: statusLabel(item.status),
      })) ?? [],
    topupRules:
      state.options?.topup_bonus_rules.map((item) => ({
        minimum: cents(item.min_topup_cents),
        bonus: cents(item.bonus_cents),
      })) ?? [],
    addresses: state.profile?.addresses ?? [],
    addressLabels: state.profile?.addresses.map((item) => `${item.label} · ${item.address}`) ?? [],
    areas: state.options?.delivery_policy?.service_areas.filter((item) => item.is_active) ?? [],
    areaLabels:
      state.options?.delivery_policy?.service_areas
        .filter((item) => item.is_active)
        .map((item) => `${item.name} · ${cents(item.fee_cents)}`) ?? [],
    intentStatus: state.intent
      ? state.intent.state === "closed"
        ? "已关闭"
        : statusLabel(state.intent.state)
      : "",
    intentAmount: state.intent ? cents(state.intent.amount_cents) : "",
    paymentRows: state.payments.map((item) => ({
      intent_id: item.intent_id,
      amount: cents(item.amount_cents),
      status: item.state === "closed" ? "已关闭" : statusLabel(item.state),
    })),
    directions: ["上门收件", "送衣上门"],
    orderLabels: state.orders
      .filter((item) => item.status === "open")
      .map((item) => item.ticket_no),
  };
}
