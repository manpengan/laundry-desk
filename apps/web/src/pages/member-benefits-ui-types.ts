export type BenefitToast = Readonly<{
  push: (message: string, kind: "success" | "error") => void;
}>;

export type RunBenefitMutation = (
  command: string,
  body: unknown,
  title: string,
  success: string,
) => void | Promise<void>;
