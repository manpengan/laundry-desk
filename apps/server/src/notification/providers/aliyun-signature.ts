import { createHash, createHmac } from "node:crypto";

export type AliyunCredentials = Readonly<{
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
}>;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const encode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** ACS3 signing is pure; only the SMS client chooses the fixed network destination. */
export function signAliyunRequest(
  input: Readonly<{
    host: string;
    action: string;
    version: string;
    parameters: Readonly<Record<string, string>>;
    timestamp: string;
    nonce: string;
    credentials: AliyunCredentials;
  }>,
): Readonly<{ query: string; headers: Readonly<Record<string, string>> }> {
  const { credentials } = input;
  if (
    !/^[A-Za-z0-9]{8,128}$/u.test(credentials.accessKeyId) ||
    !/^[\x21-\x7e]{8,256}$/u.test(credentials.accessKeySecret) ||
    (credentials.securityToken !== undefined &&
      !/^[\x21-\x7e]{1,8192}$/u.test(credentials.securityToken))
  )
    throw new Error("ALIYUN_CREDENTIAL_INVALID");
  if (
    !/^[a-z0-9.-]+$/u.test(input.host) ||
    !/^[A-Za-z]+$/u.test(input.action) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.version) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(input.timestamp) ||
    !/^[a-zA-Z0-9-]{16,64}$/u.test(input.nonce)
  )
    throw new Error("ALIYUN_SIGNATURE_INPUT_INVALID");
  const query = Object.keys(input.parameters)
    .sort()
    .map((key) => `${encode(key)}=${encode(input.parameters[key]!)}`)
    .join("&");
  const headers: Readonly<Record<string, string>> = Object.freeze({
    host: input.host,
    "x-acs-action": input.action,
    "x-acs-content-sha256": sha256(""),
    "x-acs-date": input.timestamp,
    "x-acs-signature-nonce": input.nonce,
    "x-acs-version": input.version,
    ...(credentials.securityToken === undefined
      ? {}
      : { "x-acs-security-token": credentials.securityToken }),
  });
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonical = [
    "POST",
    "/",
    query,
    names.map((name) => `${name}:${headers[name]}\n`).join(""),
    signedHeaders,
    sha256(""),
  ].join("\n");
  const signature = createHmac("sha256", credentials.accessKeySecret)
    .update(`ACS3-HMAC-SHA256\n${sha256(canonical)}`)
    .digest("hex");
  return Object.freeze({
    query,
    headers: Object.freeze({
      ...headers,
      authorization: `ACS3-HMAC-SHA256 Credential=${credentials.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
    }),
  });
}
