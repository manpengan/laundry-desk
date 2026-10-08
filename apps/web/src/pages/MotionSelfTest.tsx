/** 设置 → 外观 → 检测流畅度: measure this PC before choosing a motion tier (ADR-99). */

import { Button } from "@laundry/ui";
import { useState } from "react";

import { frameReportText, runMotionSelfTest, type FrameReport } from "../motion-self-test.js";
import type { ThemeControl } from "../shell/shell-shortcuts.js";

type SelfTestState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ phase: "running" }>
  | Readonly<{ phase: "done"; report: FrameReport }>;

export function MotionSelfTest({
  theme,
}: Readonly<{ theme: Pick<ThemeControl, "motion" | "resolvedMotion" | "setMotion"> }>) {
  const [state, setState] = useState<SelfTestState>({ phase: "idle" });
  // System reduce-motion: never animate on the user's behalf, not even to measure.
  const blocked = theme.resolvedMotion === "off" && theme.motion !== "off";
  const start = (): void => {
    if (typeof document === "undefined") return;
    setState({ phase: "running" });
    void runMotionSelfTest(document).then((report) => setState({ phase: "done", report }));
  };
  const report = state.phase === "done" ? state.report : null;
  const suggestCalm = report !== null && report.verdict !== "smooth" && theme.motion !== "calm";
  return (
    <div className="ld-settings-appearance__test" aria-live="polite">
      <Button
        variant="secondary"
        size="sm"
        disabled={blocked || state.phase === "running"}
        onClick={start}
      >
        {state.phase === "running" ? "检测中…（约 3 秒）" : "检测流畅度"}
      </Button>
      <span>
        {report === null
          ? "以标准动效运行 3 秒并测量帧率，判断这台电脑适合哪一档。"
          : frameReportText(report)}
      </span>
      {suggestCalm ? (
        <Button variant="ghost" size="sm" onClick={() => theme.setMotion("calm")}>
          改用节能
        </Button>
      ) : null}
    </div>
  );
}
