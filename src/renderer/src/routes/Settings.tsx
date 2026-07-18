import { useEffect, useState } from "react";
import { Database, Save, Plus, Trash2, Upload } from "lucide-react";
import type { BackupInfoDto } from "@shared/index";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { formatCurrency } from "@renderer/lib/utils";

interface PriceTemplate {
  itemType: string;
  serviceType: "wash" | "dry_clean" | "iron";
  price: number; // 分
}

const SERVICE_LABEL: Record<PriceTemplate["serviceType"], string> = {
  wash: "水洗",
  dry_clean: "干洗",
  iron: "仅熨烫",
};

const selectCls =
  "h-11 w-full rounded-[12px] border px-3.5 text-[14px] text-[var(--lg-ink)] focus:border-[var(--lg-accent)] focus:outline-none focus:ring-[3px] focus:ring-[var(--lg-accent-soft)]";
const selectStyle = {
  background: "var(--lg-leaf)",
  borderColor: "var(--lg-hair)",
};

export default function Settings() {
  const [shopName, setShopName] = useState("");
  const [backups, setBackups] = useState<BackupInfoDto[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<PriceTemplate[]>([]);
  const [newTemplate, setNewTemplate] = useState({
    itemType: "",
    serviceType: "wash" as PriceTemplate["serviceType"],
    price: "",
  });

  useEffect(() => {
    void window.api.settings.get<string>("shop.name").then((response) => {
      if (response.ok) setShopName(response.data ?? "");
    });
    void window.api.settings
      .get<PriceTemplate[]>("price_templates")
      .then((response) => {
        if (response.ok && response.data) setTemplates(response.data);
      });
    void refreshBackups();
  }, []);

  const refreshBackups = async (): Promise<void> => {
    const response = await window.api.backup.list();
    if (response.ok) setBackups(response.data);
  };

  const handleSave = async (): Promise<void> => {
    setLoading(true);
    const response = await window.api.settings.set("shop.name", shopName);
    setLoading(false);
    setMessage(response.ok ? "设置已保存" : response.error.message);
  };

  const handleBackup = async (): Promise<void> => {
    setLoading(true);
    const response = await window.api.backup.runNow();
    setLoading(false);
    if (!response.ok) {
      setMessage(response.error.message);
      return;
    }
    setMessage(`备份成功: ${response.data}`);
    await refreshBackups();
  };

  const handleAddTemplate = async (): Promise<void> => {
    if (!newTemplate.itemType.trim() || !newTemplate.price) {
      setMessage("请填写完整的模板信息");
      return;
    }
    const updated = [
      ...templates,
      {
        itemType: newTemplate.itemType.trim(),
        serviceType: newTemplate.serviceType,
        price: yuanInputToCents(newTemplate.price),
      },
    ];
    const res = await window.api.settings.set("price_templates", updated);
    if (res.ok) {
      setTemplates(updated);
      setNewTemplate({ itemType: "", serviceType: "wash", price: "" });
      setMessage("价格模板已添加");
    } else {
      setMessage(res.error.message);
    }
  };

  const handleDeleteTemplate = async (index: number): Promise<void> => {
    const updated = templates.filter((_, i) => i !== index);
    const res = await window.api.settings.set("price_templates", updated);
    if (res.ok) {
      setTemplates(updated);
      setMessage("价格模板已删除");
    } else {
      setMessage(res.error.message);
    }
  };

  const runImport = async (kind: "customers" | "orders"): Promise<void> => {
    setLoading(true);
    const res =
      kind === "customers"
        ? await window.api.excel.importCustomers()
        : await window.api.excel.importOrders();
    setLoading(false);
    if (!res.ok) {
      setMessage(res.error.message);
      return;
    }
    if (res.data) {
      setMessage(
        `${kind === "customers" ? "客户" : "订单"}导入成功：成功 ${res.data.successCount} 条，跳过 ${res.data.skipCount} 条。`,
      );
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-8">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--lg-ink3)]">
          Settings
        </p>
        <h2 className="mt-1 text-[24px] font-bold leading-none tracking-[-0.02em]">
          系统设置
        </h2>
      </div>
      {message && (
        <div className="rounded-[14px] bg-[var(--lg-accent-soft)] px-4 py-3 text-[13px] font-semibold text-[var(--lg-accent)]">
          {message}
        </div>
      )}

      <div className="lg-card lg-spec rounded-[20px]">
        <div className="px-5 pb-1 pt-4">
          <h3 className="text-[15px] font-semibold">店铺信息</h3>
        </div>
        <div className="space-y-3 p-4 pt-2">
          <Input
            value={shopName}
            onChange={(event) => setShopName(event.target.value)}
            placeholder="店铺名称"
          />
          <Button onClick={() => void handleSave()} disabled={loading}>
            <Save className="mr-2 h-4 w-4" /> 保存更改
          </Button>
        </div>
      </div>

      <div className="lg-card lg-spec rounded-[20px]">
        <div className="px-5 pb-1 pt-4">
          <h3 className="text-[15px] font-semibold">价格模板管理</h3>
        </div>
        <div className="space-y-4 p-4 pt-2">
          <div className="lg-inset grid items-end gap-3 rounded-[16px] p-3.5 md:grid-cols-[1fr_120px_100px_80px]">
            <label className="space-y-1.5">
              <span className="text-[11.5px] font-semibold text-[var(--lg-ink3)]">
                衣物类型
              </span>
              <Input
                placeholder="例如：衬衫"
                value={newTemplate.itemType}
                onChange={(event) =>
                  setNewTemplate({
                    ...newTemplate,
                    itemType: event.target.value,
                  })
                }
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-[11.5px] font-semibold text-[var(--lg-ink3)]">
                洗涤服务
              </span>
              <select
                className={selectCls}
                style={selectStyle}
                value={newTemplate.serviceType}
                onChange={(event) =>
                  setNewTemplate({
                    ...newTemplate,
                    serviceType: event.target
                      .value as PriceTemplate["serviceType"],
                  })
                }
              >
                <option value="wash">水洗</option>
                <option value="dry_clean">干洗</option>
                <option value="iron">仅熨烫</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-[11.5px] font-semibold text-[var(--lg-ink3)]">
                单价(元)
              </span>
              <Input
                type="number"
                min={0}
                placeholder="金额"
                value={newTemplate.price}
                onChange={(event) =>
                  setNewTemplate({ ...newTemplate, price: event.target.value })
                }
              />
            </label>
            <Button className="h-11" onClick={() => void handleAddTemplate()}>
              <Plus className="mr-1 h-4 w-4" /> 添加
            </Button>
          </div>

          <div className="max-h-[300px] overflow-y-auto pr-1">
            {templates.map((template, index) => (
              <div
                key={`${template.itemType}-${template.serviceType}-${index}`}
                className="flex items-center justify-between border-b py-2.5 last:border-b-0"
                style={{ borderColor: "var(--lg-hair)" }}
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-[14px] font-semibold">
                    {template.itemType}
                  </span>
                  <span className="lg-pill busy">
                    {SERVICE_LABEL[template.serviceType]}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="text-[14px] font-bold text-[var(--lg-accent)]"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatCurrency(template.price)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-[var(--lg-late-ink)]"
                    onClick={() => void handleDeleteTemplate(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
            {templates.length === 0 && (
              <p className="py-4 text-center text-[13px] text-[var(--lg-ink3)]">
                暂无价格模板
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="lg-card lg-spec rounded-[20px]">
        <div className="px-5 pb-1 pt-4">
          <h3 className="text-[15px] font-semibold">外部数据导入</h3>
        </div>
        <div className="space-y-3 p-4 pt-2">
          <p className="text-[13px] text-[var(--lg-ink2)]">
            支持一键导入 Excel 中的历史客户及订单账目明细（桌面端功能）。
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={() => void runImport("customers")}
              disabled={loading}
            >
              <Upload className="mr-2 h-4 w-4" /> 导入客户 Excel
            </Button>
            <Button
              variant="outline"
              onClick={() => void runImport("orders")}
              disabled={loading}
            >
              <Upload className="mr-2 h-4 w-4" /> 导入订单 Excel
            </Button>
          </div>
        </div>
      </div>

      <div className="lg-card lg-spec rounded-[20px]">
        <div className="px-5 pb-1 pt-4">
          <h3 className="text-[15px] font-semibold">数据备份</h3>
        </div>
        <div className="space-y-3 p-4 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[14px] font-semibold">自动备份</p>
              <p className="text-[12.5px] text-[var(--lg-ink2)]">
                每天凌晨 03:00 自动备份，保留最近 30 份。
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => void handleBackup()}
              disabled={loading}
            >
              <Database className="mr-2 h-4 w-4" /> 立即备份
            </Button>
          </div>
          <div className="space-y-2">
            {backups.map((backup) => (
              <div
                key={backup.path}
                className="lg-inset rounded-[14px] px-4 py-2.5 text-[13px]"
              >
                <div className="font-semibold">{backup.fileName}</div>
                <div
                  className="text-[12px] text-[var(--lg-ink3)]"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {new Date(backup.createdAt).toLocaleString("zh-CN")} ·{" "}
                  {(backup.size / 1024).toFixed(1)} KB
                </div>
              </div>
            ))}
            {backups.length === 0 && (
              <p className="text-[13px] text-[var(--lg-ink3)]">暂无备份文件</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function yuanInputToCents(value: string): number {
  const normalized = value.trim();
  if (!normalized) return 0;
  const [yuan = "0", fraction = ""] = normalized.split(".");
  return Number(yuan) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}
