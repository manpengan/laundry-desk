import { buildApi } from "@shared/api";
import type { ApiResponse } from "@shared/index";

const webApi = buildApi(async (channel, payload) => {
  try {
    const res = await fetch("/api/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel, payload }),
    });
    return (await res.json()) as ApiResponse<unknown>;
  } catch (e) {
    return { ok: false, error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : "网络请求失败" } };
  }
});

export function installWebApiIfNeeded(): void {
  const w = window as unknown as { api?: unknown; laundryEnv?: { mediaBase: string } };
  if (!w.api) {
    w.api = webApi;
    w.laundryEnv = { mediaBase: "/media/" };
  }
}
