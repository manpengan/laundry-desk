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
  @State private var status = "请选择已签名运行时清单"
  @State private var busy = false

  private func chooseManifest() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    if panel.runModal() == .OK { manifestPath = panel.url?.path ?? "" }
  }

  private func action(clearCredentials: Bool = false, _ work: @escaping () throws -> String) {
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
        }
      }
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Laundry Desk Runtime").font(.title2).bold()
      HStack {
        TextField("签名 manifest", text: $manifestPath).disabled(true)
        Button("选择…", action: chooseManifest)
      }
      TextField("管理员用户名", text: $username)
      TextField("管理员显示名", text: $displayName)
      SecureField("管理员密码", text: $password)
      SecureField("管理员 PIN（6–8 位）", text: $pin)
      HStack {
        Button("安装") {
          action(clearCredentials: true) {
            try controller.install(
              manifestURL: URL(fileURLWithPath: manifestPath),
              setup: RuntimeSetup(
                adminUsername: username, adminDisplayName: displayName,
                adminPassword: password, adminPin: pin))
          }
        }
        Button("恢复安装") {
          action(clearCredentials: true) {
            try controller.recover(manifestURL: URL(fileURLWithPath: manifestPath))
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
            try RuntimeLaunchAgent.install(executable: executable, runner: runner)
          }
        }
        Button("卸载开机启动") {
          action {
            try RuntimeLaunchAgent.uninstall(runner: runner)
          }
        }
      }.disabled(busy)
      Text(status).font(.system(.body, design: .monospaced)).textSelection(.enabled)
    }.padding(20).frame(minWidth: 660, minHeight: 330)
  }
}

private final class RuntimeAppDelegate: NSObject, NSApplicationDelegate {
  let window: NSWindow
  init(controller: NativeRuntimeController, runner: RuntimeRunner, executable: String) {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 700, height: 370),
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
