import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockAuthClient } from "../auth/AuthClient.js";
import { StepUpConfirmDialog } from "./StepUpConfirmDialog.js";
import { createStepUpAttemptAuthority } from "./step-up-attempt-authority.js";

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
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

test("a closed or scope-replaced step-up attempt cannot approve after PIN verification", async () => {
  for (const closeKind of ["Escape", "backdrop", "header close"] as const) {
    const authority = createStepUpAttemptAuthority();
    const verification = deferred<string>();
    const token = authority.begin(`scope-a:${closeKind}`);
    const submitted: string[] = [];
    const completion = verification.promise.then((value) => {
      if (authority.isCurrent(token, `scope-a:${closeKind}`)) submitted.push(value);
    });
    authority.invalidate();
    verification.resolve("must-not-submit-confirm-command");
    await completion;
    assert.deepEqual(submitted, [], closeKind);
  }

  const authority = createStepUpAttemptAuthority();
  const verification = deferred<string>();
  const token = authority.begin("scope-a:confirm-a");
  const submitted: string[] = [];
  const completion = verification.promise.then((value) => {
    if (authority.isCurrent(token, "scope-a:confirm-a")) submitted.push(value);
  });
  authority.begin("scope-b:confirm-b");
  verification.resolve("must-not-cross-scope");
  await completion;
  assert.deepEqual(submitted, []);
});
