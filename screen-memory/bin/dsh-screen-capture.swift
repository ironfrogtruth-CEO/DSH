// dsh-screen-capture — DSH 自动屏幕记忆专用截图工具
// 用法: dsh-screen-capture --out /path/to/out.png [--display main]
// 退出码: 0=成功, 2=无屏幕录制权限(已发起授权请求)
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func writePNG(_ image: CGImage, to path: String) -> Bool {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(
        url, UTType.png.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, image, nil)
    return CGImageDestinationFinalize(dest)
}

guard let outIndex = CommandLine.arguments.firstIndex(of: "--out"),
      CommandLine.arguments.count > outIndex + 1 else {
    fputs("usage: dsh-screen-capture --out <path.png>\n", stderr)
    exit(64)
}
let outPath = CommandLine.arguments[outIndex + 1]

@available(macOS 10.15, *)
let preflightOK = CGPreflightScreenCaptureAccess()
if #available(macOS 10.15, *), !preflightOK {
    // 触发系统授权弹窗（首次）
    _ = CGRequestScreenCaptureAccess()
    fputs("SCREEN_PERMISSION_REQUIRED\n", stderr)
    exit(2)
}

let displayID = CGMainDisplayID()
guard let image = CGDisplayCreateImage(displayID) else {
    fputs("CAPTURE_FAILED: CGDisplayCreateImage returned nil\n", stderr)
    exit(3)
}

if writePNG(image, to: outPath) {
    print("CAPTURE_OK \(outPath)")
} else {
    fputs("CAPTURE_FAILED: cannot write \(outPath)\n", stderr)
    exit(4)
}
