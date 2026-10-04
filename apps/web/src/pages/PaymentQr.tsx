import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";
import type { ChannelIntent } from "@laundry/contracts";
import { paymentQrAllowed } from "./payment-channel-model.js";
export function PaymentQr({ intent }: Readonly<{ intent: ChannelIntent }>) {
  const [source, setSource] = useState<string | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setSource(null);
    setFailed(false);
    if (!paymentQrAllowed(intent) || !intent.qr_url) return;
    const timer = setTimeout(
      () => {
        live = false;
        setSource(null);
      },
      Math.max(0, Date.parse(intent.expires_at) - Date.now()),
    );
    void toDataURL(intent.qr_url, { width: 256, margin: 4, errorCorrectionLevel: "M" }).then(
      (value) => {
        if (live) setSource(value);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [intent]);
  return (
    <>
      {source && (
        <img
          src={source}
          width={256}
          height={256}
          alt={intent.channel === "wechat" ? "微信支付收款码" : "支付宝收款码"}
        />
      )}
      {failed && <p role="alert">二维码生成失败，请刷新该笔支付状态。</p>}
    </>
  );
}
