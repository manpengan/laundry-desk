import Foundation

private func validRuntimeIdentity(
  username: String, displayName: String, password: String, pin: String
) -> Bool {
  let validUsername =
    username.range(
      of: "^[A-Za-z0-9_.-]{1,64}$", options: .regularExpression) != nil
  let validPin = pin.range(of: "^[0-9]{6,8}$", options: .regularExpression) != nil
  return validUsername && validPin && !displayName.isEmpty && displayName.count <= 80
    && password.count >= 12 && password.count <= 256
    && ![displayName, password].contains(where: {
      $0.contains("\0") || $0.contains("\n") || $0.contains("\r")
    })
}

func validateRuntimeCommissionSetup(_ setup: RuntimeCommissionSetup) throws {
  guard
    validRuntimeIdentity(
      username: setup.approverUsername, displayName: setup.approverDisplayName,
      password: setup.approverPassword, pin: setup.approverPin)
  else { try runtimeFail("RUNTIME_SETUP_INVALID") }
}

func validateRuntimeSetup(_ setup: RuntimeSetup) throws {
  guard
    validRuntimeIdentity(
      username: setup.adminUsername, displayName: setup.adminDisplayName,
      password: setup.adminPassword, pin: setup.adminPin),
    validRuntimeIdentity(
      username: setup.approverUsername, displayName: setup.approverDisplayName,
      password: setup.approverPassword, pin: setup.approverPin),
    setup.adminUsername != setup.approverUsername,
    setup.adminPassword != setup.approverPassword,
    setup.adminPin != setup.approverPin
  else { try runtimeFail("RUNTIME_SETUP_INVALID") }
}
