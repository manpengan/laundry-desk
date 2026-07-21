/** A5 PinSchema: 4–8 ASCII digits. Never log the PIN value. */

const PIN_RE = /^[0-9]{4,8}$/u;

export function validatePin(pin: string): string | null {
  if (pin === "") return "请输入 PIN";
  if (!PIN_RE.test(pin)) return "PIN 须为 4–8 位数字";
  return null;
}
