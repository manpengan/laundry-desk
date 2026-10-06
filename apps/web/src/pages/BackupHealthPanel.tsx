import { useEffect, useRef, useState } from "react";
import { Button } from "@laundry/ui";
import type { MaintenanceHealth } from "@laundry/contracts";
import type { MaintenancePort } from "../host/maintenance-port.js";
const MESSAGES: Readonly<Record<MaintenanceHealth["alerts"][number], string>> = {
  backup_disabled: "自动备份已关闭，请到维护程序开启。",
  low_space: "磁盘空间不足，请释放空间后备份。",
  interrupted: "上次备份中断，请到维护程序检查并恢复。",
  last_run_failed: "上次计划备份失败，请检查记录后重试。",
  backup_overdue: "最近成功备份已超时，建议尽快备份。",
  drill_overdue: "恢复演练缺失或已过期，请验证备份能否恢复。",
  task_missing: "自动备份任务缺失或已被禁用，请重新保存计划。",
  task_unavailable: "无法确认计划任务状态，请到维护程序检查。",
  offsite_overdue: "近 7 天没有加密离机副本，请备份到 U 盘或 NAS。",
};
const time = (value: string | null) =>
  value === null ? "暂无可确认记录" : new Date(value).toLocaleString("zh-CN");
export function BackupHealthPanel({
  port,
  canMaintain,
  sessionKey,
}: Readonly<{ port?: MaintenancePort; canMaintain: boolean; sessionKey: string }>) {
  const [health, setHealth] = useState<MaintenanceHealth | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const generation = useRef(0),
    running = useRef(false);
  const load = async () => {
    if (port === undefined || running.current) return;
    const scope = generation.current;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await port.health();
      if (scope !== generation.current) return;
      if (result.ok) setHealth(result.data);
      else {
        setHealth(null);
        setError(result.error);
      }
    } catch {
      if (scope === generation.current) {
        setHealth(null);
        setError("读取备份状态失败，请重试。");
      }
    } finally {
      if (scope === generation.current) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    generation.current++;
    running.current = false;
    setHealth(null);
    setError("");
    setMessage("");
    setBusy(false);
    // Reads happen only from an explicit refresh, avoiding hidden settings panes starting native work.
    return () => {
      generation.current++;
    };
  }, [port, sessionKey]);
  const open = async (intent: "maintenance" | "backup" | "drill") => {
    if (port === undefined || running.current || !canMaintain) return;
    const scope = generation.current;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await port.open(intent);
      if (scope !== generation.current) return;
      if (result.ok) setMessage("维护窗口已打开，请在窗口中确认操作。完成后回到此处刷新状态。");
      else setError(result.error);
    } catch {
      if (scope === generation.current) setError("未能打开维护窗口，请重试。");
    } finally {
      if (scope === generation.current) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section className="ld-settings-section lg-card ld-panel" aria-label="备份与恢复">
      <header className="ld-settings-section__head">
        <h2>备份与恢复</h2>
        <p>核对本机备份、离机副本和恢复演练。维护期间请先退出柜台业务操作。</p>
      </header>
      {port === undefined ? (
        <p role="status" className="ld-panel__note ld-panel__note--warn">
          当前 Web 环境无法读取本机备份状态。请在 Windows 桌面版打开此页，或从开始菜单打开 Laundry
          Desk Runtime 维护程序。
        </p>
      ) : (
        <>
          <Button disabled={busy} onClick={() => void load()}>
            刷新备份状态
          </Button>
          {health === null ? (
            <p role="status">{busy ? "正在读取本机状态…" : "尚未确认备份状态，请刷新查看。"}</p>
          ) : (
            <>
              <p
                className={`ld-panel__note ${health.alerts.length === 0 ? "ld-panel__note--ok" : "ld-panel__note--warn"}`}
                role="status"
              >
                {health.alerts.length === 0
                  ? "最近备份、离机副本和演练记录符合计划。"
                  : "备份需要关注，请处理以下提醒。"}
              </p>
              <dl className="ld-panel__grid ld-panel__stats">
                <div>
                  <dt>最近成功备份</dt>
                  <dd>{time(health.last_backup_at)}</dd>
                </div>
                <div>
                  <dt>最近恢复演练</dt>
                  <dd>{time(health.last_drill_at)}</dd>
                </div>
                <div>
                  <dt>最近离机副本</dt>
                  <dd>{time(health.last_offsite_at)}</dd>
                </div>
                <div>
                  <dt>下次计划</dt>
                  <dd>{health.enabled ? time(health.next_backup_at) : "自动备份已关闭"}</dd>
                </div>
                <div>
                  <dt>可用空间</dt>
                  <dd>{health.free_mib.toLocaleString()} MiB</dd>
                </div>
                <div>
                  <dt>状态核对时间</dt>
                  <dd>{time(health.checked_at)}</dd>
                </div>
              </dl>
              {health.alerts.length > 0 ? (
                <ul>
                  {health.alerts.map((alert) => (
                    <li key={alert}>{MESSAGES[alert]}</li>
                  ))}
                </ul>
              ) : null}
              {health.latest?.code ? (
                <p role="alert">
                  最近计划失败代码：{health.latest.code}（{time(health.latest.at)}）
                </p>
              ) : null}
            </>
          )}
          {canMaintain ? (
            <div className="ld-panel__actions">
              <Button disabled={busy} onClick={() => void open("maintenance")}>
                打开维护程序
              </Button>
              <Button disabled={busy} onClick={() => void open("backup")}>
                创建本机备份
              </Button>
              <Button disabled={busy} onClick={() => void open("drill")}>
                恢复演练
              </Button>
            </div>
          ) : (
            <p>请联系店长或管理员执行备份维护。</p>
          )}
        </>
      )}
      {error ? (
        <p role="alert" className="ld-panel__note ld-panel__note--warn">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
