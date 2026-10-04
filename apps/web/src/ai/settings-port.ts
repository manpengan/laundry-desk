import {
  AiCredentialIntentResponseSchema,
  AiCredentialListResponseSchema,
  AiCredentialMutationResponseSchema,
  AiModelListResponseSchema,
  AiProviderValidationIntentResponseSchema,
  AiProviderValidationResponseSchema,
  AiRuntimeConfigResponseSchema,
  type DesktopAiInput,
  type AiCredentialIntentRequest,
  type AiCredentialMetadata,
  type AiModelMetadata,
  type AiRuntimeConfig,
  type AiRuntimeConfigRequest,
} from "@laundry/contracts";

export type AiSettingsResult<T> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: Readonly<{ message: string }> }>;
export type AiSettingsPort = ReturnType<typeof createAiSettingsPort>;
export type AiOperationPort = (input: DesktopAiInput) => Promise<unknown>;
export type AiConfigView = Readonly<{ config: AiRuntimeConfig | null; custody_available: boolean }>;
const unavailable = (): AiSettingsResult<never> => ({
  ok: false,
  error: { message: "操作未完成。请检查登录、联网状态、复核权限及 AI 配置后重试。" },
});
type Schema<T> = Readonly<{
  safeParse: (
    value: unknown,
  ) =>
    | Readonly<{ success: true; data: Readonly<{ ok: true; data: T }> }>
    | Readonly<{ success: false }>;
}>;

export function createAiSettingsPort(operation: AiOperationPort) {
  async function run<T>(input: DesktopAiInput, schema: Schema<T>): Promise<AiSettingsResult<T>> {
    try {
      const parsed = schema.safeParse(await operation(input));
      return parsed.success ? { ok: true, data: parsed.data.data } : unavailable();
    } catch {
      return unavailable();
    }
  }
  return Object.freeze({
    models: (): Promise<AiSettingsResult<{ items: AiModelMetadata[] }>> =>
      run({ operation: "models" }, AiModelListResponseSchema),
    credentials: (): Promise<AiSettingsResult<{ items: AiCredentialMetadata[] }>> =>
      run({ operation: "credentials" }, AiCredentialListResponseSchema),
    config: (): Promise<AiSettingsResult<AiConfigView>> =>
      run({ operation: "config" }, AiRuntimeConfigResponseSchema),
    intent: (body: AiCredentialIntentRequest) =>
      run({ operation: "credentialIntent", body }, AiCredentialIntentResponseSchema),
    replace: (confirm_ref: string, step_up_proof_id: string, api_key: string) =>
      run(
        { operation: "secret", body: { confirm_ref, step_up_proof_id, api_key } },
        AiCredentialMutationResponseSchema,
      ),
    revoke: (credential_ref: string, confirm_ref: string, step_up_proof_id: string) =>
      run(
        { operation: "revoke", credential_ref, body: { confirm_ref, step_up_proof_id } },
        AiCredentialMutationResponseSchema,
      ),
    async validate(credential_ref: string, model_id: string) {
      const intent = await run(
        {
          operation: "validationIntent",
          body: {
            credential_ref,
            model_id,
            idempotency_key: crypto.randomUUID(),
          },
        },
        AiProviderValidationIntentResponseSchema,
      );
      if (!intent.ok) return intent;
      return run(
        { operation: "validate", body: { confirm_ref: intent.data.confirm_ref } },
        AiProviderValidationResponseSchema,
      );
    },
    save: (body: AiRuntimeConfigRequest) =>
      run({ operation: "configure", body }, AiRuntimeConfigResponseSchema),
  });
}

/** Browser transport only; the desktop implementation uses main-owned credentials. */
export function createHttpAiSettingsOperation(
  options: Readonly<{
    apiBaseUrl: string;
    fetchImpl: typeof fetch;
    getAccessToken: () => string | null;
    readCsrf: () => string | null;
  }>,
): AiOperationPort {
  // Call unbound: invoked as a method of options, a bare window.fetch throws Illegal invocation.
  const { fetchImpl } = options;
  return async (input) => {
    const token = options.getAccessToken();
    if (token === null) return null;
    const routes = {
      models: "models",
      credentials: "provider-credentials",
      config: "runtime-config",
      credentialIntent: "provider-credential-intents",
      secret: "provider-credentials/secret",
      validationIntent: "provider-validation-intents",
      validate: "provider-connections/validate",
      configure: "runtime-config",
    };
    let path: string;
    if (input.operation === "revoke") path = `provider-credentials/${input.credential_ref}/revoke`;
    else if (input.operation in routes) path = routes[input.operation as keyof typeof routes];
    else return null;
    const body = "body" in input ? input.body : undefined;
    const csrf = options.readCsrf();
    if (body !== undefined && csrf === null) return null;
    const response = await fetchImpl(
      `${options.apiBaseUrl.replace(/\/$/u, "")}/api/v2/ai/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "x-csrf-token": csrf ?? "",
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return response.json();
  };
}
