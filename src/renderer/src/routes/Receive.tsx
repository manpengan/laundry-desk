import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import type { ServiceType } from "@shared/schemas";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { Notice } from "../components/ui/Notice";
import { formatCurrency } from "@renderer/lib/utils";
import { PhotoCapture } from "../components/PhotoCapture";

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
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const [discountAmount, setDiscountAmount] = useState(0);

  const [photos, setPhotos] = useState<string[]>([]);

  const totalAmount = items.reduce(
    (acc, item) => acc + item.quantity * item.unitPrice,
    0,
  );

  useEffect(() => {
    window.api.settings
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

  const handlePhoneChange = async (phone: string) => {
    setCustomer((current) => ({ ...current, phone }));
    if (/^1[3-9]\d{9}$/.test(phone)) {
      const response = await window.api.customers.findByPhone(phone);
      if (response.ok && response.data) {
        setCustomer({ name: response.data.name, phone: response.data.phone });
      }
    }
  };

  const updateItem = (id: string, patch: Partial<OrderItem>) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const addItem = () => {
    setItems((current) => [...current, createBlankItem()]);
  };

  const removeItem = (id: string) => {
    setItems((current) =>
      current.length === 1 ? current : current.filter((item) => item.id !== id),
    );
  };

  const selectTemplate = (id: string, template: PriceTemplate) => {
    updateItem(id, {
      itemType: template.itemType,
      serviceType: template.serviceType,
      unitPrice: template.price,
    });
  };

  const handleSubmit = async () => {
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
      totalAmount: Math.max(0, totalAmount - discountAmount),
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

    // 异步触发打印收件凭单，不阻塞路由跳转
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
    <div className="max-w-4xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">收件登记</h2>
      {successMessage && <Notice variant="success">{successMessage}</Notice>}
      {error && <Notice variant="error">{error}</Notice>}

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-1 space-y-6">
          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-base">客户信息</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                ref={phoneInputRef}
                placeholder="手机号"
                value={customer.phone}
                onChange={(event) => handlePhoneChange(event.target.value)}
              />
              <Input
                placeholder="客户姓名"
                value={customer.name}
                onChange={(event) =>
                  setCustomer({ ...customer, name: event.target.value })
                }
              />
            </CardContent>
          </Card>

          <PhotoCapture photos={photos} onChange={setPhotos} />
        </div>

        <Card className="md:col-span-2 border-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">物品明细</CardTitle>
            <Button variant="outline" size="sm" onClick={addItem}>
              <Plus className="w-4 h-4 mr-1" /> 添加
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {items.map((item) => (
              <div
                key={item.id}
                className="grid gap-3 md:grid-cols-[1fr_120px_90px_44px] items-end"
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
                    <div className="flex flex-wrap gap-2">
                      {templates
                        .filter((template) =>
                          template.itemType.includes(item.itemType),
                        )
                        .slice(0, 4)
                        .map((template) => (
                          <button
                            key={`${template.itemType}-${template.serviceType}`}
                            type="button"
                            className="rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-600"
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
                  className="text-red-400"
                  onClick={() => removeItem(item.id)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}

            <div className="pt-4 border-t border-slate-100 space-y-4">
              <div className="grid gap-3 md:grid-cols-2 items-center">
                <span className="text-slate-500">
                  合计 {items.length} 件，原价: {formatCurrency(totalAmount)}
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
                <span className="text-slate-500 font-semibold">折后应收</span>
                <span className="text-xl font-bold text-blue-600">
                  {formatCurrency(Math.max(0, totalAmount - discountAmount))}
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
                  className="h-11 rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm"
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
              {paidAmount < Math.max(0, totalAmount - discountAmount) && (
                <div className="text-sm text-red-500 font-medium pl-1">
                  将记为欠款:{" "}
                  {formatCurrency(
                    Math.max(0, totalAmount - discountAmount) - paidAmount,
                  )}
                </div>
              )}
            </div>

            <Button
              className="w-full mt-6"
              size="lg"
              onClick={handleSubmit}
              disabled={loading}
            >
              <CheckCircle2 className="w-5 h-5 mr-2" />
              {loading ? "提交中..." : "确认收件"}
            </Button>
          </CardContent>
        </Card>
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
