declare module "qrcode" {
  export function toDataURL(
    text: string,
    options?: Readonly<{ width?: number; margin?: number; errorCorrectionLevel?: "M" }>,
  ): Promise<string>;
}
