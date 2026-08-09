import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

enum RuntimeLanQR {
  static func terminal(_ value: String) throws -> String {
    guard let data = value.data(using: .utf8), data.count <= 512 else {
      try runtimeFail("RUNTIME_LAN_PROFILE_INVALID")
    }
    let filter = CIFilter.qrCodeGenerator()
    filter.message = data
    filter.correctionLevel = "M"
    guard let image = filter.outputImage,
      let bitmap = CIContext(options: nil).createCGImage(image, from: image.extent)
    else { try runtimeFail("RUNTIME_LAN_PROFILE_INVALID") }
    let width = bitmap.width
    let height = bitmap.height
    guard width > 0, width <= 177, height == width,
      let bytes = bitmap.dataProvider?.data,
      let pointer = CFDataGetBytePtr(bytes)
    else { try runtimeFail("RUNTIME_LAN_PROFILE_INVALID") }
    let bytesPerRow = bitmap.bytesPerRow
    let bytesPerPixel = max(1, bitmap.bitsPerPixel / 8)
    func dark(_ x: Int, _ y: Int) -> Bool {
      if x < 0 || y < 0 || x >= width || y >= height { return false }
      return pointer[y * bytesPerRow + x * bytesPerPixel] < 128
    }
    var lines: [String] = []
    for y in stride(from: -2, to: height + 2, by: 2) {
      var line = ""
      for x in -2..<(width + 2) {
        let upper = dark(x, y)
        let lower = dark(x, y + 1)
        line += upper ? (lower ? "█" : "▀") : (lower ? "▄" : " ")
      }
      lines.append(line)
    }
    return lines.joined(separator: "\n")
  }
}
