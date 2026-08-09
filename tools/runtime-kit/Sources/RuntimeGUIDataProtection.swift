import AppKit
import SwiftUI

struct RuntimeGUIDataProtection: View {
  let controller: NativeRuntimeController
  @State private var busy = false
  @State private var status = "尚未检查定时保护"
  @State private var maintenanceOK = true
  @State private var backups: [RuntimeBackupSummary] = []
  @State private var backupID = ""
  @State private var exportPath = ""
  @State private var exportPassword = ""
  @State private var importPath = ""
  @State private var importPassword = ""
  @State private var importConfirmation = ""
  @State private var inspected: RuntimeTransferInspectResult?

  private func action(
    clearExportPassword: Bool = false, clearImportPassword: Bool = false,
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
        if clearExportPassword { exportPassword = "" }
        if clearImportPassword { importPassword = "" }
      }
    }
  }

  private func refresh() {
    action {
      let diagnosis = controller.diagnoseMaintenance()
      let values = try controller.listBackups().filter { $0.verified }
      DispatchQueue.main.async {
        maintenanceOK = diagnosis.ok
        backups = values
        if !values.contains(where: { $0.backupID == backupID }) {
          backupID = values.first?.backupID ?? ""
        }
      }
      if diagnosis.stale { return "定时保护已超过 26 小时未成功" }
      if let fault = diagnosis.lastFailureCode { return "定时保护故障：\(fault)" }
      return "定时保护正常；可导出备份 \(values.count) 份"
    }
  }

  private func chooseExportPath() {
    let panel = NSSavePanel()
    panel.canCreateDirectories = true
    panel.isExtensionHidden = false
    panel.allowedFileTypes = ["laundry-transfer"]
    panel.nameFieldStringValue = "laundry-transfer.laundry-transfer"
    if panel.runModal() == .OK { exportPath = panel.url?.path ?? "" }
  }

  private func chooseImportPath() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    panel.allowedFileTypes = ["laundry-transfer"]
    if panel.runModal() == .OK {
      importPath = panel.url?.path ?? ""
      inspected = nil
      importConfirmation = ""
    }
  }

  var body: some View {
    GroupBox("定时保护与加密换机") {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Button("刷新保护状态", action: refresh)
          Button("立即执行定时保护") {
            action {
              let value = try controller.maintenance()
              DispatchQueue.main.async { maintenanceOK = true }
              return "定时保护完成：\(value.backupID)"
            }
          }
          Text(status).foregroundStyle(maintenanceOK ? Color.primary : Color.red)
        }
        Divider()
        Picker("导出已验证备份", selection: $backupID) {
          if backups.isEmpty { Text("无可导出备份").tag("") }
          ForEach(backups) { backup in Text(backup.backupID).tag(backup.backupID) }
        }
        HStack {
          Button(exportPath.isEmpty ? "选择导出位置…" : "已选择导出位置", action: chooseExportPath)
          SecureField("导出密码（12–256 UTF-8 bytes）", text: $exportPassword)
          Button("加密导出") {
            let request = RuntimeTransferExportRequest(
              backupID: backupID, path: exportPath, password: exportPassword)
            action(clearExportPassword: true) {
              let value = try controller.exportTransfer(request)
              return "导出完成：\(value.bytes) bytes；确认：\(value.confirmation)"
            }
          }
          .disabled(backupID.isEmpty || exportPath.isEmpty || exportPassword.isEmpty)
        }
        Divider()
        HStack {
          Button(importPath.isEmpty ? "选择换机包…" : "已选择换机包", action: chooseImportPath)
          SecureField("换机包密码", text: $importPassword)
          Button("检查换机包") {
            let request = RuntimeTransferInspectRequest(
              path: importPath, password: importPassword)
            action(clearImportPassword: true) {
              let value = try controller.inspectTransfer(request)
              DispatchQueue.main.async { inspected = value }
              return value.compatible ? "换机包兼容" : "换机包与当前版本不兼容"
            }
          }
          .disabled(importPath.isEmpty || importPassword.isEmpty)
        }
        if let value = inspected {
          Text("来源实例：\(value.sourceInstanceID)；发布：\(value.release)")
          Text("确认摘要：\(value.confirmation)")
            .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
          HStack {
            SecureField("重新输入换机包密码", text: $importPassword)
            TextField("输入完整确认摘要", text: $importConfirmation)
            Button("导入并替换本机业务数据") {
              let request = RuntimeTransferImportRequest(
                path: importPath, password: importPassword,
                confirmation: importConfirmation)
              action(clearImportPassword: true) {
                let result = try controller.importTransfer(request)
                return "导入完成：\(result.release)；安全点：\(result.safetyBackupID)"
              }
            }
            .disabled(
              !value.compatible || importPassword.isEmpty
                || importConfirmation != value.confirmation)
          }
          Text("高风险：导入会停服并替换数据库和照片；失败将保持停服。")
            .font(.caption).foregroundStyle(.red)
        }
      }
      .padding(8)
      .disabled(busy)
    }
    .onAppear(perform: refresh)
  }
}
