import { Button, EmptyState, Input, Skeleton, useToast } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StaffAccessPanel } from "../pages/StaffAccessPanel.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import {
  buildStoreProfileInput,
  loadOwnerStoreDirectory,
  parseUpdatedOwnerStore,
  requestStoreProfileSet,
  resumeStoreProfileSet,
  type OwnerAuthorizedStore,
  type OwnerStoreDirectory,
} from "./owner-store-management-model.js";

export type OwnerStoreSelection = Readonly<{ orgCode: string; storeCode: string }>;

export type OwnerStoreManagementPageProps = Readonly<{
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient: QueryPort;
  onSessionChange: (session: SessionView | null) => void;
  onSelectStore: (selection: OwnerStoreSelection) => Promise<void>;
}>;

type PendingRename = Readonly<{
  confirmRef: string;
  input: Readonly<{
    expected_profile_version: number;
    store_name: string;
    reason: string;
  }>;
}>;

export function OwnerStoreDirectoryView({
  directory,
  switchingStore,
  onSelectStore,
}: Readonly<{
  directory: OwnerStoreDirectory;
  switchingStore: string | null;
  onSelectStore: (store: OwnerAuthorizedStore) => void;
}>) {
  return (
    <section className="ld-owner-management lg-card" aria-labelledby="owner-stores-title">
      <header className="ld-owner-management__header">
        <div>
          <span className="ld-owner-operations__eyebrow">逐店校验有效店长权限</span>
          <h2 id="owner-stores-title">授权门店</h2>
          <p>切换门店会先退出当前会话，再要求重新输入目标门店的账号和密码。</p>
        </div>
        <span>{directory.returned_store_count} 家</span>
      </header>
      <div className="ld-owner-management__table-wrap">
        <table className="ld-owner-management__table">
          <thead>
            <tr>
              <th scope="col">门店</th>
              <th scope="col">时区</th>
              <th scope="col">状态</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {directory.stores.map((store) => (
              <tr key={store.store_code}>
                <th scope="row">
                  <strong>{store.store_name}</strong>
                  <small>{store.store_code}</small>
                </th>
                <td>{store.timezone}</td>
                <td>{store.is_current ? "当前登录" : "已授权"}</td>
                <td>
                  <Button
                    type="button"
                    size="sm"
                    variant={store.is_current ? "ghost" : "secondary"}
                    disabled={store.is_current || switchingStore !== null}
                    onClick={() => onSelectStore(store)}
                  >
                    {switchingStore === store.store_code ? "正在退出…" : "切换登录"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {directory.truncated ? (
        <p className="ld-owner-operations__notice" role="status">
          授权门店超过 50 家；请联系运维按组织拆分管理范围。
        </p>
      ) : null}
    </section>
  );
}

export function OwnerStoreManagementPage({
  session,
  authClient,
  commandClient,
  queryClient,
  onSessionChange,
  onSelectStore,
}: OwnerStoreManagementPageProps) {
  const toast = useToast();
  const [directory, setDirectory] = useState<OwnerStoreDirectory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storeName, setStoreName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [switchingStore, setSwitchingStore] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRename | null>(null);
  const generation = useRef(0);
  const currentStore = useMemo(
    () => directory?.stores.find((store) => store.is_current) ?? null,
    [directory],
  );

  const load = useCallback(async () => {
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    setLoading(true);
    setError(null);
    try {
      const result = await loadOwnerStoreDirectory(queryClient);
      if (generation.current !== currentGeneration) return;
      if (!result.ok) {
        setDirectory(null);
        setError(result.error);
        return;
      }
      setDirectory(result.data);
      const current = result.data.stores.find((store) => store.is_current);
      setStoreName(current?.store_name ?? "");
      setReason("");
    } catch {
      if (generation.current !== currentGeneration) return;
      setDirectory(null);
      setError("无法读取授权门店，请检查服务连接");
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [queryClient]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const applyRename = useCallback(
    async (data: unknown) => {
      const updated = parseUpdatedOwnerStore(data);
      if (updated === null) {
        toast.push("门店资料返回格式无效", "error");
        return;
      }
      setDirectory((current) =>
        current === null
          ? null
          : Object.freeze({
              ...current,
              stores: Object.freeze(
                current.stores.map((store) => (store.is_current ? updated : store)),
              ),
            }),
      );
      setStoreName(updated.store_name);
      setReason("");
      setPending(null);
      const refreshed = await authClient.refreshSession();
      if (!refreshed.ok) {
        toast.push("门店名称已更新，请重新登录以刷新会话", "warning");
        onSessionChange(null);
        return;
      }
      onSessionChange(refreshed.data);
      toast.push("当前门店名称已更新", "success");
    },
    [authClient, onSessionChange, toast],
  );

  const save = useCallback(async () => {
    if (currentStore === null || busy) return;
    const built = buildStoreProfileInput(currentStore.profile_version, storeName, reason);
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    setBusy(true);
    try {
      const result = await requestStoreProfileSet(commandClient, built.input);
      if (result.ok) {
        await applyRename(result.data);
      } else if (isStepUpRequired(result)) {
        setPending(
          Object.freeze({ confirmRef: result.error.detail.confirm_ref, input: built.input }),
        );
      } else {
        toast.push(result.error.message ?? result.error.code, "error");
      }
    } catch {
      toast.push("无法保存门店资料，请检查服务连接", "error");
    } finally {
      setBusy(false);
    }
  }, [applyRename, busy, commandClient, currentStore, reason, storeName, toast]);

  const finishPending = useCallback(async () => {
    if (pending === null || busy) return;
    setBusy(true);
    try {
      const result = await resumeStoreProfileSet(commandClient, pending.confirmRef);
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      await applyRename(result.data);
    } catch {
      toast.push("无法完成门店资料复核，请检查服务连接", "error");
    } finally {
      setBusy(false);
    }
  }, [applyRename, busy, commandClient, pending, toast]);

  const selectStore = useCallback(
    async (store: OwnerAuthorizedStore) => {
      if (switchingStore !== null) return;
      setSwitchingStore(store.store_code);
      try {
        await onSelectStore({ orgCode: session.display.org_code, storeCode: store.store_code });
      } catch {
        setSwitchingStore(null);
        toast.push("无法退出当前门店，请稍后重试", "error");
      }
    },
    [onSelectStore, session.display.org_code, switchingStore, toast],
  );

  if (directory === null && loading) {
    return (
      <div className="ld-owner-management lg-card" role="status">
        <Skeleton lines={6} rounded="md" />
      </div>
    );
  }
  if (directory === null) {
    return (
      <section className="ld-owner-management lg-card" role="alert">
        <EmptyState
          title="无法读取门店管理资料"
          description={error ?? "授权门店查询失败"}
          actionLabel="重新加载"
          onAction={() => void load()}
        />
      </section>
    );
  }

  return (
    <div className="ld-owner-management-page" data-testid="owner-store-management">
      <OwnerStoreDirectoryView
        directory={directory}
        switchingStore={switchingStore}
        onSelectStore={(store) => void selectStore(store)}
      />
      {currentStore === null ? null : (
        <section className="ld-owner-management lg-card" aria-labelledby="owner-profile-title">
          <header className="ld-owner-management__header">
            <div>
              <span className="ld-owner-operations__eyebrow">仅修改当前登录门店</span>
              <h2 id="owner-profile-title">门店资料</h2>
              <p>门店代码与时区在本阶段只读；名称变更采用版本校验并写入审计。</p>
            </div>
            <span>版本 {currentStore.profile_version}</span>
          </header>
          <div className="ld-owner-management__form">
            <Input
              name="owner-store-name"
              label="门店名称"
              value={storeName}
              disabled={busy}
              onChange={(event) => setStoreName(event.target.value)}
            />
            <Input
              name="owner-store-code"
              label="门店代码（只读）"
              value={currentStore.store_code}
              disabled
            />
            <Input
              name="owner-store-timezone"
              label="营业时区（只读）"
              value={currentStore.timezone}
              disabled
            />
            <Input
              name="owner-store-reason"
              label="变更原因"
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <Button type="button" variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存并复核"}
          </Button>
        </section>
      )}
      <StaffAccessPanel
        currentStaffId={session.session.staff_id}
        authClient={authClient}
        commandClient={commandClient}
        queryClient={queryClient}
        onSessionChange={onSessionChange}
      />
      <StepUpConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        authClient={authClient}
        confirmRef={pending?.confirmRef ?? ""}
        currentStaffId={session.session.staff_id}
        commandLabel="修改门店名称"
        summary={
          pending === null ? null : (
            <p>
              名称：{currentStore?.store_name ?? "—"} → {pending.input.store_name}
              <br />
              原因：{pending.input.reason}
            </p>
          )
        }
        onApproved={() => void finishPending()}
      />
    </div>
  );
}
