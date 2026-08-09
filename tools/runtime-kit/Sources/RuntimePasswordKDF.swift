import CommonCrypto
import CryptoKit
import Foundation
import Security

enum RuntimePasswordKDF {
  static let saltBytes = 16
  static let keyBytes = 32
  static let minimumIterations = 600_000
  static let maximumIterations = 5_000_000
  private static let targetMilliseconds: UInt32 = 250

  static func validatePassword(_ password: String) throws {
    guard (12...256).contains(password.utf8.count) else {
      try runtimeFail("RUNTIME_TRANSFER_PASSWORD_INVALID")
    }
  }

  static func validateIterations(_ iterations: Int) throws {
    guard (minimumIterations...maximumIterations).contains(iterations) else {
      try runtimeFail("RUNTIME_TRANSFER_INVALID")
    }
  }

  static func calibratedIterations() -> Int {
    let calibrated = Int(
      CCCalibratePBKDF(
        CCPBKDFAlgorithm(kCCPBKDF2), 32, saltBytes,
        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), keyBytes, targetMilliseconds))
    return min(max(calibrated, minimumIterations), maximumIterations)
  }

  static func randomBytes(count: Int) throws -> Data {
    guard count > 0, count <= 64 else { try runtimeFail("RUNTIME_RANDOM_FAILED") }
    var bytes = [UInt8](repeating: 0, count: count)
    guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
      try runtimeFail("RUNTIME_RANDOM_FAILED")
    }
    return Data(bytes)
  }

  static func deriveKey(password: String, salt: Data, iterations: Int) throws -> SymmetricKey {
    var derived = try deriveKeyMaterial(password: password, salt: salt, iterations: iterations)
    defer { derived.resetBytes(in: derived.indices) }
    return SymmetricKey(data: derived)
  }

  #if RUNTIME_TESTING
    static func deriveKeyBytes(password: String, salt: Data, iterations: Int) throws -> Data {
      var derived = try deriveKeyMaterial(password: password, salt: salt, iterations: iterations)
      defer { derived.resetBytes(in: derived.indices) }
      return Data(derived)
    }
  #endif

  private static func deriveKeyMaterial(
    password: String, salt: Data, iterations: Int
  ) throws -> [UInt8] {
    try validatePassword(password)
    var passwordBytes = Array(password.utf8)
    defer { passwordBytes.resetBytes(in: passwordBytes.indices) }
    guard salt.count == saltBytes else { try runtimeFail("RUNTIME_TRANSFER_INVALID") }
    try validateIterations(iterations)
    var derived = [UInt8](repeating: 0, count: keyBytes)
    let status = passwordBytes.withUnsafeBufferPointer { passwordBuffer in
      salt.withUnsafeBytes { saltBuffer in
        derived.withUnsafeMutableBufferPointer { derivedBuffer in
          CCKeyDerivationPBKDF(
            CCPBKDFAlgorithm(kCCPBKDF2), passwordBuffer.baseAddress, passwordBuffer.count,
            saltBuffer.bindMemory(to: UInt8.self).baseAddress, salt.count,
            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
            derivedBuffer.baseAddress, derivedBuffer.count)
        }
      }
    }
    guard status == kCCSuccess else {
      derived.resetBytes(in: derived.indices)
      try runtimeFail("RUNTIME_TRANSFER_KDF_FAILED")
    }
    return derived
  }
}
