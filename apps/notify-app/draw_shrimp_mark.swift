// draw_shrimp_mark.swift — 重绘无边框虾缸标: 开口圆环 + 右上红点, 透明底
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let S: CGFloat = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: Int(S), height: Int(S),
                    bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

ctx.setAllowsAntialiasing(true)
let c = CGPoint(x: S / 2, y: S / 2)
let r = CGFloat(340)

// 圆环: 缺口朝右上(数学角45°方向), 从65°逆时针画到25°(+360°)
let startA = 65.0 * Double.pi / 180
let endA = (25.0 + 360.0) * Double.pi / 180
ctx.setStrokeColor(CGColor(srgbRed: 0.42, green: 0.50, blue: 0.58, alpha: 1))
ctx.setLineWidth(74)
ctx.setLineCap(.round)
ctx.addArc(center: c, radius: r, startAngle: CGFloat(startA),
           endAngle: CGFloat(endA), clockwise: false)
ctx.strokePath()

// 红点: 位于缺口中央(45°)的环上
let dotR = CGFloat(58)
let dx = c.x + r * cos(45.0 * Double.pi / 180)
let dy = c.y + r * sin(45.0 * Double.pi / 180)
ctx.setFillColor(CGColor(srgbRed: 0.886, green: 0.231, blue: 0.180, alpha: 1))
ctx.fillEllipse(in: CGRect(x: dx - dotR, y: dy - dotR, width: dotR * 2, height: dotR * 2))

guard let img = ctx.makeImage() else { fatalError("makeImage failed") }
let outURL = URL(fileURLWithPath: CommandLine.arguments.count > 1
    ? CommandLine.arguments[1] : "/tmp/shrimp-mark-1024.png") as CFURL
let dest = CGImageDestinationCreateWithURL(outURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, img, nil)
CGImageDestinationFinalize(dest)
print("ICON_OK")
