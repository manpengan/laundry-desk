import CryptoKit
import Darwin
import Foundation
import Security

private struct RuntimeTestLanInterface: Codable {
  let name: String
  let ipv4: String
  let up: Bool
  let loopback: Bool
  let pointToPoint: Bool

  enum CodingKeys: String, CodingKey {
    case name, ipv4, up, loopback
    case pointToPoint = "point_to_point"
  }
}

enum RuntimeLanValidation {
  private static let forbiddenPorts = [8543, 8787]

  private static func ipv4Bytes(_ value: String) -> [UInt8]? {
    var address = in_addr()
    guard value.count <= 15, inet_pton(AF_INET, value, &address) == 1 else { return nil }
    return withUnsafeBytes(of: &address.s_addr) { Array($0) }
  }

  static func validateAddress(_ value: String) throws {
    guard let bytes = ipv4Bytes(value),
      bytes[0] == 10
        || (bytes[0] == 172 && (16...31).contains(bytes[1]))
        || (bytes[0] == 192 && bytes[1] == 168),
      interfaceRecords().contains(where: {
        $0.ipv4 == value && $0.up && !$0.loopback && !$0.pointToPoint
          && !$0.name.lowercased().hasPrefix("utun")
      })
    else { try runtimeFail("RUNTIME_LAN_INTERFACE_INVALID") }
  }

  static func validatePort(_ value: Int, bindIPv4: String, requireAvailable: Bool) throws {
    guard (1_024...65_535).contains(value), !forbiddenPorts.contains(value) else {
      try runtimeFail("RUNTIME_LAN_PORT_INVALID")
    }
    if requireAvailable && !portAvailable(bindIPv4, value) {
      try runtimeFail("RUNTIME_LAN_PORT_UNAVAILABLE")
    }
  }

  private static func interfaceRecords() -> [RuntimeTestLanInterface] {
    #if RUNTIME_TESTING
      if let source = ProcessInfo.processInfo.environment["LAUNDRY_RUNTIME_TEST_LAN_INTERFACES"] {
        guard source.utf8.count <= 8_192,
          let data = source.hasPrefix("[")
            ? Data(source.utf8)
            : try? Data(
              contentsOf: URL(fileURLWithPath: source)),
          data.count <= 8_192,
          let records = try? JSONDecoder().decode([RuntimeTestLanInterface].self, from: data)
        else { return [] }
        return records
      }
    #endif
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return [] }
    defer { freeifaddrs(head) }
    var records: [RuntimeTestLanInterface] = []
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let current = cursor {
      let entry = current.pointee
      if let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET) {
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(
          address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count),
          nil, 0, NI_NUMERICHOST) == 0
        {
          let flags = Int32(entry.ifa_flags)
          records.append(
            RuntimeTestLanInterface(
              name: String(cString: entry.ifa_name), ipv4: String(cString: host),
              up: flags & IFF_UP != 0, loopback: flags & IFF_LOOPBACK != 0,
              pointToPoint: flags & IFF_POINTOPOINT != 0))
        }
      }
      cursor = entry.ifa_next
    }
    return records
  }

  private static func socketAddress(_ host: String, _ port: Int) -> sockaddr_in? {
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(port).bigEndian
    guard inet_pton(AF_INET, host, &address.sin_addr) == 1 else { return nil }
    return address
  }

  private static func portAvailable(_ host: String, _ port: Int) -> Bool {
    #if RUNTIME_TESTING
      if ProcessInfo.processInfo.environment["LAUNDRY_RUNTIME_TEST_LAN_INTERFACES"] != nil {
        return ProcessInfo.processInfo.environment["LAUNDRY_RUNTIME_TEST_LAN_PORT_OCCUPIED"] != "1"
      }
    #endif
    guard var address = socketAddress(host, port) else { return false }
    let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard descriptor >= 0 else { return false }
    defer { Darwin.close(descriptor) }
    return withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
      }
    }
  }

  static func portAcceptsConnections(_ host: String, _ port: Int) -> Bool {
    #if RUNTIME_TESTING
      if ProcessInfo.processInfo.environment["LAUNDRY_RUNTIME_TEST_LAN_INTERFACES"] != nil {
        return false
      }
    #endif
    guard var address = socketAddress(host, port) else { return false }
    let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard descriptor >= 0 else { return false }
    defer { Darwin.close(descriptor) }
    var timeout = timeval(tv_sec: 1, tv_usec: 0)
    let timeoutSize = socklen_t(MemoryLayout.size(ofValue: timeout))
    _ = withUnsafePointer(to: &timeout) {
      setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, $0, timeoutSize)
    }
    return withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
      }
    }
  }

  private static func pemData(_ value: String, label: String, code: String) throws -> Data {
    guard value.utf8.count <= 16_384,
      value.hasPrefix("-----BEGIN \(label)-----"),
      value.trimmingCharacters(in: .whitespacesAndNewlines)
        .hasSuffix("-----END \(label)-----")
    else { try runtimeFail(code) }
    let body = value.replacingOccurrences(of: "-----BEGIN \(label)-----", with: "")
      .replacingOccurrences(of: "-----END \(label)-----", with: "")
      .components(separatedBy: .whitespacesAndNewlines).joined()
    guard
      body.range(
        of: "^[A-Za-z0-9+/]+={0,2}$", options: .regularExpression) != nil,
      let data = Data(base64Encoded: body), !data.isEmpty
    else { try runtimeFail(code) }
    return data
  }

  private static func certificateDate(
    _ values: [CFString: Any], key: CFString
  ) -> Date? {
    guard let property = values[key] as? [CFString: Any],
      let seconds = property[kSecPropertyKeyValue] as? NSNumber
    else { return nil }
    return Date(timeIntervalSinceReferenceDate: seconds.doubleValue)
  }

  private static func ipSANs(_ values: [CFString: Any]) -> [String] {
    guard let property = values[kSecOIDSubjectAltName] as? [CFString: Any],
      let entries = property[kSecPropertyKeyValue] as? [[CFString: Any]]
    else { return [] }
    return Array(
      Set(
        entries.compactMap { entry in
          guard entry[kSecPropertyKeyLabel] as? String == "IP Address",
            let value = entry[kSecPropertyKeyValue] as? String,
            ipv4Bytes(value) != nil
          else { return nil }
          return value
        })
    ).sorted()
  }

  private static func importedPrivateKey(_ pem: String) throws -> SecKey {
    let labels = ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"]
    guard
      let label = labels.first(where: {
        pem.hasPrefix("-----BEGIN \($0)-----")
      })
    else { try runtimeFail("RUNTIME_LAN_PRIVATE_KEY_INVALID") }
    _ = try pemData(pem, label: label, code: "RUNTIME_LAN_PRIVATE_KEY_INVALID")
    var format = SecExternalFormat.formatUnknown
    var itemType = SecExternalItemType.itemTypePrivateKey
    var items: CFArray?
    let status = SecItemImport(
      Data(pem.utf8) as CFData, nil, &format, &itemType, [], nil, nil, &items)
    guard status == errSecSuccess, itemType == .itemTypePrivateKey,
      let imported = items as? [Any], imported.count == 1
    else { try runtimeFail("RUNTIME_LAN_PRIVATE_KEY_INVALID") }
    let candidate = imported[0] as CFTypeRef
    guard CFGetTypeID(candidate) == SecKeyGetTypeID() else {
      try runtimeFail("RUNTIME_LAN_PRIVATE_KEY_INVALID")
    }
    return unsafeBitCast(candidate, to: SecKey.self)
  }

  private static func applicationLabel(_ key: SecKey) -> Data? {
    guard let attributes = SecKeyCopyAttributes(key) as? [CFString: Any] else { return nil }
    return attributes[kSecAttrApplicationLabel] as? Data
  }

  static func certificate(
    certificatePEM: String, privateKeyPEM: String, bindIPv4: String
  ) throws -> RuntimeLanCertificateSummary {
    let certificateData = try pemData(
      certificatePEM, label: "CERTIFICATE", code: "RUNTIME_LAN_CERTIFICATE_INVALID")
    guard let certificate = SecCertificateCreateWithData(nil, certificateData as CFData),
      let values = SecCertificateCopyValues(
        certificate,
        [kSecOIDX509V1ValidityNotBefore, kSecOIDX509V1ValidityNotAfter, kSecOIDSubjectAltName]
          as CFArray, nil) as? [CFString: Any],
      let notBefore = certificateDate(values, key: kSecOIDX509V1ValidityNotBefore),
      let notAfter = certificateDate(values, key: kSecOIDX509V1ValidityNotAfter),
      let publicKey = SecCertificateCopyKey(certificate)
    else { try runtimeFail("RUNTIME_LAN_CERTIFICATE_INVALID") }
    let now = Date()
    guard notBefore <= now, notAfter > now else {
      try runtimeFail("RUNTIME_LAN_CERTIFICATE_EXPIRED")
    }
    let sans = ipSANs(values)
    guard sans.contains(bindIPv4) else {
      try runtimeFail("RUNTIME_LAN_CERTIFICATE_SAN_MISMATCH")
    }
    let privateKey = try importedPrivateKey(privateKeyPEM)
    guard let publicLabel = applicationLabel(publicKey),
      let privateLabel = applicationLabel(privateKey), publicLabel == privateLabel
    else { try runtimeFail("RUNTIME_LAN_KEY_MISMATCH") }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return RuntimeLanCertificateSummary(
      fingerprintSHA256: SHA256.hash(data: certificateData)
        .map { String(format: "%02x", $0) }.joined(),
      validNotAfter: formatter.string(from: notAfter), ipSANs: sans)
  }
}
