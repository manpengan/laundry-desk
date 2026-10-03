import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog } from "@laundry/ui";
import {
  WechatNotificationConfigSchema,
  WechatNotificationConfigInputSchema,
  WechatNotificationListSchema,
  WechatNotificationPreviewSchema,
  type WechatNotificationConfig,
  type WechatNotificationPreview,
  type WechatNotificationRecord,
} from "@laundry/contracts";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import { unwrapQueryResult } from "./customer-model.js";
import { parseOrderLookupRows, type OrderLookupRowView } from "./OrderLookupCandidates.js";
const labels: Readonly<Record<WechatNotificationRecord["state"], string>> = {
  queued: "待发送",
  sending: "正在发送",
  accepted: "微信已受理",
  failed: "微信拒绝",
  unknown: "结果未知，禁止重发",
  cancelled: "授权已变化，已取消",
  needs_review: "恢复后暂停，禁止重发",
};
type Pending = Readonly<{ name: string; ref: string; summary: string }>;
export function MiniappNotificationPanel({
  commandClient,
  queryClient,
  sessionKey,
}: {
  commandClient: CommandPort;
  queryClient: QueryPort;
  sessionKey: string;
}) {
  const [config, setConfig] = useState<WechatNotificationConfig | null>(null),
    [items, setItems] = useState<readonly WechatNotificationRecord[]>([]);
  const [key, setKey] = useState(""),
    [orders, setOrders] = useState<readonly OrderLookupRowView[]>([]),
    [preview, setPreview] = useState<WechatNotificationPreview | null>(null);
  const [pending, setPending] = useState<Pending | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(
    async (current: number) => {
      const result = await queryClient.execute("notification.wechat.settings.get", {});
      if (current !== generation.current) return;
      if (!result.ok) {
        setMessage(result.error.message ?? result.error.code);
        return;
      }
      const parsed = WechatNotificationConfigSchema.safeParse(unwrapQueryResult(result.data));
      if (!parsed.success) {
        setMessage("微信通知配置无法解析");
        return;
      }
      setConfig(parsed.data);
      const list = await queryClient.execute("notification.wechat.list", {});
      if (current !== generation.current) return;
      if (!list.ok) {
        setMessage(list.error.message ?? list.error.code);
        return;
      }
      const rows = WechatNotificationListSchema.safeParse(unwrapQueryResult(list.data));
      if (rows.success) setItems(rows.data.items);
      else setMessage("通知记录无法解析");
    },
    [queryClient],
  );
  useEffect(() => {
    const current = ++generation.current;
    setConfig(null);
    setItems([]);
    setOrders([]);
    setPreview(null);
    setPending(null);
    setKey("");
    setMessage("");
    setBusy(true);
    void refresh(current)
      .catch(() => {
        if (current === generation.current) setMessage("读取失败，请重试");
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [refresh, sessionKey]);
  const run = async (work: (current: number) => Promise<void>) => {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    setMessage("");
    try {
      await work(current);
    } catch {
      if (current === generation.current)
        setMessage("操作结果未确认，请刷新记录后再判断；不要重复发送");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const execute = async (name: string, body: unknown, summary: string, ref?: string) =>
    run(async (current) => {
      const result = await commandClient.execute(
        name,
        ref === undefined ? body : {},
        ref === undefined ? {} : { confirmRef: ref },
      );
      if (current !== generation.current) return;
      if (result.ok) {
        setPending(null);
        setPreview(null);
        await refresh(current);
        if (current === generation.current)
          setMessage(name.endsWith("send") ? "发送任务已登记，请刷新查看微信回执" : "配置已保存");
        return;
      }
      if (
        ref === undefined &&
        isStepUpRequired(result) &&
        result.error.code === "POLICY_CONFIRMATION_REQUIRED"
      )
        setPending({ name, ref: result.error.detail.confirm_ref, summary });
      else setMessage(result.error.message ?? result.error.code);
    });
  const save = () => {
    if (config === null) return;
    const { version, available, ...body } = config;
    void available;
    const parsed = WechatNotificationConfigInputSchema.safeParse({
      ...body,
      expected_version: version,
    });
    if (!parsed.success) {
      setMessage("请填写有效模板编号和字段名称");
      return;
    }
    void execute(
      "notification.wechat.settings.set",
      parsed.data,
      `${body.enabled ? "启用" : "停用"}取衣订阅通知，模板 ${body.template_id}，环境 ${body.miniprogram_state}。仅向已订阅顾客发送人工确认的取衣提醒。`,
    );
  };
  const search = () =>
    run(async (current) => {
      setPreview(null);
      setOrders([]);
      const result = await queryClient.execute("order.lookup", {
        key: key.trim(),
        status: "open",
        limit: 20,
      });
      if (current !== generation.current) return;
      const rows = result.ok ? parseOrderLookupRows(unwrapQueryResult(result.data)) : null;
      if (rows === null)
        setMessage(result.ok ? "订单结果无法解析" : (result.error.message ?? result.error.code));
      else {
        setOrders(rows);
        if (rows.length === 0) setMessage("未找到订单");
      }
    });
  const select = (orderId: string) =>
    run(async (current) => {
      setPreview(null);
      const result = await queryClient.execute("notification.wechat.preview", {
        order_id: orderId,
      });
      if (current !== generation.current) return;
      if (!result.ok) {
        setMessage("当前订单不能发送：请确认衣物已全部就绪、顾客有未使用订阅，且模板已启用");
        return;
      }
      const parsed = WechatNotificationPreviewSchema.safeParse(unwrapQueryResult(result.data));
      if (parsed.success) setPreview(parsed.data);
      else setMessage("通知预览无法解析");
    });
  const edit = (value: Partial<WechatNotificationConfig>) => {
    setConfig((current) => (current === null ? null : { ...current, ...value }));
    setPreview(null);
    setPending(null);
  };
  return (
    <section aria-label="微信取衣订阅通知">
      <h3>微信取衣通知</h3>
      <p>
        先在顾客小程序配置批准模板，并由顾客点击同意订阅。每次同意仅用一次；微信受理不代表顾客已收到。
      </p>
      <fieldset disabled={busy || config === null || pending !== null}>
        <legend>模板字段设置</legend>
        <label>
          <input
            type="checkbox"
            checked={config?.enabled ?? false}
            onChange={(e) => edit({ enabled: e.target.checked })}
          />
          启用人工确认发送
        </label>
        <label>
          微信模板 ID
          <input
            value={config?.template_id ?? ""}
            onChange={(e) => edit({ template_id: e.target.value })}
          />
        </label>
        <label>
          票号字段
          <input
            value={config?.ticket_field ?? ""}
            onChange={(e) => edit({ ticket_field: e.target.value })}
          />
        </label>
        <label>
          门店字段
          <input
            value={config?.store_field ?? ""}
            onChange={(e) => edit({ store_field: e.target.value })}
          />
        </label>
        <label>
          状态字段
          <input
            value={config?.status_field ?? ""}
            onChange={(e) => edit({ status_field: e.target.value })}
          />
        </label>
        <label>
          打开小程序版本
          <select
            value={config?.miniprogram_state ?? "trial"}
            onChange={(e) =>
              edit({
                miniprogram_state: e.target.value as WechatNotificationConfig["miniprogram_state"],
              })
            }
          >
            <option value="developer">开发版</option>
            <option value="trial">体验版</option>
            <option value="formal">正式版</option>
          </select>
        </label>
        <Button onClick={save}>保存通知配置</Button>
      </fieldset>
      <fieldset disabled={busy || !config?.enabled || pending !== null}>
        <legend>选择订单并预览</legend>
        <label>
          票号、取件码或手机号
          <input
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setPreview(null);
              setOrders([]);
            }}
            maxLength={128}
          />
        </label>
        <Button onClick={() => void search()} disabled={!key.trim()}>
          查找订单
        </Button>
        <ul>
          {orders.map((order) => (
            <li key={order.order_id}>
              <Button variant="secondary" onClick={() => void select(order.order_id)}>
                {order.ticket_no ?? "无票号"} · {order.customer_name ?? "顾客"}
              </Button>
            </li>
          ))}
        </ul>
        {preview !== null && (
          <div aria-label="实际发送内容">
            <p>
              票号：{preview.payload.ticket}；门店：{preview.payload.store}；状态：
              {preview.payload.status}
            </p>
            <Button
              onClick={() =>
                void execute(
                  "notification.wechat.send",
                  { order_id: preview.order_id, preview_sha256: preview.preview_sha256 },
                  `向该订单已订阅的顾客发送一次取衣提醒：${preview.payload.ticket}，${preview.payload.store}，${preview.payload.status}。消耗一次订阅；结果未知时不重复发送。`,
                )
              }
            >
              确认该内容并申请发送
            </Button>
          </div>
        )}
      </fieldset>
      <Button variant="secondary" disabled={busy} onClick={() => void run(refresh)}>
        刷新通知记录
      </Button>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {new Date(item.created_at).toLocaleString()} · {labels[item.state]}
            {item.error_code === null ? "" : `（${item.error_code}）`}
          </li>
        ))}
      </ul>
      {message && <p role="status">{message}</p>}
      <Dialog
        open={pending !== null}
        title="确认微信通知操作"
        onClose={() => {
          if (!busy) setPending(null);
        }}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              disabled={busy || pending === null}
              onClick={() => {
                if (pending !== null) void execute(pending.name, {}, pending.summary, pending.ref);
              }}
            >
              确认执行
            </Button>
          </>
        }
      >
        <p>{pending?.summary}</p>
      </Dialog>
    </section>
  );
}
