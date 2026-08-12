import { Button } from "@laundry/ui";

import {
  DELIVERY_CANCELLATION_LABELS,
  DELIVERY_DIRECTION_LABELS,
  formatDeliveryAppointmentTime,
  formatDeliveryFee,
  type DeliveryAppointmentView,
  type DeliveryAppointmentAddressView,
  type DeliveryCancellationReason,
} from "./delivery-appointment-model.js";
import type { DeliveryPolicyDraft } from "./delivery-policy-model.js";

export type DeliveryAppointmentEditorProps = Readonly<{
  addresses: readonly DeliveryAppointmentAddressView[];
  policy: DeliveryPolicyDraft | null;
  appointments: readonly DeliveryAppointmentView[];
  addressId: string;
  areaCode: string;
  direction: "pickup" | "return";
  requestedAt: string;
  rescheduleDrafts: Readonly<Record<string, string>>;
  cancelReasons: Readonly<Record<string, DeliveryCancellationReason>>;
  busy: boolean;
  canCreate: boolean;
  canReschedule: boolean;
  onAddressChange: (value: string) => void;
  onAreaChange: (value: string) => void;
  onDirectionChange: (value: "pickup" | "return") => void;
  onRequestedAtChange: (value: string) => void;
  onCreate: () => void;
  onRescheduleDraftChange: (appointmentId: string, value: string) => void;
  onCancelReasonChange: (appointmentId: string, value: DeliveryCancellationReason) => void;
  onReschedule: (appointment: DeliveryAppointmentView) => void;
  onCancel: (appointment: DeliveryAppointmentView) => void;
}>;

export function DeliveryAppointmentEditor({
  addresses,
  policy,
  appointments,
  addressId,
  areaCode,
  direction,
  requestedAt,
  rescheduleDrafts,
  cancelReasons,
  busy,
  canCreate,
  canReschedule,
  onAddressChange,
  onAreaChange,
  onDirectionChange,
  onRequestedAtChange,
  onCreate,
  onRescheduleDraftChange,
  onCancelReasonChange,
  onReschedule,
  onCancel,
}: DeliveryAppointmentEditorProps) {
  const activeAreas = policy?.service_areas.filter(({ is_active }) => is_active) ?? [];
  return (
    <>
      <form
        className="ld-delivery-appointments__create"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate();
        }}
      >
        <label>
          <span>顾客地址</span>
          <select
            value={addressId}
            onChange={(event) => onAddressChange(event.target.value)}
            disabled={busy}
          >
            {addresses.map((address) => (
              <option key={address.address_id} value={address.address_id}>
                {address.label} · {address.address}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>方向</span>
          <select
            value={direction}
            onChange={(event) => onDirectionChange(event.target.value as "pickup" | "return")}
            disabled={busy}
          >
            <option value="pickup">上门取件</option>
            <option value="return">送回顾客</option>
          </select>
        </label>
        <label>
          <span>服务区域</span>
          <select
            value={areaCode}
            onChange={(event) => onAreaChange(event.target.value)}
            disabled={busy}
          >
            {activeAreas.map((area) => (
              <option key={area.code} value={area.code}>
                {area.name} · {formatDeliveryFee(Number(area.fee_text))}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>预约时间</span>
          <input
            type="datetime-local"
            value={requestedAt}
            onChange={(event) => onRequestedAtChange(event.target.value)}
            disabled={busy}
          />
        </label>
        <Button variant="primary" type="submit" disabled={busy || !canCreate}>
          预约取送
        </Button>
      </form>

      <div className="ld-delivery-appointments__list" aria-label="当前顾客取送预约">
        <h4>预约记录</h4>
        {appointments.length === 0 ? <p>暂无预约。</p> : null}
        {appointments.map((appointment) => (
          <article key={appointment.appointment_id} className="ld-delivery-appointments__row">
            <div>
              <strong>{DELIVERY_DIRECTION_LABELS[appointment.direction]}</strong>
              <p>
                {formatDeliveryAppointmentTime(appointment.scheduled_start_at)} ·{" "}
                {formatDeliveryFee(appointment.fee_cents)} · 版本 {appointment.version}
              </p>
              <span>{appointment.status === "scheduled" ? "已预约" : "已取消"}</span>
            </div>
            {appointment.status === "scheduled" ? (
              <div className="ld-delivery-appointments__actions">
                <label>
                  <span>改期到</span>
                  <input
                    type="datetime-local"
                    value={rescheduleDrafts[appointment.appointment_id] ?? ""}
                    onChange={(event) =>
                      onRescheduleDraftChange(appointment.appointment_id, event.target.value)
                    }
                    disabled={
                      busy ||
                      !canReschedule ||
                      !addresses.some(({ address_id }) => address_id === appointment.address_id)
                    }
                  />
                </label>
                <Button
                  type="button"
                  disabled={
                    busy ||
                    !canReschedule ||
                    !addresses.some(({ address_id }) => address_id === appointment.address_id)
                  }
                  onClick={() => onReschedule(appointment)}
                >
                  改期
                </Button>
                <label>
                  <span>取消原因</span>
                  <select
                    value={cancelReasons[appointment.appointment_id] ?? "customer_request"}
                    onChange={(event) =>
                      onCancelReasonChange(
                        appointment.appointment_id,
                        event.target.value as DeliveryCancellationReason,
                      )
                    }
                    disabled={busy}
                  >
                    {Object.entries(DELIVERY_CANCELLATION_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="danger"
                  type="button"
                  disabled={busy}
                  onClick={() => onCancel(appointment)}
                >
                  取消预约
                </Button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </>
  );
}
