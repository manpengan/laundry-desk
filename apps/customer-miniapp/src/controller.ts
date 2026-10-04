import { CustomerPortalProfileUpdateInputSchema } from "@laundry/contracts";
import { ZodError } from "zod";
import type { MiniappClient } from "./client.js";
import { amountCents, appointmentEpoch, cents, statusLabel } from "./model.js";
import { initialState, portalView, type PortalState, type Tab } from "./portal-state.js";
import { createTransactions, invokePayment, type PaymentIntent } from "./transaction-client.js";
import { confirm, type WxPort } from "./wx-port.js";

export function createPortalController(
  client: MiniappClient,
  wx: WxPort,
  render: (value: ReturnType<typeof portalView>) => void,
) {
  let state = initialState(true);
  let revision = 0;
  const transactions = createTransactions(client, wx);
  const set = (patch: Partial<PortalState>) => {
    state = { ...state, ...patch };
    render(portalView(state));
  };
  const confirmCurrent = async (title: string, content: string) => {
    const current = revision;
    const accepted = await confirm(wx, title, content);
    return accepted && current === revision;
  };
  const reset = () => {
    revision += 1;
    client.clear();
    transactions.clear();
    state = { ...initialState(true), public: state.public };
    render(portalView(state));
  };
  const run = async (work: () => Promise<void>) => {
    if (state.busy) return;
    const current = revision;
    set({ busy: true, error: "", notice: "" });
    try {
      await work();
    } catch (error) {
      if (current === revision) {
        if (!client.isAuthenticated() && state.authenticated) reset();
        set({
          error:
            error instanceof ZodError
              ? "输入或服务数据无效，请检查后重试"
              : error instanceof Error
                ? error.message
                : "操作未完成，请稍后重试",
        });
      }
    } finally {
      if (current === revision) set({ busy: false });
    }
  };
  const refresh = async () => {
    const current = revision;
    const [orders, wallet, benefits, profile, options, appointments, payments] = await Promise.all([
      client.query("customer.self_service.orders.list", { limit: 20 }),
      client.query("customer.self_service.wallet.get", {}),
      client.query("customer.self_service.benefits.get", {}),
      client.query("customer.self_service.profile.get", {}),
      transactions.options(),
      transactions.appointments(),
      transactions.payments(),
    ]);
    if (revision !== current) return;
    set({
      orders: orders.orders,
      wallet: wallet.wallet,
      benefits: benefits.benefits,
      profile,
      options,
      appointments: appointments.appointments,
      payments: payments.intents,
      intent:
        state.intent ??
        payments.intents.find((item) => !["paid", "closed"].includes(item.state)) ??
        null,
    });
  };
  const order = (id: string) => {
    const found = state.orders.find((item) => item.order_id === id && item.status === "open");
    if (!found) throw new Error("请先选择本人未结订单");
    if (!state.options?.delegation_enabled) throw new Error("门店尚未开启自助交易，请联系门店");
    return found;
  };
  const payment = async (intent: PaymentIntent) => {
    const current = revision;
    set({ intent });
    let nativeError: unknown;
    try {
      await invokePayment(wx, intent);
    } catch (error) {
      nativeError = error;
    }
    if (current !== revision) return;
    const result = await transactions.status(intent.intent_id);
    set({
      intent: result,
      notice: result.state === "paid" ? "付款已确认" : "付款尚未确认，可稍后查询结果",
    });
    await refresh();
    if (nativeError && result.state !== "paid") throw nativeError;
  };
  const ensureNoPendingPayment = () => {
    if (
      (state.intent && !["paid", "closed"].includes(state.intent.state)) ||
      state.payments.some((item) => !["paid", "closed"].includes(item.state))
    )
      throw new Error("上一笔付款结果待确认，请先查询付款结果");
  };
  return Object.freeze({
    dispose: reset,
    snapshot: () => state,
    start: () => run(async () => set({ public: await client.public() })),
    selectTab(tab: string) {
      if (["orders", "appointments", "membership"].includes(tab)) set({ tab: tab as Tab });
    },
    input(name: string, value: string) {
      if (!Object.hasOwn(state.form, name) || value.length > 256 || state.busy) return;
      set({ form: { ...state.form, [name]: value } });
    },
    selectOrder(index: string) {
      const selected = state.orders.filter((item) => item.status === "open")[Number(index)];
      set({ selectedOrderId: selected?.order_id ?? "" });
    },
    login: (phoneCode?: string) =>
      run(async () => {
        if (!state.public) throw new Error("门店服务未就绪，请重试");
        const authenticated = await client.login(phoneCode);
        set({ authenticated, bindingRequired: !authenticated });
        if (authenticated) await refresh();
      }),
    logout: () =>
      run(async () => {
        try {
          await client.logout();
        } finally {
          reset();
        }
      }),
    refresh: () => run(refresh),
    detail: (id: string) =>
      run(async () => {
        if (!state.orders.some((item) => item.order_id === id))
          throw new Error("订单已变更，请刷新");
        const [result, garments, receipt] = await Promise.all([
          client.query("customer.self_service.order.get", { order_id: id }),
          client.query("customer.self_service.garments.list", { order_id: id }),
          client.query("customer.self_service.receipt.get", { order_id: id }),
        ]);
        set({
          selectedOrderId: id,
          detail: [
            ...result.lines.map((line) => ({
              label: `${line.category_code} · ${line.service_code} × ${line.qty}`,
              text: cents(line.line_total_cents),
            })),
            ...garments.garments.map((garment) => ({
              label: `第 ${garment.seq} 件 · ${garment.category_code}`,
              text: statusLabel(garment.status),
            })),
            ...receipt.receipt.payments.map((item) => ({
              label: `${item.at.slice(0, 10)} · ${item.method}`,
              text: cents(item.amount_cents),
            })),
          ],
        });
      }),
    pay: (id: string) =>
      run(async () => {
        ensureNoPendingPayment();
        const selected = order(id);
        if (!state.options?.wechat_pay_enabled) throw new Error("门店尚未开通微信支付");
        if (
          await confirmCurrent(
            "支付订单",
            `${selected.ticket_no} 待付 ${cents(selected.balance_cents)}，继续微信支付？`,
          )
        )
          await payment(await transactions.pay(id));
      }),
    balance: (id: string) =>
      run(async () => {
        const selected = order(id);
        if (
          await confirmCurrent(
            "使用储值余额",
            `为订单 ${selected.ticket_no} 支付，将使用可用余额抵扣当前欠款。`,
          )
        ) {
          await transactions.balance(id);
          await refresh();
          set({ notice: "余额支付已完成" });
        }
      }),
    topup: () =>
      run(async () => {
        ensureNoPendingPayment();
        if (!state.options?.wechat_pay_enabled || !state.options.delegation_enabled)
          throw new Error("门店尚未开通在线充值");
        const amount = amountCents(state.form.amount);
        if (
          await confirmCurrent(
            "确认充值",
            `本次充值 ${cents(amount)}。赠送金额以门店当前规则为准。`,
          )
        )
          await payment(await transactions.topup(amount));
      }),
    paymentStatus: () =>
      run(async () => {
        if (!state.intent) return;
        set({ intent: await transactions.status(state.intent.intent_id) });
        await refresh();
      }),
    selectPayment: (id: string) => {
      const selected = state.payments.find((item) => item.intent_id === id);
      if (selected) set({ intent: selected });
    },
    book: () =>
      run(async () => {
        const policy = state.options?.delivery_policy;
        if (!policy?.accepting_appointments || !state.options?.delegation_enabled)
          throw new Error("门店暂未开放预约");
        const address = state.profile?.addresses[Number(state.form.addressIndex)];
        const area = policy.service_areas.filter((item) => item.is_active)[
          Number(state.form.areaIndex)
        ];
        if (!address || !area) throw new Error("请先添加地址并选择服务区域");
        const start = appointmentEpoch(state.form.date, state.form.time, state.options.timezone);
        if (
          await confirmCurrent(
            "确认预约",
            `${state.form.date} ${state.form.time}（中国标准时间），${area.name}，预计服务费 ${cents(area.fee_cents)}。门店将按当前时段容量确认。`,
          )
        ) {
          await transactions.book({
            address_id: address.address_id,
            direction: state.form.direction === "1" ? "return" : "pickup",
            service_area_code: area.code,
            requested_start_at: start,
            expected_policy_version: policy.version,
          });
          await refresh();
          set({ notice: "预约已确认" });
        }
      }),
    cancel: (id: string) =>
      run(async () => {
        const appointment = state.appointments.find(
          (item) => item.appointment_id === id && item.status === "scheduled",
        );
        if (!appointment) throw new Error("预约已变更，请刷新");
        if (await confirmCurrent("取消预约", "确认取消这次取送预约？")) {
          await transactions.cancel(id, appointment.version);
          await refresh();
        }
      }),
    saveAddress: () =>
      run(async () => {
        if (!state.profile) throw new Error("请先刷新资料");
        const addresses = state.profile.addresses
          .filter((item) => item.source === "portal")
          .map(({ label, recipient, contact_phone, address, is_default }) => ({
            label,
            recipient,
            contact_phone,
            address,
            is_default,
          }));
        const input = CustomerPortalProfileUpdateInputSchema.parse({
          expected_version: state.profile.version,
          preferred_contact: state.profile.preferred_contact,
          addresses: [
            ...addresses,
            {
              label: "取送地址",
              address: state.form.address,
              recipient: state.form.recipient || null,
              contact_phone: state.form.contactPhone || null,
              is_default: state.profile.addresses.length === 0,
            },
          ],
        });
        await transactions.profile(input);
        await refresh();
        set({
          notice: "地址已保存",
          form: { ...state.form, address: "", recipient: "", contactPhone: "" },
        });
      }),
    benefit: (kind: string, assetId: string) =>
      run(async () => {
        const selected = order(state.selectedOrderId);
        if (
          !(await confirmCurrent(
            "确认使用权益",
            `权益将用于订单 ${selected.ticket_no}。次卡与积分按门店规则记录消耗，优惠券按适用范围抵扣。`,
          ))
        )
          return;
        if (kind === "coupon") await transactions.coupon(selected.order_id, assetId);
        else if (kind === "punch")
          await transactions.punch(selected.order_id, assetId, Number(state.form.uses));
        else if (kind === "points")
          await transactions.points(selected.order_id, Number(state.form.points));
        else throw new Error("权益类型无效");
        await refresh();
        set({ notice: "权益已使用" });
      }),
    subscribe: () =>
      run(async () => {
        const current = revision;
        const ids = state.public?.subscription_template_ids ?? [];
        if (!ids.length) throw new Error("门店尚未配置取件提醒");
        const accepted = await new Promise<string[]>((resolve, reject) =>
          wx.requestSubscribeMessage({
            tmplIds: [...ids],
            success: (value) => resolve(ids.filter((id) => value[id] === "accept")),
            fail: () => reject(new Error("消息订阅未完成，可稍后重试")),
          }),
        );
        if (current !== revision) return;
        if (accepted.length) {
          await transactions.subscribe(accepted);
          set({ notice: "已记录取件提醒订阅" });
        } else set({ notice: "未开启提醒，您仍可在订单页查看进度" });
      }),
  });
}
export type PortalController = ReturnType<typeof createPortalController>;
