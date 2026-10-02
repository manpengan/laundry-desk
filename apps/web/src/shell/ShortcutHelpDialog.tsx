import { Button, Dialog, Kbd } from "@laundry/ui";
import { Fragment } from "react";

export type ShortcutRow = Readonly<{ keys: readonly string[]; action: string }>;
export type ShortcutSection = Readonly<{ title: string; rows: readonly ShortcutRow[] }>;

/** Single source for every keyboard affordance shown in the counter UI. */
export const COUNTER_SHORTCUTS: readonly ShortcutSection[] = Object.freeze([
  Object.freeze({
    title: "全局",
    rows: Object.freeze([
      Object.freeze({
        keys: ["Ctrl", "K"],
        action: "打开命令面板：跳转页面、查找票号 / 手机号 / 客户",
      }),
      Object.freeze({ keys: ["Alt", "1…0"], action: "按侧栏顺序切换页面（1 = 工作台）" }),
      Object.freeze({ keys: ["Ctrl", "/"], action: "查看本快捷键说明" }),
      Object.freeze({ keys: ["Esc"], action: "关闭对话框、抽屉或命令面板" }),
    ]),
  }),
  Object.freeze({
    title: "扫码与查找",
    rows: Object.freeze([
      Object.freeze({ keys: ["扫码枪"], action: "进入页面即对准主输入框，扫描后自动回车查找" }),
      Object.freeze({ keys: ["Enter"], action: "在查找框内立即查找 / 加入首个匹配价目" }),
    ]),
  }),
  Object.freeze({
    title: "开单",
    rows: Object.freeze([
      Object.freeze({ keys: ["F1…F11"], action: "切换服务类别（与价目表页签顺序一致）" }),
      Object.freeze({ keys: ["/"], action: "定位到价目搜索" }),
      Object.freeze({ keys: ["Ctrl", "Enter"], action: "确认开单" }),
    ]),
  }),
]);

export type ShortcutHelpDialogProps = Readonly<{ open: boolean; onClose: () => void }>;

export function ShortcutHelpDialog({ open, onClose }: ShortcutHelpDialogProps) {
  return (
    <Dialog
      open={open}
      title="键盘快捷键"
      onClose={onClose}
      className="ld-shortcut-help"
      footer={
        <Button variant="primary" onClick={onClose}>
          知道了
        </Button>
      }
    >
      {COUNTER_SHORTCUTS.map((section) => (
        <section key={section.title} className="ld-shortcut-help__section">
          <h3 className="ld-shortcut-help__title">{section.title}</h3>
          <dl className="ld-shortcut-help__list">
            {section.rows.map((row) => (
              <Fragment key={row.action}>
                <dt>
                  {row.keys.map((key, index) => (
                    <Fragment key={key}>
                      {index > 0 ? <span className="ld-shortcut-help__plus">+</span> : null}
                      <Kbd>{key}</Kbd>
                    </Fragment>
                  ))}
                </dt>
                <dd>{row.action}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      ))}
    </Dialog>
  );
}
