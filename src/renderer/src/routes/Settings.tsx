import { useEffect, useState } from "react";
import { Database, Save, Plus, Trash2, Upload } from "lucide-react";
import type { BackupInfoDto } from "@shared/index";
import { Button } from "../components/ui/Button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { formatCurrency } from "@renderer/lib/utils";

interface PriceTemplate {
  itemType: string;
  serviceType: "wash" | "dry_clean" | "iron";
  price: number; // 分
}

export default function Settings() {
  const [shopName, setShopName] = useState("");
  const [backups, setBackups] = useState<BackupInfoDto[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const [templates, setTemplates] = useState<PriceTemplate[]>([]);
  const [newTemplate, setNewTemplate] = useState({
    itemType: "",
    serviceType: "wash" as const,
    price: "",
  });

  useEffect(() => {
    window.api.settings.get<string>("shop.name").then((response) => {
      if (response.ok) setShopName(response.data ?? "");
    });
    window.api.settings
      .get<PriceTemplate[]>("price_templates")
      .then((response) => {
        if (response.ok && response.data) setTemplates(response.data);
      });
    void refreshBackups();
  }, []);

  const refreshBackups = async () => {
    const response = await window.api.backup.list();
    if (response.ok) setBackups(response.data);
  };

  const handleSave = async () => {
    setLoading(true);
    const response = await window.api.settings.set("shop.name", shopName);
    setLoading(false);
    setMessage(response.ok ? "设置已保存" : response.error.message);
  };

  const handleBackup = async () => {
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

  const handleAddTemplate = async () => {
    if (!newTemplate.itemType.trim() || !newTemplate.price) {
      setMessage("请填写完整的模板信息");
      return;
    }
    const priceCents = yuanInputToCents(newTemplate.price);
    const updated = [
      ...templates,
      {
        itemType: newTemplate.itemType.trim(),
        serviceType: newTemplate.serviceType,
        price: priceCents,
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

  const handleDeleteTemplate = async (index: number) => {
    const updated = templates.filter((_, i) => i !== index);
    const res = await window.api.settings.set("price_templates", updated);
    if (res.ok) {
      setTemplates(updated);
      setMessage("价格模板已删除");
    } else {
      setMessage(res.error.message);
    }
  };

  const handleImportCustomers = async () => {
    setLoading(true);
    const res = await window.api.excel.importCustomers();
    setLoading(false);
    if (!res.ok) {
      setMessage(res.error.message);
      return;
    }
    if (res.data) {
      setMessage(
        `客户导入成功：成功 ${res.data.successCount} 条，跳过 ${res.data.skipCount} 条。`,
      );
    }
  };

  const handleImportOrders = async () => {
    setLoading(true);
    const res = await window.api.excel.importOrders();
    setLoading(false);
    if (!res.ok) {
      setMessage(res.error.message);
      return;
    }
    if (res.data) {
      setMessage(
        `订单导入成功：成功 ${res.data.successCount} 条，跳过 ${res.data.skipCount} 条。`,
      );
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12">
      <h2 className="text-2xl font-bold">系统设置</h2>
      {message && (
        <div className="rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-600">
          {message}
        </div>
      )}

      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">店铺信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            value={shopName}
            onChange={(event) => setShopName(event.target.value)}
            placeholder="店铺名称"
          />
          <Button onClick={handleSave} disabled={loading}>
            <Save className="w-4 h-4 mr-2" /> 保存更改
          </Button>
        </CardContent>
      </Card>

      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">价格模板管理</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[1fr_120px_100px_80px] items-end bg-slate-50 p-4 rounded-xl">
            <div className="space-y-2">
              <span className="text-xs text-slate-500 font-medium">
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
            </div>
            <div className="space-y-2">
              <span className="text-xs text-slate-500 font-medium">
                洗涤服务
              </span>
              <select
                className="w-full h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm"
                value={newTemplate.serviceType}
                onChange={(event) =>
                  setNewTemplate({
                    ...newTemplate,
                    serviceType: event.target.value as any,
                  })
                }
              >
                <option value="wash">水洗</option>
                <option value="dry_clean">干洗</option>
                <option value="iron">仅熨烫</option>
              </select>
            </div>
            <div className="space-y-2">
              <span className="text-xs text-slate-500 font-medium">
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
            </div>
            <Button className="h-11" onClick={handleAddTemplate}>
              <Plus className="w-4 h-4 mr-1" /> 添加
            </Button>
          </div>

          <div className="divide-y divide-slate-100 max-h-[300px] overflow-y-auto pr-1">
            {templates.map((template, index) => (
              <div
                key={`${template.itemType}-${template.serviceType}-${index}`}
                className="flex items-center justify-between py-3"
              >
                <div>
                  <span className="font-medium">{template.itemType}</span>
                  <span className="ml-2 text-xs text-slate-400">
                    {template.serviceType === "wash"
                      ? "水洗"
                      : template.serviceType === "dry_clean"
                        ? "干洗"
                        : "仅熨烫"}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-semibold text-blue-600">
                    {formatCurrency(template.price)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-red-400"
                    onClick={() => void handleDeleteTemplate(index)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
            {templates.length === 0 && (
              <p className="text-sm text-slate-400 py-4 text-center">
                暂无价格模板
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">外部数据导入</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-500">
            支持一键导入 Excel 中的历史客户及订单账目明细（支持 Master-Detail
            格式）。
          </p>
          <div className="flex gap-4">
            <Button
              variant="outline"
              onClick={handleImportCustomers}
              disabled={loading}
            >
              <Upload className="w-4 h-4 mr-2" /> 导入客户 Excel
            </Button>
            <Button
              variant="outline"
              onClick={handleImportOrders}
              disabled={loading}
            >
              <Upload className="w-4 h-4 mr-2" /> 导入订单 Excel
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">数据备份</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">自动备份</p>
              <p className="text-sm text-slate-500">
                每天凌晨 03:00 自动备份，保留最近 30 份。
              </p>
            </div>
            <Button variant="outline" onClick={handleBackup} disabled={loading}>
              <Database className="w-4 h-4 mr-2" /> 立即备份
            </Button>
          </div>
          <div className="space-y-2">
            {backups.map((backup) => (
              <div
                key={backup.path}
                className="rounded-xl bg-slate-50 px-4 py-3 text-sm"
              >
                <div className="font-medium">{backup.fileName}</div>
                <div className="text-slate-500">
                  {new Date(backup.createdAt).toLocaleString("zh-CN")} ·{" "}
                  {(backup.size / 1024).toFixed(1)} KB
                </div>
              </div>
            ))}
            {backups.length === 0 && (
              <p className="text-sm text-slate-400">暂无备份文件</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function yuanInputToCents(value: string): number {
  const normalized = value.trim();
  if (!normalized) return 0;
  const [yuan = "0", fraction = ""] = normalized.split(".");
  return Number(yuan) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}
