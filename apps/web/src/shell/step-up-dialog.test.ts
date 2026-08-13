import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockAuthClient } from "../auth/AuthClient.js";
import { createStepUpAttemptAuthority } from "./step-up-attempt-authority.js";
import { StepUpConfirmDialog } from "./StepUpConfirmDialog.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return Object.freeze({ promise, resolve });
}

test("StepUpConfirmDialog SSR shows approver PIN copy", () => {
  const authClient = createMockAuthClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(StepUpConfirmDialog, {
        open: true,
        onClose: () => undefined,
        authClient,
        confirmRef: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        currentStaffId: "11111111-1111-4111-8111-111111111101",
        commandLabel: "修改最低消费",
        summary: createElement("p", null, "冻结快照：退款本金 ¥100.00，渠道现金，原因顾客退卡"),
        onApproved: () => undefined,
      }),
    ),
  );
  assert.match(html, /需要现场复核/);
  assert.match(html, /修改最低消费/);
  assert.match(html, /复核人 PIN/);
  assert.match(html, /不会切换当前登录人/);
  assert.match(html, /另一位店长输入 PIN/);
  assert.match(html, /店长（店长）/u);
  assert.doesNotMatch(html, /店员乙/u);
  assert.match(html, /data-testid="step-up-summary"/);
  assert.match(html, /退款本金 ¥100.00，渠道现金，原因顾客退卡/);
});

test("StepUpConfirmDialog exposes only other administrators for every step-up", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(StepUpConfirmDialog, {
        open: true,
        onClose: () => undefined,
        authClient: createMockAuthClient(),
        confirmRef: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        currentStaffId: "11111111-1111-4111-8111-111111111101",
        commandLabel: "导出客户数据",
        onApproved: () => undefined,
      }),
    ),
  );
  assert.match(html, /另一位.*店长.*输入 PIN/su);
  assert.match(html, /店长（店长）/u);
  assert.doesNotMatch(html, /店员乙/u);
});

test("a closed or scope-replaced step-up attempt cannot approve after verification resolves", async () => {
  const authority = createStepUpAttemptAuthority();
  const closedVerification = deferred<string>();
  const closedToken = authority.begin("scope-a:confirm-a");
  const submitted: string[] = [];
  const closedAttempt = closedVerification.promise.then((value) => {
    if (authority.isCurrent(closedToken, "scope-a:confirm-a")) submitted.push(value);
  });

  authority.invalidate(); // Escape, backdrop, header close, or explicit cancel.
  closedVerification.resolve("cancelled-confirm");
  await closedAttempt;

  const switchedVerification = deferred<string>();
  const switchedToken = authority.begin("scope-a:confirm-b");
  const switchedAttempt = switchedVerification.promise.then((value) => {
    if (authority.isCurrent(switchedToken, "scope-a:confirm-b")) submitted.push(value);
  });
  authority.begin("scope-b:confirm-c");
  switchedVerification.resolve("old-scope-confirm");
  await switchedAttempt;
  assert.deepEqual(submitted, []);
});
