import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

const IDLE_HINT = "输入 4 位取件码，立即定位订单";

export function PickupKeypad() {
  const nav = useNavigate();
  const [buf, setBuf] = useState("");
  const [phase, setPhase] = useState<"idle" | "win" | "miss">("idle");
  const [hint, setHint] = useState(IDLE_HINT);
  const lock = useRef(false);

  const search = async (code: string): Promise<void> => {
    lock.current = true;
    const res = await window.api.orders.searchForPickup(code);
    const hit = res.ok
      ? res.data.find(
          (r) =>
            r.pickupCode === code &&
            r.status !== "picked_up" &&
            r.status !== "cancelled",
        )
      : undefined;
    if (hit) {
      setPhase("win");
      setHint(`命中：${hit.customerName} · ${hit.orderNo}`);
      setTimeout(() => nav(`/orders/${hit.id}`), 480);
      return;
    }
    setPhase("miss");
    setHint(`未找到取件码 ${code}，请核对后重试`);
    setTimeout(() => {
      setBuf("");
      setPhase("idle");
      setHint(IDLE_HINT);
      lock.current = false;
    }, 1400);
  };

  const press = (k: string): void => {
    if (lock.current) return;
    if (k === "clear") {
      setBuf("");
      return;
    }
    if (k === "back") {
      setBuf((b) => b.slice(0, -1));
      return;
    }
    if (buf.length >= 4) return;
    const next = buf + k;
    setBuf(next);
    if (next.length === 4) void search(next);
  };

  const keys = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "clear",
    "0",
    "back",
  ];
  const slotCls = (i: number): string =>
    phase === "win"
      ? "win"
      : phase === "miss"
        ? "miss"
        : i < buf.length
          ? "fill"
          : "";

  return (
    <div className="lg-card lg-spec rounded-[22px]">
      <div className="px-5 pb-1 pt-4">
        <h3 className="text-[16px] font-semibold tracking-[-0.01em]">
          快速取件
        </h3>
      </div>
      <div className="my-3.5 flex justify-center gap-2.5">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`lg-slot ${slotCls(i)}`}>
            {buf[i] ?? ""}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 px-4">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            className={`lg-key lg-pressable ${k === "clear" || k === "back" ? "fn" : ""}`}
          >
            {k === "clear" ? "清空" : k === "back" ? "⌫" : k}
          </button>
        ))}
      </div>
      <p className="px-4 pb-4 pt-3 text-center text-[12px] text-[var(--lg-ink3)]">
        {hint}
      </p>
    </div>
  );
}
