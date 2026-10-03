import assert from "node:assert/strict";
import test from "node:test";
import { createAliyunSmsClient, type AliyunSmsSendInput } from "./aliyun-client.js";
import { signAliyunRequest } from "./aliyun-signature.js";

const credentials = { accessKeyId: "YourAccessKeyId", accessKeySecret: "YourAccessKeySecret" };
const fixed = {
  credentials: async () => credentials,
  now: () => new Date("2026-10-03T02:00:00Z"),
  nonce: () => "3156853299f313e23d1673dc12e1703d",
};
const input: AliyunSmsSendInput = {
  phone: "13900000000",
  deliveryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  signName: "合成门店",
  templateCode: "SMS_123456",
  parameters: { tickets: "TEST-001", garment_count: "2", balance_cents: "300" },
};
const signal = (): AbortSignal => new AbortController().signal;

test("ACS3 agrees with the Alibaba public reference signature, not a self-generated oracle", () => {
  const signed = signAliyunRequest({
    host: "ecs.cn-shanghai.aliyuncs.com",
    action: "RunInstances",
    version: "2014-05-26",
    credentials,
    timestamp: "2023-10-26T10:22:32Z",
    nonce: "3156853299f313e23d1673dc12e1703d",
    parameters: {
      ImageId: "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd",
      RegionId: "cn-shanghai",
    },
  });
  assert.ok(
    signed.headers.authorization?.endsWith(
      "Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0",
    ),
  );
});

test("SMS calls only the fixed HTTPS endpoint, signs the exact template parameters and does not follow redirects", async () => {
  let calls = 0;
  const client = createAliyunSmsClient({
    ...fixed,
    fetch: async (url, init) => {
      calls++;
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://dysmsapi.aliyuncs.com");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["x-acs-action"], "SendSms");
      assert.equal(parsed.searchParams.get("OutId"), input.deliveryId);
      assert.equal(parsed.searchParams.get("SignName"), input.signName);
      assert.deepEqual(JSON.parse(parsed.searchParams.get("TemplateParam")!), input.parameters);
      assert.equal(url.includes(credentials.accessKeySecret), false);
      return Response.json({ Code: "OK", BizId: "123^456", Message: "provider data is discarded" });
    },
  });
  assert.deepEqual(await client.send(input, signal()), { status: "accepted", bizId: "123^456" });
  assert.equal(calls, 1);
});

test("an ambiguous send is never retried, and private network errors never escape", async () => {
  let calls = 0;
  const client = createAliyunSmsClient({
    ...fixed,
    fetch: async () => {
      calls++;
      throw new Error("secret credential and recipient");
    },
  });
  assert.deepEqual(await client.send(input, signal()), {
    status: "uncertain",
    code: "ALIYUN_OUTCOME_UNKNOWN",
  });
  assert.equal(calls, 1);
});

test("rejection, invalid/missing receipts, redirects and oversized responses fail safely", async () => {
  for (const response of [
    Response.json({ Code: "OK" }),
    Response.json({ Code: "OK", BizId: "private data\n" }),
    new Response(null, { status: 302 }),
    new Response("x".repeat(65537)),
  ]) {
    const client = createAliyunSmsClient({ ...fixed, fetch: async () => response });
    assert.equal((await client.send(input, signal())).status, "uncertain");
  }
  const rejected = createAliyunSmsClient({
    ...fixed,
    fetch: async () =>
      Response.json({ Code: "isv.SIGN_NAME_ILLEGAL", Message: "private provider detail" }),
  });
  assert.deepEqual(await rejected.send(input, signal()), {
    status: "rejected",
    code: "ALIYUN_REQUEST_REJECTED",
  });
});

test("input validation and cancellation prevent dispatch", async () => {
  let calls = 0;
  const client = createAliyunSmsClient({
    ...fixed,
    fetch: async () => {
      calls++;
      return Response.json({ Code: "OK" });
    },
  });
  await assert.rejects(client.send({ ...input, phone: "13900000000,13800000000" }, signal()));
  await assert.rejects(
    client.send(
      { ...input, parameters: { ...input.parameters, tickets: "unapproved text\n" } },
      signal(),
    ),
  );
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await client.send(input, aborted.signal)).status, "uncertain");
  assert.equal(calls, 0);
});

test("receipts are matched by phone, delivery id and approved template before settlement", async () => {
  for (const status of [1, 2, 3] as const) {
    const client = createAliyunSmsClient({
      ...fixed,
      fetch: async () =>
        Response.json({
          Code: "OK",
          TotalCount: "2",
          SmsSendDetailDTOs: {
            SmsSendDetailDTO: [
              {
                OutId: "other",
                PhoneNum: input.phone,
                TemplateCode: input.templateCode,
                SendStatus: 3,
                Content: "must not return",
              },
              {
                OutId: input.deliveryId,
                PhoneNum: input.phone,
                TemplateCode: input.templateCode,
                SendStatus: status,
              },
            ],
          },
        }),
    });
    assert.equal(
      await client.query(
        {
          phone: input.phone,
          deliveryId: input.deliveryId,
          templateCode: input.templateCode,
          sendDate: "20261003",
        },
        signal(),
      ),
      status === 1 ? "pending" : status === 2 ? "failed" : "delivered",
    );
  }
});

test("duplicate matches and incomplete pagination cannot falsely prove delivery", async () => {
  let pages = 0;
  const client = createAliyunSmsClient({
    ...fixed,
    fetch: async () => {
      pages++;
      return Response.json({
        Code: "OK",
        TotalCount: "1000",
        SmsSendDetailDTOs: { SmsSendDetailDTO: [] },
      });
    },
  });
  const query = {
    phone: input.phone,
    deliveryId: input.deliveryId,
    templateCode: input.templateCode,
    sendDate: "20261003",
  };
  assert.equal(await client.query(query, signal()), "unknown");
  assert.equal(pages, 10);
  const duplicate = createAliyunSmsClient({
    ...fixed,
    fetch: async () =>
      Response.json({
        Code: "OK",
        TotalCount: 2,
        SmsSendDetailDTOs: {
          SmsSendDetailDTO: [1, 2].map(() => ({
            OutId: input.deliveryId,
            PhoneNum: input.phone,
            TemplateCode: input.templateCode,
            SendStatus: 3,
          })),
        },
      }),
  });
  assert.equal(await duplicate.query(query, signal()), "unknown");
});
