import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import type { ServiceType } from "@shared/schemas";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { Notice } from "../components/ui/Notice";
import { PhotoCard } from "../components/receive/PhotoCard";
import { formatCurrency } from "@renderer/lib/utils";

interface OrderItem {
  id: string;
  itemType: string;
  serviceType: ServiceType;
  quantity: number;
  unitPrice: number;
}

interface PriceTemplate {
  itemType: string;
  serviceType: ServiceType;
  price: number;
}

export default function Receive() {
  const [customer, setCustomer] = useState({ name: "", phone: "" });
  const [items, setItems] = useState<OrderItem[]>([createBlankItem()]);
  const [templates, setTemplates] = useState<PriceTemplate[]>([]);
  const [paidAmount, setPaidAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<
    "cash" | "wechat" | "alipay" | "card" | "unpaid"
  >("cash");
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [discountAmount, setDiscountAmount] = useState(0);
  const [photos, setPhotos] = useState<string[]>([]);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const totalAmount = items.reduce(
    (acc, item) => acc + item.quantity * item.unitPrice,
    0,
  );
  const payable = Math.max(0, totalAmount - discountAmount);

  useEffect(() => {
    void window.api.settings
      .get<PriceTemplate[]>("price_templates")
      .then((response) => {
        if (response.ok && response.data) setTemplates(response.data);
      });
  }, []);

  useEffect(() => {
    phoneInputRef.current?.focus();
  }, []);

  useEffect(() => {
    setPaidAmount(Math.max(0, totalAmount - discountAmount));
  }, [totalAmount, discountAmount]);

  const handlePhoneChange = async (phone: string): Promise<void> => {
    setCustomer((current) => ({ ...current, phone }));
    if (/^1[3-9]\d{9}$/.test(phone)) {
      const response = await window.api.customers.findByPhone(phone);
      if (response.ok && response.data) {
        setCustomer({ name: response.data.name, phone: response.data.phone });
      }
    }
  };

  const updateItem = (id: string, patch: Partial<OrderItem>): void => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const removeItem = (id: string): void => {
    setItems((current) =>
      current.length === 1 ? current : current.filter((item) => item.id !== id),
    );
  };

  const selectTemplate = (id: string, template: PriceTemplate): void => {
    updateItem(id, {
      itemType: template.itemType,
      serviceType: template.serviceType,
      unitPrice: template.price,
    });
  };

  const handleSubmit = async (): Promise<void> => {
    setError("");
    setSuccessMessage("");
    if (!customer.name.trim() || !/^1[3-9]\d{9}$/.test(customer.phone)) {
      setError("请填写客户姓名和正确手机号");
      return;
    }
    if (
      items.some(
        (item) =>
          !item.itemType.trim() || item.quantity < 1 || item.unitPrice < 0,
      )
    ) {
      setError("请完整填写物品明细");
      return;
    }
    if (paidAmount > totalAmount) {
      setError("实收金额不能超过订单总额");
      return;
    }

    setLoading(true);
    const customerResponse = await window.api.customers.upsert(customer);
    if (!customerResponse.ok) {
      setError(customerResponse.error.message);
      setLoading(false);
      return;
    }

    const orderResponse = await window.api.orders.create({
      customerId: customerResponse.data.id,
      items: items.map(({ itemType, serviceType, quantity, unitPrice }) => ({
        itemType,
        serviceType,
        quantity,
        unitPrice,
      })),
      totalAmount: payable,
      paidAmount,
      paymentMethod: paidAmount === 0 ? "unpaid" : paymentMethod,
      photos,
    });
    setLoading(false);

    if (!orderResponse.ok) {
      setError(orderResponse.error.message);
      return;
    }

    const pickupCode = orderResponse.data.pickupCode;
    try {
      await window.api.printer.printReceipt(orderResponse.data.id);
    } catch (printErr) {
      console.error("小票打印失败:", printErr);
    }

    setSuccessMessage(`收件成功，取件码 ${pickupCode}`);
    navigate(`/orders/${orderResponse.data.id}`, {
      state: {
        notice: {
          variant: "success",
          message: `收件成功，取件码 ${pickupCode}`,
        },
      },
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--lg-ink3)]">
          Receive
        </p>
        <h2 className="mt-1 text-[24px] font-bold leading-none tracking-[-0.02em]">
          收件登记
        </h2>
      </div>
      {successMessage && <Notice variant="success">{successMessage}</Notice>}
      {error && <Notice variant="error">{error}</Notice>}

      <div className="grid items-start gap-3.5 md:grid-cols-3">
        <div className="space-y-3.5 md:col-span-1">
          <div className="lg-card lg-spec rounded-[20px]">
            <div className="px-5 pb-1 pt-4">
              <h3 className="text-[15px] font-semibold">客户信息</h3>
            </div>
            <div className="space-y-3 p-4 pt-2">
              <Input
                ref={phoneInputRef}
                placeholder="手机号"
                value={customer.phone}
                onChange={(event) => void handlePhoneChange(event.target.value)}
              />
              <Input
                placeholder="客户姓名"
                value={customer.name}
                onChange={(event) =>
                  setCustomer({ ...customer, name: event.target.value })
                }
              />
            </div>
          </div>
          <PhotoCard photos={photos} onChange={setPhotos} onError={setError} />
        </div>

        <div className="lg-card lg-spec rounded-[22px] md:col-span-2">
          <div className="flex items-center justify-between px-5 pb-1 pt-4">
            <h3 className="text-[15px] font-semibold">物品明细</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setItems((c) => [...c, createBlankItem()])}
            >
              <Plus className="mr-1 h-4 w-4" /> 添加
            </Button>
          </div>
          <div className="space-y-4 p-4 pt-2">
            {items.map((item) => (
              <div
                key={item.id}
                className="grid items-end gap-3 md:grid-cols-[1fr_120px_90px_44px]"
              >
                <div className="space-y-2">
                  <Input
                    placeholder="物品类型，例如衬衫"
                    value={item.itemType}
                    onChange={(event) =>
                      updateItem(item.id, { itemType: event.target.value })
                    }
                  />
                  {item.itemType && (
                    <div className="flex flex-wrap gap-1.5">
                      {templates
                        .filter((template) =>
                          template.itemType.includes(item.itemType),
                        )
                        .slice(0, 4)
                        .map((template) => (
                          <button
                            key={`${template.itemType}-${template.serviceType}`}
                            type="button"
                            className="lg-pressable rounded-full bg-[var(--lg-accent-soft)] px-3 py-1 text-[12px] font-semibold text-[var(--lg-accent)]"
                            onClick={() => selectTemplate(item.id, template)}
                          >
                            {template.itemType} {formatCurrency(template.price)}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
                <Input
                  type="number"
                  min={0}
                  placeholder="单价(元)"
                  value={centsToInput(item.unitPrice)}
                  onChange={(event) =>
                    updateItem(item.id, {
                      unitPrice: yuanInputToCents(event.target.value),
                    })
                  }
                />
                <Input
                  type="number"
                  min={1}
                  value={item.quantity}
                  onChange={(event) =>
                    updateItem(item.id, {
                      quantity: Number(event.target.value) || 1,
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-[var(--lg-late-ink)]"
                  onClick={() => removeItem(item.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}

            <div
              className="space-y-4 border-t pt-4"
              style={{ borderColor: "var(--lg-hair)" }}
            >
              <div className="grid items-center gap-3 md:grid-cols-2">
                <span className="text-[13.5px] text-[var(--lg-ink2)]">
                  合计 {items.length} 件，原价 {formatCurrency(totalAmount)}
                </span>
                <Input
                  type="number"
                  min={0}
                  placeholder="优惠金额(元)"
                  value={centsToInput(discountAmount)}
                  onChange={(event) =>
                    setDiscountAmount(yuanInputToCents(event.target.value))
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-semibold text-[var(--lg-ink2)]">
                  折后应收
                </span>
                <span
                  className="text-[22px] font-bold tracking-[-0.02em] text-[var(--lg-accent)]"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {formatCurrency(payable)}
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Input
                  type="number"
                  min={0}
                  placeholder="实收金额(元)"
                  value={centsToInput(paidAmount)}
                  onChange={(event) =>
                    setPaidAmount(yuanInputToCents(event.target.value))
                  }
                />
                <select
                  className="h-11 rounded-[12px] border px-3.5 text-[14px] text-[var(--lg-ink)] focus:border-[var(--lg-accent)] focus:outline-none focus:ring-[3px] focus:ring-[var(--lg-accent-soft)]"
                  style={{
                    background: "var(--lg-leaf)",
                    borderColor: "var(--lg-hair)",
                  }}
                  value={paymentMethod}
                  onChange={(event) =>
                    setPaymentMethod(event.target.value as typeof paymentMethod)
                  }
                >
                  <option value="cash">现金</option>
                  <option value="wechat">微信</option>
                  <option value="alipay">支付宝</option>
                  <option value="card">刷卡</option>
                </select>
              </div>
              {paidAmount < payable && (
                <div className="lg-pill late inline-block">
                  将记为欠款 {formatCurrency(payable - paidAmount)}
                </div>
              )}
            </div>

            <Button
              className="mt-2 w-full"
              size="lg"
              onClick={() => void handleSubmit()}
              disabled={loading}
            >
              <CheckCircle2 className="mr-2 h-5 w-5" />
              {loading ? "提交中..." : "确认收件"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function createBlankItem(): OrderItem {
  return {
    id: crypto.randomUUID(),
    itemType: "",
    serviceType: "wash",
    quantity: 1,
    unitPrice: 0,
  };
}

function yuanInputToCents(value: string): number {
  const normalized = value.trim();
  if (!normalized) return 0;
  const [yuan = "0", fraction = ""] = normalized.split(".");
  return Number(yuan) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}

function centsToInput(cents: number): string {
  return (cents / 100).toString();
}
