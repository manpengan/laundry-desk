import { Button, Input } from "@laundry/ui";
import { useEffect, useRef, useState } from "react";
import {
  V1_MIGRATION_SOURCE_MAX_BYTES,
  V1_MIGRATION_PHOTO_MAX_BYTES,
  type V1MigrationPreview,
  type V1MigrationReview,
  type V1MigrationApproved,
} from "@laundry/contracts";
import type { MigrationPort } from "../host/migration-port.js";

type Props = Readonly<{ port: MigrationPort; sessionKey: string }>;
export function V1MigrationPanel({ port, sessionKey }: Props) {
  const [preview, setPreview] = useState<V1MigrationPreview | null>(null);
  const [review, setReview] = useState<V1MigrationReview | null>(null);
  const [approved, setApproved] = useState<V1MigrationApproved | null>(null);
  const [uploaded, setUploaded] = useState<readonly string[]>([]);
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setPreview(null);
    setReview(null);
    setApproved(null);
    setUploaded([]);
    setPassword("");
    setConfirmed(false);
    setError("");
    setBusy(false);
  }, [sessionKey]);
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    const value = generation.current;
    setBusy(true);
    setError("");
    try {
      await action(() => generation.current === value);
    } catch {
      if (generation.current === value) setError("读取文件失败，请重新选择文件。");
    } finally {
      if (generation.current === value) setBusy(false);
    }
  };
  const selectSource = (file: File | undefined) => {
    if (!file) return;
    if (file.size > V1_MIGRATION_SOURCE_MAX_BYTES) {
      setError("备份文件不能超过64 MiB。");
      return;
    }
    void run(async (current) => {
      const result = await port.draft(new Uint8Array(await file.arrayBuffer()));
      if (!current()) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result.data);
      setReview(null);
      setApproved(null);
      setUploaded([]);
      setConfirmed(false);
      setPassword("");
    });
  };
  const upload = (photoId: string, file: File | undefined) => {
    if (!file || !preview) return;
    if (file.size > V1_MIGRATION_PHOTO_MAX_BYTES) {
      setError("每张照片不能超过8 MiB。");
      return;
    }
    void run(async (current) => {
      const result = await port.photo(
        preview.draft_id,
        photoId,
        new Uint8Array(await file.arrayBuffer()),
      );
      if (!current()) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setUploaded((previous) => [...previous, photoId]);
      setReview(null);
    });
  };
  const verify = () =>
    void run(async (current) => {
      if (!preview) return;
      const result = await port.review(preview.draft_id);
      if (!current()) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReview(result.data);
    });
  const approve = () =>
    void run(async (current) => {
      if (!review || !confirmed) return;
      try {
        const result = await port.authorize(review.draft_id, {
          source_sha256: review.source_sha256,
          plan_sha256: review.plan_sha256,
          photos_sha256: review.photos_sha256,
          photo_associations_reviewed: true,
          password,
        });
        if (!current()) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setApproved(result.data);
      } finally {
        setPassword("");
      }
    });
  const formatMoney = (cents: number) => (cents / 100).toFixed(2);
  return (
    <section aria-label="旧版数据迁移" className="space-y-4">
      <h3 className="text-base font-semibold">旧版数据迁移</h3>
      <p className="text-sm text-[var(--color-text-secondary)]">
        选择已停止旧系统并完成检查的SQLite备份。先核对数据和照片，再授权维护程序导入；目标门店必须尚无顾客和订单。
      </p>
      <label className="block text-sm">
        旧版备份文件
        <input
          className="mt-2 block max-w-full"
          type="file"
          accept=".db,.sqlite,.sqlite3"
          disabled={busy}
          onChange={(event) => selectSource(event.target.files?.[0])}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      {preview && (
        <>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt>顾客</dt>
              <dd>{preview.report.target.customers}</dd>
            </div>
            <div>
              <dt>订单／衣物</dt>
              <dd>
                {preview.report.target.orders}／{preview.report.target.garments}
              </dd>
            </div>
            <div>
              <dt>应收／已收（元）</dt>
              <dd>
                {formatMoney(preview.report.target.receivableCents)}／
                {formatMoney(preview.report.target.paidCents)}
              </dd>
            </div>
            <div>
              <dt>欠款（元）</dt>
              <dd>{formatMoney(preview.report.target.debtCents)}</dd>
            </div>
          </dl>
          <p className="text-sm">
            数量和金额核对：零差异。
            {preview.reassigned_pickup_codes > 0
              ? `有 ${preview.reassigned_pickup_codes} 个重复旧取衣码，将生成唯一新码；旧码保留在历史资料，仍可用原订单号查询。`
              : ""}
            {preview.warnings.length > 0
              ? `有${preview.warnings.length}项原始日期缺失，将保留原记录并使用明确的历史替代时间。`
              : ""}
          </p>
          {preview.photos.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm">
                旧版照片属于整单，导入后关联该单第一件衣物。请按原路径选择照片并核对这种关联。
              </p>
              {preview.photos.map((photo) => (
                <label key={photo.id} className="block break-all text-sm">
                  {photo.source_relative_path} {uploaded.includes(photo.id) ? "（已上传）" : ""}
                  <input
                    className="mt-1 block max-w-full"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={busy || uploaded.includes(photo.id) || approved !== null}
                    onChange={(event) => upload(photo.id, event.target.files?.[0])}
                  />
                </label>
              ))}
            </div>
          )}
          <p className="text-sm">
            历史资料：员工 {preview.history.staffs} 条、短信 {preview.history.sms} 条、审计{" "}
            {preview.history.audit} 条。 旧账号的 {preview.history.excluded_credentials}{" "}
            份密码凭据不会复制或启用；历史短信不会重发，历史审计不作当前操作账本。
            为保护旧日志中可能混杂的个人信息，任一顾客被匿名化时，将清除本店全部导入审计及无法归属顾客的历史短信。
          </p>
          {!approved && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy || uploaded.length !== preview.photos.length}
              onClick={verify}
            >
              核对全部照片
            </Button>
          )}
        </>
      )}
      {review && !approved && (
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已核对数量、金额、日期、照片关联和历史资料清除规则，授权导入这份备份。
          </label>
          <Input
            type="password"
            value={password}
            autoComplete="current-password"
            aria-label="当前管理员密码"
            placeholder="输入当前管理员密码"
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button
            type="button"
            variant="primary"
            disabled={busy || !confirmed || !password}
            onClick={approve}
          >
            生成一次性导入授权
          </Button>
        </div>
      )}
      {approved && (
        <div role="status" className="space-y-2 rounded border p-3 text-sm">
          <p>
            已授权。请在Windows安装与维护窗口选择“导入旧版数据”，输入下面的授权编号。维护程序会先备份，再导入并核对。
          </p>
          <code className="block break-all select-all">{approved.request_id}</code>
          <p>
            有效至 {new Date(approved.expires_at).toLocaleTimeString("zh-CN")}
            。请保持当前管理员会话有效。
          </p>
        </div>
      )}
      {busy && (
        <p role="status" className="text-sm">
          正在处理，请稍候…
        </p>
      )}
    </section>
  );
}
