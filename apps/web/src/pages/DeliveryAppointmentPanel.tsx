import { Button, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";
import { DeliveryAppointmentEditor } from "./DeliveryAppointmentEditor.js";
import type { CustomerRowView } from "./customer-model.js";
import {
  buildDeliveryAppointmentCancel,
  buildDeliveryAppointmentCreate,
  buildDeliveryAppointmentReschedule,
  DELIVERY_CANCELLATION_LABELS,
  DELIVERY_DIRECTION_LABELS,
  localDateTimeFromEpoch,
  parseDeliveryAppointmentAddresses,
  parseDeliveryAppointments,
  type DeliveryAppointmentAddressView,
  type DeliveryAppointmentView,
  type DeliveryCancellationReason,
} from "./delivery-appointment-model.js";
import { readDeliveryPolicy, type DeliveryPolicyDraft } from "./delivery-policy-model.js";

type AppointmentCommand =
  "delivery.appointment.create" | "delivery.appointment.reschedule" | "delivery.appointment.cancel";

type PendingAction = Readonly<{
  customerId: string;
  command: AppointmentCommand;
  confirmRef: string;
  kind: "confirm" | "step_up";
  label: string;
  summary: string;
}>;

export type DeliveryAppointmentPanelProps = Readonly<{
  customer: CustomerRowView;
  queryClient: QueryPort;
  commandClient: CommandPort;
  featureEnabled: boolean;
  authClient?: AuthClient;
  session?: SessionView;
}>;

export function DeliveryAppointmentPanel({
  customer,
  queryClient,
  commandClient,
  featureEnabled,
  authClient,
  session,
}: DeliveryAppointmentPanelProps) {
  const toast = useToast();
  const requestRef = useRef(0);
  const customerIdRef = useRef(customer.customer_id);
  customerIdRef.current = customer.customer_id;
  const [addresses, setAddresses] = useState<readonly DeliveryAppointmentAddressView[]>([]);
  const [policy, setPolicy] = useState<DeliveryPolicyDraft | null>(null);
  const [appointments, setAppointments] = useState<readonly DeliveryAppointmentView[]>([]);
  const [addressId, setAddressId] = useState("");
  const [areaCode, setAreaCode] = useState("");
  const [direction, setDirection] = useState<"pickup" | "return">("pickup");
  const [requestedAt, setRequestedAt] = useState("");
  const [rescheduleDrafts, setRescheduleDrafts] = useState<Readonly<Record<string, string>>>({});
  const [cancelReasons, setCancelReasons] = useState<
    Readonly<Record<string, DeliveryCancellationReason>>
  >({});
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadedCustomerId, setLoadedCustomerId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useCallback(async () => {
    const customerId = customer.customer_id;
    if (customerIdRef.current !== customerId) return;
    const request = ++requestRef.current;
    setBusy(true);
    try {
      const [addressResult, policyResult, listResult] = await Promise.all([
        queryClient.execute<unknown>("delivery.appointment.addresses.list", {
          customer_id: customerId,
        }),
        queryClient.execute<unknown>("delivery.policy.get", {}),
        queryClient.execute<unknown>("delivery.appointments.list", {
          customer_id: customerId,
          limit: 100,
        }),
      ]);
      if (request !== requestRef.current || customerIdRef.current !== customerId) return;
      if (!addressResult.ok || !policyResult.ok || !listResult.ok) {
        const failed = [addressResult, policyResult, listResult].find((result) => !result.ok);
        toast.push(
          failed && !failed.ok ? (failed.error.message ?? failed.error.code) : "预约读取失败",
          "error",
        );
        setLoaded(false);
        setLoadedCustomerId(null);
        return;
      }
      const nextAddressBook = parseDeliveryAppointmentAddresses(addressResult.data);
      const nextPolicy = readDeliveryPolicy(policyResult.data);
      const nextAppointments = parseDeliveryAppointments(listResult.data);
      if (nextAddressBook === null || nextPolicy === null || nextAppointments === null) {
        toast.push("预约资料响应无法解析", "error");
        setLoaded(false);
        setLoadedCustomerId(null);
        return;
      }
      const activeAreas = nextPolicy.service_areas.filter(({ is_active }) => is_active);
      setAddresses(nextAddressBook.addresses);
      setPolicy(nextPolicy);
      setAppointments(nextAppointments);
      setAddressId((current) =>
        nextAddressBook.addresses.some(({ address_id }) => address_id === current)
          ? current
          : (nextAddressBook.addresses.find(({ is_default }) => is_default)?.address_id ??
            nextAddressBook.addresses[0]?.address_id ??
            ""),
      );
      setAreaCode((current) =>
        activeAreas.some(({ code }) => code === current) ? current : (activeAreas[0]?.code ?? ""),
      );
      setRescheduleDrafts(
        Object.freeze(
          Object.fromEntries(
            nextAppointments.map((appointment) => [
              appointment.appointment_id,
              localDateTimeFromEpoch(appointment.scheduled_start_at),
            ]),
          ),
        ),
      );
      setCancelReasons(
        nextAppointments.reduce<Readonly<Record<string, DeliveryCancellationReason>>>(
          (current, appointment) =>
            Object.freeze({ ...current, [appointment.appointment_id]: "customer_request" }),
          Object.freeze({}),
        ),
      );
      setLoadedCustomerId(customerId);
      setLoaded(true);
    } catch {
      if (request !== requestRef.current || customerIdRef.current !== customerId) return;
      setLoaded(false);
      setLoadedCustomerId(null);
      toast.push("预约资料加载失败，请检查服务连接", "error");
    } finally {
      if (request === requestRef.current && customerIdRef.current === customerId) setBusy(false);
    }
  }, [customer.customer_id, queryClient, toast]);

  useEffect(() => {
    setAddresses([]);
    setPolicy(null);
    setAppointments([]);
    setAddressId("");
    setAreaCode("");
    setRequestedAt("");
    setRescheduleDrafts({});
    setCancelReasons({});
    setLoaded(false);
    setLoadedCustomerId(null);
    setPending(null);
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const execute = useCallback(
    async (command: AppointmentCommand, body: unknown, label: string, summary: string) => {
      const customerId = customer.customer_id;
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>(command, body);
        if (customerIdRef.current !== customerId) return;
        if (result.ok) {
          toast.push(`${label}完成`, "success");
          await load();
          return;
        }
        if (isStepUpRequired(result)) {
          const kind = result.error.code === "POLICY_STEP_UP_REQUIRED" ? "step_up" : "confirm";
          if (kind === "step_up" && (authClient === undefined || session === undefined)) {
            toast.push("该操作需要另一管理员复核，当前会话缺少复核入口", "error");
            return;
          }
          setPending(
            Object.freeze({
              customerId,
              command,
              confirmRef: result.error.detail.confirm_ref,
              kind,
              label,
              summary,
            }),
          );
          return;
        }
        toast.push(
          result.error.code === "INVARIANT_FAILED"
            ? "预约版本、规则或名额已变化，请按最新资料重试"
            : (result.error.message ?? result.error.code),
          "error",
        );
        await load();
      } catch {
        if (customerIdRef.current === customerId) toast.push(`${label}失败，请刷新确认`, "error");
      } finally {
        if (customerIdRef.current === customerId) setBusy(false);
      }
    },
    [authClient, commandClient, customer.customer_id, load, session, toast],
  );

  const resume = useCallback(async () => {
    if (pending === null || pending.customerId !== customer.customer_id) {
      setPending(null);
      return;
    }
    const customerId = customer.customer_id;
    setBusy(true);
    try {
      const result = await commandClient.execute<unknown>(
        pending.command,
        {},
        { confirmRef: pending.confirmRef },
      );
      if (customerIdRef.current !== customerId) return;
      setPending(null);
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        await load();
        return;
      }
      toast.push(`${pending.label}完成`, "success");
      await load();
    } catch {
      if (customerIdRef.current === customerId) {
        toast.push(`${pending.label}失败，请刷新确认`, "error");
      }
    } finally {
      if (customerIdRef.current === customerId) setBusy(false);
    }
  }, [commandClient, customer.customer_id, load, pending, toast]);

  const create = (): void => {
    if (policy === null) return;
    const built = buildDeliveryAppointmentCreate(
      customer.customer_id,
      addressId,
      direction,
      areaCode,
      requestedAt,
      policy.version,
    );
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    void execute(
      "delivery.appointment.create",
      built.body,
      "创建取送预约",
      `${DELIVERY_DIRECTION_LABELS[direction]} · ${requestedAt}`,
    );
  };

  const reschedule = (appointment: DeliveryAppointmentView): void => {
    if (policy === null) return;
    const nextAt = rescheduleDrafts[appointment.appointment_id] ?? "";
    const built = buildDeliveryAppointmentReschedule(appointment, nextAt, policy.version);
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    void execute("delivery.appointment.reschedule", built.body, "预约改期", nextAt);
  };

  const cancel = (appointment: DeliveryAppointmentView): void => {
    const reason = cancelReasons[appointment.appointment_id] ?? "customer_request";
    const built = buildDeliveryAppointmentCancel(appointment, reason);
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    void execute(
      "delivery.appointment.cancel",
      built.body,
      "取消预约",
      DELIVERY_CANCELLATION_LABELS[reason],
    );
  };

  const currentLoaded = loaded && loadedCustomerId === customer.customer_id;
  const currentAddresses = currentLoaded ? addresses : Object.freeze([]);
  const currentPolicy = currentLoaded ? policy : null;
  const currentAppointments = currentLoaded ? appointments : Object.freeze([]);
  const currentPending = pending?.customerId === customer.customer_id ? pending : null;
  const canCreate =
    currentLoaded &&
    currentPolicy !== null &&
    featureEnabled &&
    currentPolicy.accepting_appointments &&
    addressId.length > 0 &&
    areaCode.length > 0 &&
    requestedAt.length > 0;

  return (
    <section className="ld-delivery-appointments" data-testid="delivery-appointment-panel">
      <div className="ld-delivery-appointments__head">
        <div>
          <h3>顾客取送预约</h3>
          <p>预约、改期与取消均由服务端重新核对地址归属、策略版本与真实名额。</p>
        </div>
        <Button variant="ghost" type="button" disabled={busy} onClick={() => void load()}>
          重新读取
        </Button>
      </div>

      {!currentLoaded ? <p role="status">预约资料读取中…</p> : null}
      {currentLoaded && currentAddresses.length === 0 ? (
        <p role="alert">请先在扩展档案中保存至少一个有效地址。</p>
      ) : null}
      {!featureEnabled ? (
        <p role="alert">门店取送功能已关闭；不能新建或改期，已有预约仍可取消。</p>
      ) : null}
      {currentLoaded && featureEnabled && currentPolicy?.accepting_appointments !== true ? (
        <p role="alert">当前门店暂停接收新预约；已有预约仍可取消。</p>
      ) : null}

      <DeliveryAppointmentEditor
        addresses={currentAddresses}
        policy={currentPolicy}
        appointments={currentAppointments}
        addressId={addressId}
        areaCode={areaCode}
        direction={direction}
        requestedAt={requestedAt}
        rescheduleDrafts={rescheduleDrafts}
        cancelReasons={cancelReasons}
        busy={busy}
        canCreate={canCreate}
        canReschedule={
          currentLoaded && featureEnabled && currentPolicy?.accepting_appointments === true
        }
        onAddressChange={setAddressId}
        onAreaChange={setAreaCode}
        onDirectionChange={setDirection}
        onRequestedAtChange={setRequestedAt}
        onCreate={create}
        onRescheduleDraftChange={(appointmentId, value) =>
          setRescheduleDrafts((current) => Object.freeze({ ...current, [appointmentId]: value }))
        }
        onCancelReasonChange={(appointmentId, value) =>
          setCancelReasons((current) => Object.freeze({ ...current, [appointmentId]: value }))
        }
        onReschedule={reschedule}
        onCancel={cancel}
      />

      <DangerConfirmDialog
        open={currentPending?.kind === "confirm"}
        title="确认取送预约操作"
        description="服务端已冻结本次预约操作，请核对后继续。"
        summary={currentPending === null ? undefined : <p>{currentPending.summary}</p>}
        confirmLabel="确认执行"
        serverConfirmation
        busy={busy}
        onClose={() => setPending(null)}
        onConfirm={() => void resume()}
      />
      {currentPending?.kind === "step_up" && authClient !== undefined && session !== undefined ? (
        <StepUpConfirmDialog
          open
          onClose={() => setPending(null)}
          authClient={authClient}
          confirmRef={currentPending.confirmRef}
          currentStaffId={session.session.staff_id}
          commandLabel={currentPending.label}
          summary={<p>{currentPending.summary}</p>}
          onApproved={() => void resume()}
        />
      ) : null}
    </section>
  );
}
