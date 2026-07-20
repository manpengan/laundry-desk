import iconv from "iconv-lite";

/** Chinese thermal printers on the bench use GBK/GB18030 payloads. */
export function encodeGbk(text: string): Buffer {
  return iconv.encode(text, "gbk");
}

export function maskPhone(phone: string, mask: boolean): string {
  if (!mask || phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
