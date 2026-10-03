import { useEffect, useRef, useState } from "react";
import { Button } from "@laundry/ui";
import type { AiOperationPreview } from "@laundry/contracts";
import type { AiPanelPort } from "../host/ai-port.js";

export function AiOperationCard({
  preview,
  port,
}: Readonly<{ preview: AiOperationPreview; port: AiPanelPort }>) {
  const [reviewed, setReviewed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [status, setStatus] = useState("");
  const [csv, setCsv] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const confirm = async () => {
    if (!reviewed || submitted || port.confirmOperation === undefined) return;
    setSubmitted(true);
    setStatus("正在确认…");
    try {
      const result = await port.confirmOperation(preview.confirm_ref);
      if (!mounted.current) return;
      if (result.ok) {
        setStatus("操作已完成。请核对业务页面。");
        setCsv(result.data.csv ?? null);
      } else setStatus("操作未能确认。请先核对业务状态，再重新预览；此卡不重复提交。");
    } catch {
      if (mounted.current) setStatus("连接中断，结果未知。请先核对业务状态；此卡不重复提交。");
    }
  };
  const download = () => {
    if (csv === null) return;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "pickup-reminders.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section aria-label="待人工确认的操作">
      <strong>待确认：{preview.command}</strong>
      <p>{preview.summary}</p>
      <p>有效至 {new Date(preview.expires_at).toLocaleTimeString()}。此卡尚未执行业务操作。</p>
      <label>
        <input
          type="checkbox"
          checked={reviewed}
          disabled={submitted}
          onChange={(event) => setReviewed(event.currentTarget.checked)}
        />
        我已核对上述对象与内容
      </label>
      <Button
        type="button"
        disabled={
          !reviewed ||
          submitted ||
          port.confirmOperation === undefined ||
          Date.parse(preview.expires_at) <= Date.now()
        }
        onClick={() => void confirm()}
      >
        确认执行
      </Button>
      {status ? <p role="status">{status}</p> : null}
      {csv === null ? null : (
        <Button type="button" onClick={download}>
          下载手工联系清单
        </Button>
      )}
    </section>
  );
}
