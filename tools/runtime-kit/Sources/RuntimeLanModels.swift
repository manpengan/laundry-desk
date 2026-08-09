import Foundation

struct RuntimeLanSetup: Codable {
  let bindIPv4: String
  let port: Int
  let certificatePEM: String
  let privateKeyPEM: String

  enum CodingKeys: String, CodingKey {
    case bindIPv4 = "bind_ipv4"
    case port
    case certificatePEM = "certificate_pem"
    case privateKeyPEM = "private_key_pem"
  }
}

struct RuntimeLanCertificateSummary: Equatable {
  let fingerprintSHA256: String
  let validNotAfter: String
  let ipSANs: [String]
}

struct RuntimeLanProfile: Codable, Equatable {
  let version: Int
  let status: String
  let generation: String
  let bindIPv4: String
  let port: Int
  let certificateSHA256: String
  let certificateFingerprintSHA256: String
  let validNotAfter: String
  let ipSANs: [String]
  let lanComposeSHA256: String
  let ownerSPASHA256: String

  enum CodingKeys: String, CodingKey {
    case version, status, generation, port
    case bindIPv4 = "bind_ipv4"
    case certificateSHA256 = "certificate_sha256"
    case certificateFingerprintSHA256 = "certificate_fingerprint_sha256"
    case validNotAfter = "valid_not_after"
    case ipSANs = "ip_sans"
    case lanComposeSHA256 = "lan_compose_sha256"
    case ownerSPASHA256 = "owner_spa_sha256"
  }
}

struct RuntimeLanState: Codable, Equatable {
  let version: Int
  let status: String
  let generation: String
  let profileSHA256: String

  enum CodingKeys: String, CodingKey {
    case version, status, generation
    case profileSHA256 = "profile_sha256"
  }

  func withStatus(_ value: String) -> RuntimeLanState {
    RuntimeLanState(
      version: version, status: value, generation: generation,
      profileSHA256: profileSHA256)
  }
}

struct RuntimeLanSummary: Codable {
  let status: String
  let generation: String
  let bindIPv4: String
  let port: Int
  let certificateFingerprintSHA256: String
  let validNotAfter: String

  enum CodingKeys: String, CodingKey {
    case status, generation, port
    case bindIPv4 = "bind_ipv4"
    case certificateFingerprintSHA256 = "certificate_fingerprint_sha256"
    case validNotAfter = "valid_not_after"
  }
}

struct RuntimeLanStatus: Codable {
  let configured: Bool
  let enabled: Bool
  let generation: String?
  let bindIPv4: String?
  let port: Int?
  let certificateFingerprintSHA256: String?
  let validNotAfter: String?
  let faultCode: String?

  enum CodingKeys: String, CodingKey {
    case configured, enabled, generation, port
    case bindIPv4 = "bind_ipv4"
    case certificateFingerprintSHA256 = "certificate_fingerprint_sha256"
    case validNotAfter = "valid_not_after"
    case faultCode = "fault_code"
  }
}

struct RuntimeLanOnboarding: Codable {
  let ownerURL: String
  let certificateFingerprintSHA256: String
  let validNotAfter: String
  let ipSANs: [String]
  let qr: String

  enum CodingKeys: String, CodingKey {
    case ownerURL = "owner_url"
    case certificateFingerprintSHA256 = "certificate_fingerprint_sha256"
    case validNotAfter = "valid_not_after"
    case ipSANs = "ip_sans"
    case qr
  }
}

struct RuntimeLanCheck: Codable {
  let code: String
  let ok: Bool
}

struct RuntimeLanDiagnosis: Codable {
  let ok: Bool
  let checks: [RuntimeLanCheck]
  let certificateFingerprintSHA256: String?
  let validNotAfter: String?
  let faultCode: String?

  enum CodingKeys: String, CodingKey {
    case ok, checks
    case certificateFingerprintSHA256 = "certificate_fingerprint_sha256"
    case validNotAfter = "valid_not_after"
    case faultCode = "fault_code"
  }
}

struct RuntimeSupportCreateResult: Codable {
  let status: String
  let path: String
  let bytes: Int64
}
