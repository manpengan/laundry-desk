import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@laundry/ui";
import type { AiVisionCandidate, AiVisionResult } from "@laundry/contracts";
import type { VisionPort } from "./vision-port.js";
import { prepareVisionPhoto } from "./vision-image.js";

export function VisionPanel({ port }: Readonly<{ port: VisionPort }>) {
  const [mode, setMode] = useState<"assist" | "match">("assist");
  const [image, setImage] = useState("");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<readonly AiVisionCandidate[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [consent, setConsent] = useState(false);
  const [result, setResult] = useState<AiVisionResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
      active.current?.abort();
    },
    [],
  );
  const invalidate = () => {
    setConsent(false);
    setResult(null);
    setError("");
  };
  const choose = async (file: File | undefined) => {
    if (!file) return;
    const current = ++generation.current;
    invalidate();
    setImage("");
    setBusy(true);
    try {
      const encoded = await prepareVisionPhoto(file);
      if (current === generation.current) setImage(encoded);
    } catch (failure) {
      if (current === generation.current)
        setError(failure instanceof Error ? failure.message : "照片处理失败。");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const search = async () => {
    if (!query.trim() || busy) return;
    invalidate();
    setSelected([]);
    setCandidates([]);
    setBusy(true);
    const controller = new AbortController();
    active.current = controller;
    const response = await port.candidates(query, controller.signal);
    if (controller.signal.aborted) return;
    active.current = null;
    setBusy(false);
    if (response.ok) setCandidates(response.data);
    else setError(response.error);
  };
  const analyze = async () => {
    if (!consent || !image || busy || (mode === "match" && selected.length === 0)) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setResult(null);
    setConsent(false);
    const response = await port.analyze(
      {
        request_id: crypto.randomUUID(),
        mode,
        image_base64: image,
        consent: true,
        candidates:
          mode === "assist"
            ? []
            : candidates
                .filter((photo) => selected.includes(photo.photo_id))
                .map(({ photo_id, sha256 }) => ({ photo_id, sha256 })),
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    active.current = null;
    setBusy(false);
    if (response.ok) setResult(response.data);
    else setError(response.error);
  };
  return (
    <details className="ld-panel__sub ld-panel__advanced">
      <summary>衣物图片辅助 / 掉标找衣</summary>
      <div className="ld-panel">
        <p className="ld-panel__lead">
          仅提供外观建议。请先裁剪掉人物、票据和顾客资料；认领、取衣和衣物信息仍由员工核验。
        </p>
        <label className="ld-field">
          <span className="ld-field__label">用途</span>
          <select
            className="ld-input"
            disabled={busy}
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as "assist" | "match");
              invalidate();
            }}
          >
            <option value="assist">衣物外观辅助</option>
            <option value="match">掉标候选比较</option>
          </select>
        </label>
        <label className="ld-field">
          <span className="ld-field__label">目标衣物照片</span>
          <input
            className="ld-input"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </label>
        {image && (
          <img
            src={`data:image/jpeg;base64,${image}`}
            alt="本次目标衣物"
            className="ld-vision__target"
          />
        )}
        {mode === "match" && (
          <div className="ld-panel">
            <div className="ld-panel__row">
              <Input
                name="vision-candidate-query"
                label="候选票号或条码"
                value={query}
                maxLength={64}
                disabled={busy}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button
                variant="secondary"
                disabled={busy || !query.trim()}
                onClick={() => void search()}
              >
                读取本店候选照片
              </Button>
            </div>
            <p className="ld-panel__meta">
              最多显示 6 张，请选择至多 2 张比较。查询照片只在本机完成。
            </p>
            {candidates.map((photo) => (
              <label key={photo.photo_id} className="ld-panel__check">
                <input
                  type="checkbox"
                  checked={selected.includes(photo.photo_id)}
                  disabled={busy || (!selected.includes(photo.photo_id) && selected.length >= 2)}
                  onChange={() => {
                    setSelected((prior) =>
                      prior.includes(photo.photo_id)
                        ? prior.filter((id) => id !== photo.photo_id)
                        : [...prior, photo.photo_id],
                    );
                    invalidate();
                  }}
                />
                <img
                  src={`data:image/jpeg;base64,${photo.thumbnail_base64}`}
                  alt={`候选衣物 ${photo.barcode}`}
                  className="ld-vision__thumb"
                />
                <span>
                  {photo.ticket_no} / {photo.barcode}
                </span>
              </label>
            ))}
          </div>
        )}
        <label className="ld-panel__check">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy}
            onChange={(event) => setConsent(event.target.checked)}
          />
          我同意将本次目标照片{mode === "match" ? "及已选候选照片" : ""}发送给已配置的 AI
          供应商进行分析。
        </label>
        <div className="ld-panel__actions">
          <Button
            disabled={busy || !consent || !image || (mode === "match" && selected.length === 0)}
            onClick={() => void analyze()}
          >
            分析本次照片
          </Button>
          {busy && (
            <Button
              variant="ghost"
              onClick={() => {
                generation.current += 1;
                active.current?.abort();
                active.current = null;
                setBusy(false);
                setError("本次分析已停止。");
              }}
            >
              停止
            </Button>
          )}
        </div>
        {error && (
          <p className="ld-panel__note ld-panel__note--warn" role="alert">
            {error}
          </p>
        )}
        {result && (
          <div className="ld-panel__note" role="status">
            <p>
              外观建议：{result.analysis.category}；{result.analysis.colors.join("、")}；
              {result.analysis.visible_marks.join("、")}
            </p>
            {result.analysis.comparisons.map((comparison) => {
              const binding = result.candidates[comparison.candidate_index - 1];
              const photo = candidates.find(
                (candidate) => candidate.photo_id === binding?.photo_id,
              );
              return (
                <p key={comparison.candidate_index}>
                  {photo?.ticket_no} / {photo?.barcode}：{comparison.similarity}（
                  {comparison.reasons.join("、")}）
                </p>
              );
            })}
            <p>图片可能遗漏细节。请对照实物和票据人工核验，以上结果不会更改订单或发送通知。</p>
          </div>
        )}
      </div>
    </details>
  );
}
