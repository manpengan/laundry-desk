import { z } from "zod";

const Base64Schema = z
  .string()
  .min(4)
  .max(196_608)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
export const AiVisionPhotoBindingSchema = z
  .object({ photo_id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
export const AiVisionRequestSchema = z
  .object({
    request_id: z.uuid(),
    mode: z.enum(["assist", "match"]),
    image_base64: Base64Schema,
    candidates: z.array(AiVisionPhotoBindingSchema).max(2),
    consent: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.mode === "assist" && value.candidates.length !== 0) ||
      (value.mode === "match" && value.candidates.length === 0) ||
      new Set(value.candidates.map((item) => item.photo_id)).size !== value.candidates.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Select distinct candidate photos for matching only",
      });
  });
export const AiVisionCandidateQuerySchema = z
  .object({ key: z.string().trim().min(1).max(64) })
  .strict();
export const AiVisionCandidateSchema = AiVisionPhotoBindingSchema.extend({
  ticket_no: z.string().min(1).max(64),
  barcode: z.string().min(1).max(64),
  thumbnail_base64: Base64Schema.max(32_768),
}).strict();
export const AiVisionCandidatesResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        candidates: z.array(AiVisionCandidateSchema).max(6),
        limit: z.literal(6),
      })
      .strict(),
  })
  .strict();
export const AiVisionAnalysisSchema = z
  .object({
    category: z.enum(["上衣", "裤装", "裙装", "外套", "鞋靴", "家纺", "其他", "无法判断"]),
    colors: z
      .array(
        z.enum([
          "黑",
          "白",
          "灰",
          "红",
          "橙",
          "黄",
          "绿",
          "蓝",
          "紫",
          "棕",
          "米",
          "多色",
          "无法判断",
        ]),
      )
      .min(1)
      .max(4),
    visible_marks: z
      .array(z.enum(["可见污渍", "疑似破损", "褶皱", "未见明显问题", "无法判断"]))
      .min(1)
      .max(4),
    comparisons: z
      .array(
        z
          .object({
            candidate_index: z.number().int().min(1).max(2),
            similarity: z.enum(["可能相似", "不相似", "无法判断"]),
            reasons: z
              .array(z.enum(["颜色", "形状", "图案", "细节", "清晰度不足"]))
              .min(1)
              .max(3),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
export const AiVisionResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        analysis: AiVisionAnalysisSchema,
        candidates: z.array(AiVisionPhotoBindingSchema).max(2),
        turn_id: z.uuid(),
        advisory_only: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type AiVisionRequest = Readonly<z.output<typeof AiVisionRequestSchema>>;
export type AiVisionCandidate = Readonly<z.output<typeof AiVisionCandidateSchema>>;
export type AiVisionResult = Readonly<z.output<typeof AiVisionResponseSchema>["data"]>;
