import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useState } from "react";

import type { CommandPort } from "../commands/types.js";

export function FulfillmentRackPanel({
  commandClient,
  onAssigned,
}: Readonly<{
  commandClient: CommandPort;
  onAssigned: () => Promise<void>;
}>) {
  const toast = useToast();
  const [barcode, setBarcode] = useState("");
  const [rackZone, setRackZone] = useState("");
  const [rackSlot, setRackSlot] = useState("");
  const [busy, setBusy] = useState(false);

  const assign = useCallback(async () => {
    const scanned = barcode.trim();
    const zone = rackZone.trim();
    const slot = rackSlot.trim();
    if (scanned.length === 0 || zone.length === 0 || slot.length === 0) {
      toast.push("请扫描衣物条码并填写货架分区与号位", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await commandClient.execute<unknown>("garment.rack.assign", {
        barcode: scanned,
        rack_zone: zone,
        rack_slot: slot,
      });
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      toast.push(`上架完成 ${zone.toUpperCase()}-${slot.toUpperCase()}`, "success");
      setBarcode("");
      setRackSlot("");
      await onAssigned();
    } finally {
      setBusy(false);
    }
  }, [barcode, commandClient, onAssigned, rackSlot, rackZone, toast]);

  return (
    <form
      className="ld-fulfillment__rack"
      aria-label="扫码上架"
      onSubmit={(event) => {
        event.preventDefault();
        void assign();
      }}
    >
      <Input
        name="rack-barcode"
        label="衣物条码"
        value={barcode}
        onChange={(event) => setBarcode(event.target.value)}
        hint="扫码枪回车立即上架；仅已完成衣物可上架"
        autoFocus
        disabled={busy}
      />
      <Input
        name="rack-zone"
        label="货架分区"
        value={rackZone}
        onChange={(event) => setRackZone(event.target.value)}
        disabled={busy}
      />
      <Input
        name="rack-slot"
        label="货架号位"
        value={rackSlot}
        onChange={(event) => setRackSlot(event.target.value)}
        disabled={busy}
      />
      <Button type="submit" disabled={busy}>
        {busy ? "上架中…" : "扫码上架"}
      </Button>
    </form>
  );
}
