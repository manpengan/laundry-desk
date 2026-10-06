import { Button } from "@laundry/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MigrationPort } from "../host/migration-port.js";
import {
  matchMigrationPhotos,
  migrationPhotoFileError,
  migrationPhotoFileLabel,
  type MigrationPhotoTarget,
} from "./migration-photo-matching.js";
const PAGE_SIZE = 25;
const MAX_FILES = 5000;
type Props = Readonly<{
  draftId: string;
  photos: readonly MigrationPhotoTarget[];
  uploaded: readonly string[];
  port: MigrationPort;
  disabled: boolean;
  onUploaded: (photoId: string) => void;
  onBusyChange: (busy: boolean) => void;
}>;
export function V1MigrationPhotos(props: Props) {
  return <MigrationPhotosForDraft key={props.draftId} {...props} />;
}
function MigrationPhotosForDraft({
  draftId,
  photos,
  uploaded,
  port,
  disabled,
  onUploaded,
  onBusyChange,
}: Props) {
  const [files, setFiles] = useState<readonly File[]>([]);
  const [choices, setChoices] = useState<Readonly<Record<string, number | null>>>({});
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [port],
  );
  const plan = useMemo(() => matchMigrationPhotos(photos, files), [photos, files]);
  const selected = (photoId: string) =>
    Object.hasOwn(choices, photoId)
      ? (choices[photoId] ?? null)
      : (plan.matches.find((row) => row.target.id === photoId)?.selected ?? null);
  const ready = plan.matches.filter(
    (row) => !uploaded.includes(row.target.id) && selected(row.target.id) !== null,
  );
  const chooseFiles = (incoming: FileList | null) => {
    if (incoming === null || incoming.length === 0 || running.current) return;
    if (incoming.length > MAX_FILES) {
      setMessage(`一次最多选择 ${MAX_FILES} 个文件，请分批选择。`);
      return;
    }
    setFiles(Array.from(incoming));
    setChoices({});
    setFailures({});
    setConfirmed(false);
    setPage(0);
    setMessage("");
  };
  const attach = (id: string, file: File | undefined) => {
    if (file === undefined || running.current) return;
    const error = migrationPhotoFileError(file);
    if (error !== null) {
      setMessage(error);
      return;
    }
    if (files.length >= MAX_FILES) {
      setMessage(`一次最多选择 ${MAX_FILES} 个文件，请分批选择。`);
      return;
    }
    setChoices((previous) => ({ ...previous, [id]: files.length }));
    setFiles((previous) => [...previous, file]);
    setConfirmed(false);
    setMessage("");
  };
  const upload = async (ids: readonly string[]) => {
    if (running.current || disabled || !confirmed) return;
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    const scope = generation.current;
    let succeeded = 0;
    try {
      for (const id of ids) {
        const index = selected(id),
          file = index === null ? undefined : files[index];
        if (file === undefined || uploaded.includes(id)) continue;
        let error = migrationPhotoFileError(file);
        if (error === null) {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (scope !== generation.current) return;
            const result = await port.photo(draftId, id, bytes);
            if (scope !== generation.current) return;
            if (result.ok) {
              onUploaded(id);
              succeeded++;
            } else error = result.error;
          } catch {
            error = "上传失败，可保留当前匹配后重试。";
          }
        }
        if (scope !== generation.current) return;
        setFailures((previous) => ({ ...previous, [id]: error ?? "" }));
      }
      setMessage(`本次已上传 ${succeeded} 张；失败项可按原照片编号重试。`);
    } finally {
      if (scope === generation.current) {
        running.current = false;
        setBusy(false);
        onBusyChange(false);
      }
    }
  };
  const totalPages = Math.max(1, Math.ceil(photos.length / PAGE_SIZE));
  return (
    <section className="ld-panel__sub" aria-label="迁移照片批量匹配">
      <p className="ld-panel__lead">
        旧版照片属于整单，导入后关联该单第一件衣物。请核对原路径与目标衣物；同名冲突不会自动确认。
      </p>
      <div className="ld-panel__row">
        <label className="ld-field">
          <span>选择照片目录</span>
          <input
            type="file"
            multiple
            {...{ webkitdirectory: "", directory: "" }}
            disabled={disabled || busy}
            onChange={(event) => {
              chooseFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </label>
        <label className="ld-field">
          <span>或批量选择照片</span>
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled || busy}
            onChange={(event) => {
              chooseFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>
      <p role="status">
        已上传 {uploaded.length}/{photos.length}；可匹配 {ready.length}；同名待选{" "}
        {
          plan.matches.filter(
            (row) =>
              row.state === "ambiguous" &&
              !uploaded.includes(row.target.id) &&
              selected(row.target.id) === null,
          ).length
        }
        ；缺失{" "}
        {
          plan.matches.filter(
            (row) =>
              row.state === "missing" &&
              !uploaded.includes(row.target.id) &&
              selected(row.target.id) === null,
          ).length
        }
        。
      </p>
      {message ? <p role="status">{message}</p> : null}
      {plan.rejected.length + plan.unmatched.length > 0 ? (
        <details>
          <summary>未采用的文件（{plan.rejected.length + plan.unmatched.length}）</summary>
          <ul>
            {plan.rejected.slice(0, 50).map((row) => (
              <li key={row.index}>
                {migrationPhotoFileLabel(files[row.index]!)}：{row.reason}
              </li>
            ))}
            {plan.unmatched.slice(0, 50).map((index) => (
              <li key={index}>
                {migrationPhotoFileLabel(files[index]!)}：没有对应的旧版照片，可人工选择匹配。
              </li>
            ))}
            {plan.rejected.length > 50 || plan.unmatched.length > 50 ? (
              <li>每类显示前 50 项，可按目录分批选择后核对。</li>
            ) : null}
          </ul>
        </details>
      ) : null}
      <ul className="ld-panel__list">
        {plan.matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row) => {
          const id = row.target.id,
            index = selected(id),
            done = uploaded.includes(id);
          return (
            <li className="ld-panel__item" key={id}>
              <span>
                {row.target.source_relative_path} {done ? "（已上传）" : ""}
              </span>
              <details>
                <summary>核对关联编号</summary>
                <small>
                  照片编号：{id}；目标衣物：{row.target.garment_id}
                </small>
              </details>
              {!done ? (
                <label>
                  匹配文件
                  <select
                    aria-label={`匹配 ${row.target.source_relative_path}`}
                    value={index ?? ""}
                    disabled={disabled || busy}
                    onChange={(event) => {
                      const value =
                        event.currentTarget.value === "" ? null : Number(event.currentTarget.value);
                      if (
                        value === null ||
                        (Number.isSafeInteger(value) && files[value] !== undefined)
                      ) {
                        setChoices((previous) => ({ ...previous, [id]: value }));
                        setConfirmed(false);
                      }
                    }}
                  >
                    <option value="">请选择文件</option>
                    {[...new Set([...row.candidates, ...(index === null ? [] : [index])])].map(
                      (fileIndex) => (
                        <option key={fileIndex} value={fileIndex}>
                          {migrationPhotoFileLabel(files[fileIndex]!)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              ) : null}
              {!done ? (
                <label>
                  人工选择文件
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label={`人工匹配 ${row.target.source_relative_path}`}
                    disabled={disabled || busy}
                    onChange={(event) => {
                      attach(id, event.currentTarget.files?.[0]);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              ) : null}
              {!done && failures[id] ? (
                <p role="alert">
                  {failures[id]}{" "}
                  <Button
                    disabled={disabled || busy || !confirmed}
                    onClick={() => void upload([id])}
                  >
                    重试此照片
                  </Button>
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {totalPages > 1 ? (
        <div className="ld-panel__actions">
          <Button disabled={page === 0 || busy} onClick={() => setPage((value) => value - 1)}>
            上一页照片
          </Button>
          <span>
            第 {page + 1}/{totalPages} 页
          </span>
          <Button
            disabled={page + 1 === totalPages || busy}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页照片
          </Button>
        </div>
      ) : null}
      <label className="ld-panel__check">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled || busy}
          onChange={(event) => setConfirmed(event.currentTarget.checked)}
        />
        我已核对本批原路径、匹配文件和目标衣物关联。
      </label>
      <Button
        disabled={disabled || busy || !confirmed || ready.length === 0}
        onClick={() => void upload(ready.map((row) => row.target.id))}
      >
        {busy ? "正在上传照片…" : `上传已确认的 ${ready.length} 张照片`}
      </Button>
    </section>
  );
}
