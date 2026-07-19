import * as tencentcloud from "tencentcloud-sdk-nodejs-sms";
import { SettingsService } from "./settingsService";
import { getDb, schema } from "../db";

const SmsClient = tencentcloud.sms.v20210111.Client;

export class SmsService {
  /**
   * 发送取件通知
   */
  static async sendPickupNotification(
    phone: string,
    orderNo: string,
    pickupCode: string,
  ) {
    const enabled = await SettingsService.get("sms.enabled");
    if (!enabled) return;

    const secretId = await SettingsService.get("sms.tencent.secret_id");
    const secretKey = await SettingsService.get("sms.tencent.secret_key");
    const templateId = await SettingsService.get("sms.template_id");
    const sdkAppId = await SettingsService.get("sms.sdk_app_id");

    if (!secretId || !secretKey) {
      console.warn("SMS SecretKey 未配置");
      return;
    }

    const client = new SmsClient({
      credential: { secretId, secretKey },
      region: "ap-guangzhou",
    });

    const params = {
      PhoneNumberSet: [`+86${phone}`],
      SmsSdkAppId: sdkAppId,
      TemplateId: templateId,
      TemplateParamSet: [orderNo, pickupCode],
    };

    try {
      const res = await client.SendSms(params);

      // 记录到数据库
      const db = getDb();
      await db.insert(schema.smsLog).values({
        phone,
        content: `订单 ${orderNo} 已可取，取件码 ${pickupCode}`,
        status: res.SendStatusSet?.[0].Code === "Ok" ? "sent" : "failed",
        providerResponse: JSON.stringify(res),
        sentAt: new Date(),
      });

      return res;
    } catch (err) {
      console.error("短信发送失败:", err);
      throw err;
    }
  }
}
