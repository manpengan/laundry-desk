/** Narrow native API boundary; server credentials never enter this interface. */
export type NativeFailure = Readonly<{ errMsg?: string }>;
export type PaymentArguments = Readonly<{
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: "RSA";
  paySign: string;
}>;
export interface WxPort {
  getAccountInfoSync(): Readonly<{ miniProgram: Readonly<{ appId: string }> }>;
  getRandomValues(
    options: Readonly<{
      length: number;
      success: (value: Readonly<{ randomValues: ArrayBuffer }>) => void;
      fail: () => void;
    }>,
  ): void;
  request(
    options: Readonly<{
      url: string;
      method: "POST" | "GET";
      header: Readonly<Record<string, string>>;
      data?: unknown;
      timeout: number;
      success: (value: Readonly<{ statusCode: number; data: unknown }>) => void;
      fail: (error: NativeFailure) => void;
    }>,
  ): Readonly<{ abort(): void }>;
  login(
    options: Readonly<{
      timeout: number;
      success: (value: Readonly<{ code: string }>) => void;
      fail: (error: NativeFailure) => void;
    }>,
  ): void;
  requestPayment(
    options: PaymentArguments &
      Readonly<{
        success: () => void;
        fail: (error: NativeFailure) => void;
      }>,
  ): void;
  requestSubscribeMessage(
    options: Readonly<{
      tmplIds: string[];
      success: (value: Readonly<Record<string, string>>) => void;
      fail: (error: NativeFailure) => void;
    }>,
  ): void;
  showModal(
    options: Readonly<{
      title: string;
      content: string;
      success: (value: Readonly<{ confirm: boolean }>) => void;
      fail: () => void;
    }>,
  ): void;
}

export function requestId(wx: WxPort): Promise<string> {
  return new Promise((resolve, reject) =>
    wx.getRandomValues({
      length: 16,
      success: ({ randomValues }) => {
        const bytes = new Uint8Array(randomValues);
        if (bytes.length !== 16) {
          reject(new Error("无法建立安全请求，请更新微信后重试"));
          return;
        }
        const hex = Array.from(bytes, (byte, index) =>
          (index === 6 ? (byte & 15) | 64 : index === 8 ? (byte & 63) | 128 : byte)
            .toString(16)
            .padStart(2, "0"),
        ).join("");
        resolve(
          `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        );
      },
      fail: () => reject(new Error("无法建立安全请求，请更新微信后重试")),
    }),
  );
}

export function loginCode(wx: WxPort): Promise<string> {
  return new Promise((resolve, reject) =>
    wx.login({
      timeout: 10_000,
      success: ({ code }) =>
        /^[\w-]{1,256}$/u.test(code)
          ? resolve(code)
          : reject(new Error("微信登录暂不可用，请重试")),
      fail: () => reject(new Error("微信登录失败，请重试")),
    }),
  );
}

export function confirm(wx: WxPort, title: string, content: string): Promise<boolean> {
  return new Promise((resolve) =>
    wx.showModal({
      title,
      content,
      success: ({ confirm: accepted }) => resolve(accepted),
      fail: () => resolve(false),
    }),
  );
}
