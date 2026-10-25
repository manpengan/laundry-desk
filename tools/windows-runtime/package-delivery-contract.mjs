import { isAbsolute, resolve } from "node:path";
import { exactKeys } from "./companion-contract.mjs";

export const DELIVERY_SCHEMA = "laundry.windows.delivery";
export const PROFILES = Object.freeze(["generic", "hongfa"]);
export const HASH = /^[a-f0-9]{64}$/u;
export const SOURCE = /^[a-f0-9]{40}$/u;
const isHash = (value) => typeof value === "string" && HASH.test(value);
export const REPORT_KEYS = Object.freeze([
  "runtime_maintenance",
  "source_git_sha",
  "profile",
  "assurance",
  "installer_sha256",
  "installed",
]);
export const EXECUTABLES = Object.freeze({
  generic: "laundry-desk V2.exe",
  hongfa: "宏发洗衣 V2（开发版）.exe",
});

export function deliveryFailure(code) {
  throw new Error(`WINDOWS_DELIVERY_${code}`);
}

export function absolutePath(value) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  )
    deliveryFailure("PATH_INVALID");
  return value;
}

export function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    deliveryFailure("JSON_INVALID");
  }
}

export function requireDeliveryInput(value) {
  if (
    !exactKeys(value, ["schema", "version", "source_git_sha", "runtime_entry", "counters"]) ||
    value.schema !== "laundry.windows.delivery-input" ||
    value.version !== 1 ||
    typeof value.source_git_sha !== "string" ||
    !SOURCE.test(value.source_git_sha) ||
    !exactKeys(value.runtime_entry, ["directory", "evidence_sha256", "manifest_sha256"]) ||
    !isHash(value.runtime_entry.evidence_sha256) ||
    !isHash(value.runtime_entry.manifest_sha256) ||
    !exactKeys(value.counters, PROFILES)
  )
    deliveryFailure("INPUT_INVALID");
  absolutePath(value.runtime_entry.directory);
  for (const profile of PROFILES) {
    const item = value.counters[profile];
    if (
      !exactKeys(item, ["installer", "installed_report", "report_sha256"]) ||
      !isHash(item.report_sha256)
    )
      deliveryFailure("INPUT_INVALID");
    absolutePath(item.installer);
    absolutePath(item.installed_report);
  }
  return value;
}

export function requireInstalledReport(value, profile, sourceSha, runtime) {
  if (
    !exactKeys(value, REPORT_KEYS) ||
    value.source_git_sha !== sourceSha ||
    value.profile !== profile ||
    value.assurance !== "development_only" ||
    !isHash(value.installer_sha256) ||
    !exactKeys(value.runtime_maintenance, ["source_git_sha", "manifest_sha256", "entry_sha256"]) ||
    value.runtime_maintenance.source_git_sha !== sourceSha ||
    value.runtime_maintenance.manifest_sha256 !== runtime.manifest_sha256 ||
    value.runtime_maintenance.entry_sha256 !== runtime.entry_sha256 ||
    !exactKeys(value.installed, [
      EXECUTABLES[profile],
      "resources/app.asar",
      "resources/distribution-profile/binding.json",
    ]) ||
    Object.values(value.installed).some((hash) => typeof hash !== "string" || !HASH.test(hash))
  )
    deliveryFailure("COUNTER_BINDING_INVALID");
  return value;
}

export function deliveryInstructions(sourceSha) {
  return `# Laundry Desk V2 Windows 交付包

源码：${sourceSha}
状态：development_only，未签名，仅用于合成数据验收。目录完整性通过不表示真实运营准入。
两种柜台共用本机 Runtime；选择 generic 或 hongfa 中的一种安装。

## 核对与安装
1. 从可信交付渠道单独取得 delivery-index.json 的 SHA-256，与 Get-FileHash 的结果核对。
   SHA256SUMS 列出目录内文件（不包含该校验单自身）；逐项核对后再运行文件。
   同目录中的校验单不能替代外部来源信任，也不构成发布者数字签名。
2. 完整解压到本机普通目录，保留 Runtime 下的所有文件。不要在压缩包中直接运行。
3. 双击 Runtime\\Laundry Runtime V2.cmd，选择“初始化全新空库”开始合成数据体验。
   两位操作者分别设置测试账号、显示名、至少12位长密码和6–8位数字 PIN，并再次确认输入。
   两人的账号、密码和 PIN 各自不同；保管自己设置的凭据，不写入聊天或交付目录。
   本包不附带密码或客户数据库。“安装本地服务”生成自动化测试凭据，不作为普通体验的默认流程。
   已有实例/任务/端口冲突时保留原状态，不删目录、清库或覆盖安装。
4. 安装 Counter\\counter-generic.exe 或 Counter\\counter-hongfa.exe。
   用普通 Windows 用户启动柜台，确认服务就绪后使用刚设置的账号与密码登录。
   单独复制柜台 EXE 不含 Runtime；初始化成功仍只允许合成数据体验。

## 升级与回退
先退出柜台并从原受信维护入口完成备份和验证，保留原交付包及其外部摘要。
使用配套新 Runtime 维护入口执行“升级”，再安装对应新 Counter；不要混用不同源码发行。
跨迁移升级/回退必须由原维护功能成对处理程序和数据库，不能只替换 EXE 或手改状态文件。
柜台卸载不等于数据删除。发生未知错误时停止继续写入，保留证据和原包。

## 备份与恢复
退出柜台后，在 Runtime 维护入口创建备份、验证备份，并演练恢复。
真实恢复须人工选择备份、输入该备份完整确认摘要；不要把发行摘要当作备份确认摘要。
中断时先查看状态，再按维护入口执行恢复未完成操作；不要删除未知数据库或恢复记录。
离机归档使用独立介质，口令单独保管。换机恢复需另行实测，不由同机备份成功代替。

## 证据与范围
Evidence 内为受信构建流程取得的安装校验回执，绑定安装器字节、源码和 Runtime。
该回执覆盖安装时的文件配对，不代表所有业务、现场操作、跨机器恢复或运营验收已通过。
本包不包含源码仓库、Node/pnpm 安装依赖、数据库、测试凭据或用户状态。
Runtime 自带所需运行文件；外部服务和打印仅在另行验收并授权后启用。
ADR-98、签名/内部分发政策、数据责任、恢复目标和现场验收仍按项目记录执行。
`;
}
