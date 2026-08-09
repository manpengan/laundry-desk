import AppKit
import SwiftUI

struct RuntimeLanView: View {
  let controller: NativeRuntimeController
  @State private var bindIPv4 = ""
  @State private var port = "9443"
  @State private var certificatePEM = ""
  @State private var privateKeyPEM = ""
  @State private var status = "尚未读取 LAN 配置"
  @State private var busy = false

  private func encoded<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }

  private func action(clearPrivateKey: Bool = false, _ work: @escaping () throws -> String) {
    guard !busy else { return }
    busy = true
    status = "处理中…"
    DispatchQueue.global(qos: .userInitiated).async {
      let result: String
      do { result = try work() } catch {
        result = (error as? RuntimeKitError)?.description ?? "RUNTIME_LAN_OPERATION_FAILED"
      }
      DispatchQueue.main.async {
        status = result
        busy = false
        if clearPrivateKey { privateKeyPEM = "" }
      }
    }
  }

  private func choosePrivateKey() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    guard panel.runModal() == .OK, let url = panel.url else { return }
    do {
      privateKeyPEM = String(
        decoding: try RuntimeStorage.readPrivate(url, maximum: 16_384), as: UTF8.self)
      status = "已在内存中读取私钥；保存配置后立即清空"
    } catch {
      privateKeyPEM = ""
      status = "RUNTIME_LAN_PRIVATE_KEY_INVALID"
    }
  }

  var body: some View {
    GroupBox("局域网 Owner 只读入口") {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          TextField("当前 LAN IPv4（明确指定）", text: $bindIPv4)
          TextField("HTTPS 高端口", text: $port).frame(width: 130)
        }
        TextEditor(text: $certificatePEM)
          .font(.system(.caption, design: .monospaced))
          .frame(minHeight: 64)
          .overlay(RoundedRectangle(cornerRadius: 4).stroke(.secondary))
        HStack {
          Button("选择 0600 私钥文件…", action: choosePrivateKey)
          Text(privateKeyPEM.isEmpty ? "未选择" : "已读取到内存（不显示文件名或内容）")
            .font(.caption)
        }
        HStack {
          Button("保存配置") {
            guard let parsedPort = Int(port) else {
              status = "RUNTIME_LAN_PORT_INVALID"
              return
            }
            let setup = RuntimeLanSetup(
              bindIPv4: bindIPv4, port: parsedPort,
              certificatePEM: certificatePEM, privateKeyPEM: privateKeyPEM)
            action(clearPrivateKey: true) {
              return try encoded(
                controller.configureLan(setup))
            }
          }
          Button("启用") { action { try encoded(controller.enableLan()) } }
          Button("停用") { action { try encoded(controller.disableLan()) } }
          Button("状态") { action { try encoded(controller.lanStatus()) } }
          Button("接入码") { action { try encoded(controller.lanOnboarding()) } }
          Button("诊断") { action { try encoded(controller.diagnoseLan()) } }
          Button("创建支持包") {
            action { try encoded(controller.createSupportBundle()) }
          }
        }.disabled(busy)
        Text("仅发布受信 HTTPS /owner；柜台、命令、Fastify 与 PostgreSQL 不暴露到 LAN。")
          .font(.caption)
        Text(status).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
      }.disabled(busy)
    }
  }
}
