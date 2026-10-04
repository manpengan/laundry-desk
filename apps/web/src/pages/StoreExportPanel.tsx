import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@laundry/ui";
import type { StoreExportApproved, StoreExportPreview } from "@laundry/contracts";
import type { StoreExportPort } from "../host/store-export-port.js";
export function StoreExportPanel({
  port,
  sessionKey,
}: Readonly<{ port: StoreExportPort; sessionKey: string }>) {
  const [preview, setPreview] = useState<StoreExportPreview | null>(null);
  const [approved, setApproved] = useState<StoreExportApproved | null>(null);
  const [password, setPassword] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setPreview(null);
    setApproved(null);
    setPassword("");
    setAcknowledged(false);
    setError("");
    setBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [sessionKey, port]);
  const load = async () => {
    const current = generation.current;
    setBusy(true);
    setError("");
    setApproved(null);
    const result = await port.preview();
    if (current !== generation.current) return;
    setBusy(false);
    if (result.ok) setPreview(result.data);
    else setError(result.error);
  };
  const approve = async () => {
    if (!preview || !acknowledged || !password || busy) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    const secret = password;
    setPassword("");
    const result = await port.authorize({
      password: secret,
      policy_sha256: preview.policy_sha256,
      privacy_acknowledged: true,
    });
    if (current !== generation.current) return;
    setBusy(false);
    if (result.ok) setApproved(result.data);
    else setError(result.error);
  };
  return (
    <section className="ld-settings-section lg-card ld-panel" aria-label="整店业务导出">
      <header className="ld-settings-section__head">
        <h2>整店业务导出</h2>
        <p>
          导出当前门店全部业务记录、组织共享的顾客和会员资料，以及衣物照片、配送凭证。需要管理员兼隐私管理员权限。
        </p>
      </header>
      <div className="ld-panel__actions">
        <Button variant="secondary" disabled={busy} onClick={() => void load()}>
          查看导出范围
        </Button>
      </div>
      {preview && (
        <div className="ld-panel__sub">
          <p className="ld-panel__lead">
            共 {preview.table_count} 类业务记录。导出包包含字段字典、逐表行数、完整照片与校验清单。
          </p>
          <details className="ld-panel__advanced">
            <summary>查看不导出的凭据与执行状态</summary>
            <ul className="ld-panel__list">
              {preview.excluded_tables.map((table) => (
                <li className="ld-panel__item" key={table.name}>
                  {table.reason}
                  <span className="ld-panel__meta">{table.name}</span>
                </li>
              ))}
            </ul>
          </details>
          <label className="ld-panel__check">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            我确认导出包含顾客个人资料，并会将导出包保存在受控位置。
          </label>
          <div className="ld-panel__row">
            <Input
              name="store-export-password"
              label="当前管理员密码"
              type="password"
              autoComplete="current-password"
              value={password}
              maxLength={1024}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button disabled={busy || !password || !acknowledged} onClick={() => void approve()}>
              生成一次性导出授权
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="ld-panel__note ld-panel__note--warn" role="alert">
          {error}
        </p>
      )}
      {approved && (
        <div role="status" className="ld-panel__sub">
          <p className="ld-panel__lead">授权编号（只能使用一次）：</p>
          <p className="ld-panel__code">{approved.request_id}</p>
          <p className="ld-panel__lead">
            请在 {new Date(approved.expires_at).toLocaleTimeString()} 前打开 Windows
            维护工具，选择“完整门店导出”，粘贴授权编号并选择新的导出文件夹。维护工具会暂停柜台，完成导出与校验后恢复。
          </p>
          <p className="ld-panel__lead">完成后请保留维护工具显示的校验值，用于验证导出包。</p>
        </div>
      )}
    </section>
  );
}
