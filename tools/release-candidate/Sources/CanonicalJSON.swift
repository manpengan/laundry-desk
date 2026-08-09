import CryptoKit
import Foundation

enum RCFailure: Error {
  case code(String)
}

func fail(_ code: String) throws -> Never {
  throw RCFailure.code(code)
}

func dictionary(_ value: Any, keys: Set<String>, _ code: String) throws -> [String: Any] {
  guard let object = value as? [String: Any], Set(object.keys) == keys else {
    try fail(code)
  }
  return object
}

func optionalDictionary(
  _ value: Any,
  required: Set<String>,
  optional: Set<String>,
  _ code: String
) throws -> [String: Any] {
  guard let object = value as? [String: Any] else { try fail(code) }
  let actual = Set(object.keys)
  guard required.isSubset(of: actual), actual.isSubset(of: required.union(optional)) else {
    try fail(code)
  }
  return object
}

func string(_ object: [String: Any], _ key: String, _ code: String) throws -> String {
  guard let value = object[key] as? String else { try fail(code) }
  return value
}

func integer(_ object: [String: Any], _ key: String, _ code: String) throws -> Int {
  guard let number = object[key] as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID()
  else { try fail(code) }
  let value = number.int64Value
  guard NSNumber(value: value) == number, value >= Int64(Int.min), value <= Int64(Int.max) else {
    try fail(code)
  }
  return Int(value)
}

func boolean(_ object: [String: Any], _ key: String, _ code: String) throws -> Bool {
  guard let number = object[key] as? NSNumber,
    CFGetTypeID(number) == CFBooleanGetTypeID()
  else { try fail(code) }
  return number.boolValue
}

private func jsonString(_ value: String) throws -> String {
  var output = "\""
  for scalar in value.unicodeScalars {
    switch scalar.value {
    case 0x08: output += "\\b"
    case 0x09: output += "\\t"
    case 0x0A: output += "\\n"
    case 0x0C: output += "\\f"
    case 0x0D: output += "\\r"
    case 0x22: output += "\\\""
    case 0x5C: output += "\\\\"
    case 0x00...0x1F:
      output += String(format: "\\u%04x", scalar.value)
    default:
      output.unicodeScalars.append(scalar)
    }
  }
  output += "\""
  return output
}

func canonicalJSON(_ value: Any) throws -> String {
  if value is NSNull { return "null" }
  if let text = value as? String { return try jsonString(text) }
  if let number = value as? NSNumber {
    if CFGetTypeID(number) == CFBooleanGetTypeID() {
      return number.boolValue ? "true" : "false"
    }
    let integer = number.int64Value
    guard NSNumber(value: integer) == number else { try fail("RC_JSON_NUMBER_INVALID") }
    return String(integer)
  }
  if let array = value as? [Any] {
    return "[" + (try array.map(canonicalJSON)).joined(separator: ",") + "]"
  }
  if let object = value as? [String: Any] {
    let keys = object.keys.sorted { left, right in
      left.utf16.lexicographicallyPrecedes(right.utf16)
    }
    let fields = try keys.map { key -> String in
      guard let child = object[key] else { try fail("RC_JSON_INVALID") }
      return try jsonString(key) + ":" + canonicalJSON(child)
    }
    return "{" + fields.joined(separator: ",") + "}"
  }
  try fail("RC_JSON_INVALID")
}

func parseJSON(_ data: Data, canonical: Bool = false) throws -> Any {
  let value: Any
  do {
    value = try JSONSerialization.jsonObject(with: data, options: [])
  } catch {
    try fail("RC_JSON_INVALID")
  }
  if canonical {
    guard Data(try canonicalJSON(value).utf8) == data else {
      try fail("RC_JSON_NOT_CANONICAL")
    }
  }
  return value
}

func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func matches(_ value: String, _ pattern: String) -> Bool {
  guard let expression = try? NSRegularExpression(pattern: pattern) else { return false }
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return expression.firstMatch(in: value, range: range)?.range == range
}

let shaPattern = "[0-9a-f]{64}"
let digestPattern = "sha256:[0-9a-f]{64}"
let semverPattern = "(?:0|[1-9][0-9]{0,12})\\.(?:0|[1-9][0-9]{0,12})\\.(?:0|[1-9][0-9]{0,12})"
let gitPattern = "[0-9a-f]{40}"
let teamPattern = "[A-Z0-9]{10}"
let isoPattern = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z"
