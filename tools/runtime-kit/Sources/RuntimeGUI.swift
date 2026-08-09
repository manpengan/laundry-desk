import AppKit
import SwiftUI

private struct RuntimeView: View {
  let controller: NativeRuntimeController
  let runner: RuntimeRunner
  let executable: String
  @State private var manifestPath = ""
  @State private var username = ""
  @State private var displayName = ""
  @State private var password = ""
  @State private var pin = ""
  @State private var approverUsername = ""
  @State private var approverDisplayName = ""
  @State private var approverPassword = ""
  @State private var approverPin = ""
  @State private var status = "请选择已签名运行时清单"
  @State private var busy = false
  @State private var backups: [RuntimeBackupSummary] = []
  @State private var selectedBackupID = ""
  @State private var restoreConfirmation = ""
  @State private var rollbackConfirmation = ""

  private func chooseManifest() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    if panel.runModal() == .OK { manifestPath = panel.url?.path ?? "" }
  }

  private func action(
    clearCredentials: Bool = false, clearConfirmation: Bool = false,
    clearRollbackConfirmation: Bool = false,
    _ work: @escaping () throws -> String
  ) {
    guard !busy else { return }
    busy = true
    status = "处理中…"
    DispatchQueue.global(qos: .userInitiated).async {
      let result: String
      do { result = try work() } catch {
        result = (error as? RuntimeKitError)?.description ?? "RUNTIME_OPERATION_FAILED"
      }
      DispatchQueue.main.async {
        status = result
        busy = false
        if clearCredentials {
          password = ""
          pin = ""
          approverPassword = ""
          approverPin = ""
        }
        if clearConfirmation { restoreConfirmation = "" }
        if clearRollbackConfirmation { rollbackConfirmation = "" }
      }
    }
  }

  private var selectedBackup: RuntimeBackupSummary? {
    backups.first(where: { $0.backupID == selectedBackupID })
  }

  private func refreshBackups() {
    action {
      let values = try controller.listBackups()
      DispatchQueue.main.async {
        backups = values
        if !values.contains(where: { $0.backupID == selectedBackupID }) {
          selectedBackupID = values.first?.backupID ?? ""
        }
      }
      return "已读取 \(values.count) 个托管备份"
    }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Text("Laundry Desk Runtime").font(.title2).bold()
        HStack {
          TextField("签名 manifest", text: $manifestPath).disabled(true)
          Button("选择…", action: chooseManifest)
        }
        GroupBox("首位管理员") {
          TextField("管理员用户名", text: $username)
          TextField("管理员显示名", text: $displayName)
          SecureField("管理员密码（12–256 位）", text: $password)
          SecureField("管理员 PIN（6–8 位）", text: $pin)
        }
        GroupBox("第二位审批管理员（凭据必须独立）") {
          TextField("审批管理员用户名", text: $approverUsername)
          TextField("审批管理员显示名", text: $approverDisplayName)
          SecureField("审批管理员密码（12–256 位）", text: $approverPassword)
          SecureField("审批管理员 PIN（6–8 位）", text: $approverPin)
        }
        HStack {
          Button("安装") {
            let selectedManifest = manifestPath
            let setup = RuntimeSetup(
              adminUsername: username, adminDisplayName: displayName,
              adminPassword: password, adminPin: pin,
              approverUsername: approverUsername,
              approverDisplayName: approverDisplayName,
              approverPassword: approverPassword, approverPin: approverPin)
            action(clearCredentials: true) {
              try controller.install(
                manifestURL: URL(fileURLWithPath: selectedManifest), setup: setup)
            }
          }
          Button("补齐既有门店投产") {
            let setup = RuntimeCommissionSetup(
              approverUsername: approverUsername,
              approverDisplayName: approverDisplayName,
              approverPassword: approverPassword, approverPin: approverPin)
            action(clearCredentials: true) {
              let value = try controller.commission(setup)
              let lan =
                value.lanFaultCode.map { "\(value.lanStatus)（\($0)）" }
                ?? value.lanStatus
              return "门店投产完成：\(value.release)；LAN：\(lan)"
            }
          }
          Button("恢复安装") {
            let selectedManifest = manifestPath
            action(clearCredentials: true) {
              try controller.recover(manifestURL: URL(fileURLWithPath: selectedManifest))
            }
          }
          Button("升级") {
            let selectedManifest = manifestPath
            action {
              let value = try controller.upgrade(
                manifestURL: URL(fileURLWithPath: selectedManifest))
              let lan =
                value.lanFaultCode.map { "\(value.lanStatus)（\($0)）" }
                ?? value.lanStatus
              return
                "升级完成：\(value.release)；LAN：\(lan)；回滚确认：ROLLBACK-\(value.previousRelease)"
            }
          }
          Button("启动") { action { try controller.start() } }
          Button("停止") { action { try controller.stop() } }
          Button("重启") { action { try controller.restart() } }
        }.disabled(busy)
        HStack {
          Button("状态") {
            action {
              String(decoding: try JSONEncoder().encode(controller.diagnose()), as: UTF8.self)
            }
          }
          Button("安装开机启动") {
            action {
              try controller.installLaunchAgent(executable: executable)
            }
          }
          Button("卸载开机启动") {
            action {
              try controller.uninstallLaunchAgent()
            }
          }
        }.disabled(busy)
        HStack {
          TextField("高风险回滚确认：ROLLBACK-目标版本", text: $rollbackConfirmation)
          Button("回滚到上一版本") {
            let confirmation = rollbackConfirmation
            action(clearRollbackConfirmation: true) {
              let value = try controller.rollback(
                RuntimeRollbackRequest(confirmation: confirmation))
              let lan =
                value.lanFaultCode.map { "\(value.lanStatus)（\($0)）" }
                ?? value.lanStatus
              return "已回滚到 \(value.release)；LAN：\(lan)；当前数据安全点：\(value.recoveryBackupID)"
            }
          }
          .disabled(busy || !rollbackConfirmation.hasPrefix("ROLLBACK-"))
        }
        Text("回滚会恢复升级前一致性数据；升级后的当前数据先保存为安全点。")
          .font(.caption).foregroundStyle(.red)
        Divider()
        Text("本机托管备份与恢复").font(.headline)
        HStack {
          Button("创建备份") {
            action {
              let value = try controller.createBackup()
              DispatchQueue.main.async {
                backups = [value] + backups.filter { $0.backupID != value.backupID }
                selectedBackupID = value.backupID
              }
              let lan =
                value.lanFaultCode.map { "\(value.lanStatus ?? "unknown")（\($0)）" }
                ?? value.lanStatus ?? "unknown"
              return "备份已创建：\(value.backupID)；LAN：\(lan)"
            }
          }
          Button("刷新列表", action: refreshBackups)
          Button("验证所选") {
            let backupID = selectedBackupID
            action {
              guard !backupID.isEmpty else { try runtimeFail("RUNTIME_BACKUP_ID_INVALID") }
              let value = try controller.verifyBackup(backupID)
              DispatchQueue.main.async {
                backups = backups.map { $0.backupID == value.backupID ? value : $0 }
              }
              return "备份验证通过：\(value.backupID)"
            }
          }
        }.disabled(busy)
        Picker("托管备份", selection: $selectedBackupID) {
          if backups.isEmpty { Text("暂无备份").tag("") }
          ForEach(backups) { backup in
            Text("\(backup.backupID)\(backup.verified ? "" : "（损坏）")")
              .tag(backup.backupID)
          }
        }
        if let backup = selectedBackup {
          Text("确认摘要：\(backup.confirmation ?? backup.faultCode ?? "不可恢复")")
            .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        }
        TextField("输入完整确认摘要后才能恢复", text: $restoreConfirmation)
        HStack {
          Text("高风险：恢复会先停服并创建安全点；任一步失败都保持停服。")
            .foregroundStyle(.red)
          Spacer()
          Button("恢复所选备份") {
            let request = RuntimeRestoreRequest(
              backupID: selectedBackupID, confirmation: restoreConfirmation)
            action(clearConfirmation: true) {
              let value = try controller.restoreBackup(request)
              let lan =
                value.lanFaultCode.map { "\(value.lanStatus)（\($0)）" }
                ?? value.lanStatus
              return "恢复完成；安全点：\(value.safetyBackupID)；LAN：\(lan)"
            }
          }
          .disabled(
            busy || selectedBackup?.verified != true
              || restoreConfirmation != selectedBackup?.confirmation)
        }
        RuntimeGUIDataProtection(controller: controller)
        RuntimeLanView(controller: controller)
        Text(status).font(.system(.body, design: .monospaced)).textSelection(.enabled)
      }.padding(20).disabled(busy)
    }.frame(minWidth: 760, minHeight: 760)
  }
}

private final class RuntimeAppDelegate: NSObject, NSApplicationDelegate {
  let window: NSWindow
  init(controller: NativeRuntimeController, runner: RuntimeRunner, executable: String) {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
      styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "Laundry Desk Runtime"
    window.contentView = NSHostingView(
      rootView: RuntimeView(
        controller: controller,
        runner: runner, executable: executable))
    super.init()
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

enum RuntimeGUI {
  private static var delegate: RuntimeAppDelegate?
  static func launch(
    controller: NativeRuntimeController, runner: RuntimeRunner,
    executable: String
  ) {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let value = RuntimeAppDelegate(controller: controller, runner: runner, executable: executable)
    delegate = value
    app.delegate = value
    app.run()
  }
}
