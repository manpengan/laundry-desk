import { useMemo } from "react";
import { useReceiveWorkspace } from "./ReceiveWorkspace.js";
import type { ReceiveWorkspaceState } from "./receive-workspace.js";

export function useReceiveForm() {
  const workspace = useReceiveWorkspace();
  const { store } = workspace;
  const setters = useMemo(() => {
    const field =
      <K extends keyof ReceiveWorkspaceState>(key: K, dirty = true) =>
      (
        value:
          | ReceiveWorkspaceState[K]
          | ((current: ReceiveWorkspaceState[K]) => ReceiveWorkspaceState[K]),
      ) =>
        store.setField(key, value, dirty);
    return {
      setPhone: field("phone"),
      setName: field("name"),
      setPaymentCents: field("paymentCents"),
      setPaymentMethod: field("paymentMethod"),
      setPricing: field("pricing"),
      setNote: field("note"),
      setDraftId: field("draftId", false),
      setLines: field("lines"),
      setFocusedLineKey: field("focusedLineKey", false),
      setBusy: field("busy", false),
      setResult: field("result", false),
      setTicketPreview: field("ticketPreview", false),
    };
  }, [store]);
  return { ...workspace, ...workspace.state, ...setters };
}
