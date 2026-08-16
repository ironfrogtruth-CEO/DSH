// screenutil — 虾缸屏幕工具 (Computer Use 最小闭环)
// 子命令:
//   ocr <png路径>          — Vision OCR → JSON [{text,x,y,w,h}]
//   click <x> <y> [double] — 鼠标左键点击(需辅助功能权限)
//   type <文本>            — 键入文本(需辅助功能权限)
//   key <名称>             — 按键 (enter/tab/escape/space/up/down/left/right/...)
import Foundation
import Vision
import AppKit
import CoreGraphics

func ocrImage(_ path: String) {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("{\"error\":\"cannot load image\"}")
        exit(1)
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([req])
    var out: [[String: Any]] = []
    for obs in req.results ?? [] {
        guard let cand = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        out.append([
            "text": cand.string,
            "x": Int((Double(b.minX) * Double(cg.width)).rounded()),
            "y": Int((Double(1 - b.maxY) * Double(cg.height)).rounded()),
            "w": Int((Double(b.width) * Double(cg.width)).rounded()),
            "h": Int((Double(b.height) * Double(cg.height)).rounded()),
        ])
    }
    let data = try? JSONSerialization.data(withJSONObject: out, options: [])
    print(String(data: data ?? Data(), encoding: .utf8) ?? "[]")
    exit(0)
}

func click(_ x: Double, _ y: Double, _ double: Bool) {
    let pt = CGPoint(x: x, y: y)
    let src = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)
    let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
    if double {
        let d2 = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)
        let u2 = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)
        d2?.post(tap: .cghidEventTap)
        u2?.post(tap: .cghidEventTap)
    }
}

func typeText(_ text: String) {
    let src = CGEventSource(stateID: .hidSystemState)
    for ch in text {
        guard let scalar = ch.unicodeScalars.first else { continue }
        var unicode = [UniChar(scalar.value)]
        let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unicode)
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unicode)
        up?.post(tap: .cghidEventTap)
    }
}

func keyPress(_ name: String) {
    let map: [String: CGKeyCode] = [
        "enter": 36, "return": 36, "tab": 48, "escape": 53, "esc": 53, "space": 49,
        "up": 126, "down": 125, "left": 123, "right": 124,
        "backspace": 51, "delete": 117, "home": 115, "end": 119,
        "pageup": 116, "pagedown": 121,
        "a": 0, "c": 8, "v": 9, "x": 7, "z": 6, "y": 16,
    ]
    guard let code = map[name.lowercased()] else {
        print("{\"error\":\"unknown key: \(name)\"}")
        exit(1)
    }
    let src = CGEventSource(stateID: .hidSystemState)
    CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
    CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("usage: screenutil ocr <path> | click <x> <y> [double] | type <text> | key <name>")
    exit(2)
}
switch args[1] {
case "ocr":
    guard args.count >= 3 else { exit(2) }
    ocrImage(args[2])
case "click":
    guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else { exit(2) }
    click(x, y, args.count > 4 && args[4] == "double")
case "type":
    typeText(args.dropFirst(2).joined(separator: " "))
case "key":
    guard args.count >= 3 else { exit(2) }
    keyPress(args[2])
default:
    print("{\"error\":\"unknown command\"}")
    exit(2)
}
