import { useEffect, useState } from "react";
import { Database, Save } from "lucide-react";
import type { BackupInfoDto } from "@shared/index";
import { Button } from "../components/ui/Button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/Card";
import { Input } from "../components/ui/Input";

export default function Settings() {
  const [shopName, setShopName] = useState("");
  const [backups, setBackups] = useState<BackupInfoDto[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    window.api.settings.get<string>("shop.name").then((response) => {
      if (response.ok) setShopName(response.data ?? "");
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

  return (
    <div className="max-w-2xl mx-auto space-y-6">
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
                  {new Date(backup.createdAt).toLocaleString()} ·{" "}
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
