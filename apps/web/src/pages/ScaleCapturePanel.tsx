import { Button } from "@laundry/ui";
import { useEffect, useRef, useState } from "react";
import { ScaleReadInputSchema, type ScaleReading } from "@laundry/contracts";
import type { ScalePort } from "../host/scale-port.js";

export function ScaleCapturePanel({
  port,
  disabled,
  onApply,
}: Readonly<{
  port: ScalePort;
  disabled: boolean;
  onApply: (reading: ScaleReading) => boolean;
}>) {
  const [ports, setPorts] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState("");
  const [baud, setBaud] = useState("2400");
  const [framing, setFraming] = useState("7E1");
  const [reading, setReading] = useState<ScaleReading | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  useEffect(() => {
    setReading(null);
  }, [selected, baud, framing]);
  const run = async (kind: "ports" | "read") => {
    const current = ++generation.current;
    setBusy(true);
    setReading(null);
    setMessage("");
    try {
      if (kind === "ports") {
        const response = await port.ports();
        if (generation.current !== current) return;
        if (!response.ok) {
          setMessage(response.error);
          return;
        }
        setPorts(response.data);
        setSelected(response.data[0] ?? "");
        if (response.data.length === 0) setMessage("未发现串口。连接电子秤后刷新。");
      } else {
        const input = ScaleReadInputSchema.safeParse({
          operation: "read",
          port: selected,
          baud: Number(baud),
          framing,
        });
        if (!input.success) {
          setMessage("请选择串口并核对秤上的通信参数。");
          return;
        }
        const response = await port.read(input.data);
        if (generation.current !== current) return;
        if (response.ok) setReading(response.data);
        else setMessage(response.error);
      }
    } catch {
      if (generation.current === current) setMessage("读取电子秤失败，请重试。");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  return (
    <fieldset disabled={disabled || busy} aria-label="电子秤称重">
      <legend>电子秤称重</legend>
      <p>支持 A&amp;D 标准 ASCII 串口输出。请设置为连续发送；稳定读数须在 30 秒内确认记录。</p>
      <Button type="button" variant="secondary" onClick={() => void run("ports")}>
        刷新串口
      </Button>
      <label>
        串口
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">请选择</option>
          {ports.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <label>
        波特率
        <select value={baud} onChange={(e) => setBaud(e.target.value)}>
          {[1200, 2400, 4800, 9600, 19200, 38400].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <label>
        数据格式
        <select value={framing} onChange={(e) => setFraming(e.target.value)}>
          {["7E1", "7O1", "8N1"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        variant="secondary"
        disabled={!selected}
        onClick={() => void run("read")}
      >
        {busy ? "读取中…" : "读取稳定重量"}
      </Button>
      {reading && (
        <p>
          {reading.basis === "gross" ? "毛重" : reading.basis === "net" ? "净重" : "重量"}：
          {reading.grams} 克{" "}
          <Button
            type="button"
            onClick={() => {
              if (onApply(reading)) {
                setReading(null);
                setMessage("称重已写入订单备注，随开单或挂单保存。");
              } else {
                setReading(null);
                setMessage("读数已过期或备注过长，请重新读取后记录。");
              }
            }}
          >
            记录到订单
          </Button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </fieldset>
  );
}
