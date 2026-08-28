// build_notify_icon.swift — mark-dark.png 去白底后合成 1024 透明底方形图标
// 用法: build_notify_icon.swift <src.png> <out.png>
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else { fatalError("usage: build_notify_icon src out") }

guard let srcProvider = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let src = CGImageSourceCreateImageAtIndex(srcProvider, 0, nil) else {
    fatalError("cannot load \(args[1])")
}

let w = src.width, h = src.height
var buf = [UInt8](repeating: 0, count: w * h * 4)
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let tmp = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8,
                    bytesPerRow: w * 4, space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
tmp.draw(src, in: CGRect(x: 0, y: 0, width: w, height: h))

// 白底->透明(带羽化带防止白晕)
for i in stride(from: 0, to: buf.count, by: 4) {
    let r = Int(buf[i]), g = Int(buf[i+1]), b = Int(buf[i+2])
    let mn = min(r, g, b)
    if mn >= 242 {
        buf[i+3] = 0
    } else if mn >= 215 {
        // 渐变羽化区
        let t = Float(mn - 215) / Float(242 - 215)
        buf[i+3] = UInt8(Float(buf[i+3]) * (1.0 - t))
    }
}

guard let cleaned = tmp.makeImage() else { fatalError("makeImage failed") }

// 合成到 1024 透明方底, 内容缩放至宽 840 居中
let S = 1024
let inner: CGFloat = 840
let scale = inner / CGFloat(w)
let dh = CGFloat(h) * scale
let dx = (CGFloat(S) - inner) / 2
let dy = (CGFloat(S) - dh) / 2

let outCtx = CGContext(data: nil, width: S, height: S, bitsPerComponent: 8,
                       bytesPerRow: 0, space: cs,
                       bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
outCtx.setAllowsAntialiasing(true)
outCtx.interpolationQuality = .high
outCtx.draw(cleaned, in: CGRect(x: dx, y: dy, width: inner, height: dh))
guard let finalImg = outCtx.makeImage() else { fatalError("composite failed") }

let dest = CGImageDestinationCreateWithURL(
    URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, finalImg, nil)
CGImageDestinationFinalize(dest)
print("ICON_BUILT")
