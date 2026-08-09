import Foundation

func stableError(_ error: Error) -> String {
  if case RCFailure.code(let code) = error, matches(code, "RC_[A-Z0-9_]{1,96}") {
    return code
  }
  return "RC_VERIFICATION_FAILED"
}

do {
  guard CommandLine.arguments.count == 2 else { try fail("RC_ARGUMENTS_INVALID") }
  let result = try verifyCandidate(at: CommandLine.arguments[1])
  FileHandle.standardOutput.write(Data((try canonicalJSON(result) + "\n").utf8))
} catch {
  FileHandle.standardError.write(Data((stableError(error) + "\n").utf8))
  exit(1)
}
