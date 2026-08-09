#if RUNTIME_TESTING
  import Foundation

  struct RuntimePhotoConsistencyTestResult: Codable {
    let status: String
    let negativeCases: Int

    enum CodingKeys: String, CodingKey {
      case status
      case negativeCases = "negative_cases"
    }
  }

  enum RuntimePhotoConsistencyTesting {
    private static let key = "01234567-89ab-4def-8123-456789abcdef.jpg"
    private static let digest = String(repeating: "a", count: 64)

    private static func data(_ key: String = key, _ size: Int = 5, _ sha: String = digest)
      throws -> Data
    {
      try JSONSerialization.data(
        withJSONObject: [
          [
            "byte_size": size, "content_sha256": sha, "storage_key": key,
          ]
        ], options: [.sortedKeys])
    }

    static func run() throws -> RuntimePhotoConsistencyTestResult {
      let valid = try data()
      try RuntimePhotoConsistency.validate(database: valid, photos: valid)
      let invalid = [
        try data("01234567-89ab-4def-8123-456789abcdef.png"),
        try data(key, 6),
        try data(key, 5, String(repeating: "b", count: 64)),
      ]
      for value in invalid {
        do {
          try RuntimePhotoConsistency.validate(database: valid, photos: value)
          try runtimeFail("RUNTIME_PHOTO_CONSISTENCY_SELF_TEST_FAILED")
        } catch let error as RuntimeKitError {
          guard error.description == "RUNTIME_PHOTO_CONSISTENCY_FAILED" else { throw error }
        }
      }
      return RuntimePhotoConsistencyTestResult(status: "passed", negativeCases: invalid.count)
    }
  }
#endif
