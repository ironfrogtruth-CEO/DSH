// DSHPreview.swift — 虾缸视觉预览悬浮窗 v2 (深色毛玻璃 HUD)
// 功能: 全屏/指定App实时帧 | 屏幕记忆存档回看 | 本地GLM视觉一句话注释 | 可拖动 | ✕真实退出
// 隐私: 黑名单应用永不出现在源列表且前台命中时停止采集
import Cocoa
import UserNotifications

// ---------- 黑名单 ----------
func loadBlacklist() -> [String] {
    let p = ("/Users/marcus/.dsh/screen-memory/blacklist.txt" as NSString).expandingTildeInPath
    guard let raw = try? String(contentsOfFile: p, encoding: .utf8) else { return [] }
    return raw.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty && !$0.hasPrefix("#") }
}
let BLACKLIST = loadBlacklist()
func isBlacklisted(_ app: String) -> Bool {
    BLACKLIST.contains { pat in app.range(of: pat, options: .caseInsensitive) != nil }
}

func runCmd(_ path: String, _ args: [String]) -> String? {
    let p = Process(); p.executableURL = URL(fileURLWithPath: path); p.arguments = args
    let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    let d = pipe.fileHandleForReading.readDataToEndOfFile()
    return String(data: d, encoding: .utf8)
}
func currentFrontApp() -> String? {
    guard let asnRaw0 = runCmd("/usr/bin/lsappinfo", ["front"]),
          let asnRaw = asnRaw0.trimmingCharacters(in: .whitespacesAndNewlines) as String?, !asnRaw.isEmpty,
          let info = runCmd("/usr/bin/lsappinfo", ["info", "-only", "name", asnRaw]) as String?,
          let rg = info.range(of: #"="([^"]*)"$"#, options: .regularExpression) else { return nil }
    return String(info[rg.upperBound..<info.endIndex]).replacingOccurrences(of: "\"", with: "")
}

// ---------- 视觉模型 ----------
func aiCaption(jpegData: Data, completion: @escaping (String) -> Void) {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/generate")!)
    req.httpMethod = "POST"
    req.timeoutInterval = 120
    let body: [String: Any] = [
        "model": "glm-marcus:latest",
        "prompt": "用一句不超过40字的中文描述这张屏幕截图的主要内容，直接说结论，不要开场白。",
        "images": [jpegData.base64EncodedString()],
        "stream": false,
        "options": ["num_predict": 80]
    ]
    guard let json = try? JSONSerialization.data(withJSONObject: body) else {
        DispatchQueue.main.async { completion("请求构造失败") }; return
    }
    req.httpBody = json
    URLSession.shared.dataTask(with: req) { data, _, err in
        let msg: String
        if let d = data,
           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           let resp = obj["response"] as? String, !resp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            msg = resp.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            msg = "模型无响应: \(err?.localizedDescription ?? "?")"
        }
        DispatchQueue.main.async { completion(msg) }
    }.resume()
}

// ---------- 捕获 ----------
enum CaptureError: Error { case noPermission, noWindows }
let capLock = NSLock()

func captureFrame(scope: String?) throws -> NSImage {
    guard CGPreflightScreenCaptureAccess() else { throw CaptureError.noPermission }
    capLock.lock(); defer { capLock.unlock() }
    guard let scope = scope else {
        guard let img = CGDisplayCreateImage(CGMainDisplayID()) else { throw CaptureError.noWindows }
        return NSImage(cgImage: img, size: NSSize(width: img.width / 2, height: img.height / 2))
    }
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
        throw CaptureError.noWindows
    }
    var rects = [(id: CGWindowID, rect: CGRect)]()
    for w in list {
        guard let owner = w[kCGWindowOwnerName as String] as? String,
              owner.caseInsensitiveCompare(scope) == .orderedSame,
              let num = w[kCGWindowNumber as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: CGFloat],
              b["Width"] ?? 0 > 2, b["Height"] ?? 0 > 2 else { continue }
        rects.append((CGWindowID(num),
                      CGRect(x: b["X"]!, y: b["Y"]!, width: b["Width"]!, height: b["Height"]!)))
    }
    guard !rects.isEmpty else { throw CaptureError.noWindows }
    var union = rects[0].rect
    for r in rects.dropFirst() { union = union.union(r.rect) }
    union = union.integral.insetBy(dx: -4, dy: -4)

    let scale: CGFloat = 2.0
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let ctx = CGContext(data: nil, width: Int(union.width * scale), height: Int(union.height * scale),
                              bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
        throw CaptureError.noWindows
    }
    ctx.setFillColor(CGColor(gray: 0.08, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: union.width * scale, height: union.height * scale))
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -union.minX, y: -union.minY)
    for r in rects {
        if let img = CGWindowListCreateImage(r.rect, [.optionIncludingWindow], r.id, CGWindowImageOption()) {
            ctx.draw(img, in: r.rect)
        }
    }
    guard let out = ctx.makeImage() else { throw CaptureError.noWindows }
    return NSImage(cgImage: out, size: NSSize(width: union.width, height: union.height))
}

func latestArchive() -> NSImage? {
    let root = ("/Users/marcus/.dsh/screen-memory/shots" as NSString).expandingTildeInPath
    guard let days = try? FileManager.default.contentsOfDirectory(atPath: root).sorted().reversed(),
          let day = days.first else { return nil }
    let dir = root + "/" + day
    guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir).sorted().reversed(),
          let f = files.first(where: { $0.hasSuffix(".png") }) else { return nil }
    return NSImage(contentsOfFile: dir + "/" + f)
}

// ---------- 自定义小控件 ----------
final class CapsuleLabel: NSView {
    private let label = NSTextField(labelWithString: "已就绪")
    var text: String {
        get { label.stringValue } set { label.stringValue = newValue; invalidateIntrinsicContentSize() }
    }
    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.withAlphaComponent(0.07).cgColor
        layer?.cornerRadius = 9
        label.font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        label.textColor = NSColor(red: 0.55, green: 0.93, blue: 0.86, alpha: 1)
        label.lineBreakMode = .byTruncatingMiddle
        label.maximumNumberOfLines = 2
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -12),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
}

final class CloseButton: NSButton {
    override func draw(_ dirtyRect: NSRect) {
        wantsLayer = true
        layer?.cornerRadius = bounds.width / 2
        let hover = isMouseInRect()
        layer?.backgroundColor = hover
            ? NSColor.systemRed.withAlphaComponent(0.9).cgColor
            : NSColor.white.withAlphaComponent(0.14).cgColor
        let para = NSMutableParagraphStyle(); para.alignment = .center
        ("✕" as NSString).draw(in: bounds, withAttributes: [
            .font: NSFont.systemFont(ofSize: 10, weight: .bold),
            .foregroundColor: hover ? NSColor.white : NSColor.white.withAlphaComponent(0.55),
            .paragraphStyle: para,
        ])
    }
    private func isMouseInRect() -> Bool {
        guard let w = window else { return false }
        let screenRect = w.convertToScreen(convert(bounds, to: nil))
        return screenRect.contains(NSEvent.mouseLocation)
    }
    override func mouseDown(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) {
        if frame.contains(convert(event.locationInWindow, from: nil)) { NSApp.terminate(nil) }
    }
}

// ---------- 主逻辑 ----------
final class PreviewPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var panel: PreviewPanel!
    var imageHolder: NSView!
    var imageView: NSImageView!
    var caption: CapsuleLabel!
    var sourcePopup: NSPopUpButton!
    var liveButton: NSButton!
    var timer: Timer?
    var annTimer: Timer?
    var liveOn = false

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory)

        panel = PreviewPanel(contentRect: NSRect(x: 260, y: 240, width: 500, height: 430),
                             styleMask: [.borderless, .nonactivatingPanel, .utilityWindow],
                             backing: .buffered, defer: false)
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.isMovableByWindowBackground = true

        // 毛玻璃底
        let blur = NSVisualEffectView()
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 14
        blur.layer?.masksToBounds = true
        blur.layer?.borderWidth = 1
        blur.layer?.borderColor = NSColor.white.withAlphaComponent(0.12).cgColor

        // 头部: 虾标 + 标题 + 关闭
        let mark = NSImageView(image: NSImage(contentsOfFile: "/Users/marcus/.dsh/apps/menubar-logo.png") ?? NSImage())
        mark.translatesAutoresizingMaskIntoConstraints = false
        mark.widthAnchor.constraint(equalToConstant: 18).isActive = true
        mark.heightAnchor.constraint(equalToConstant: 15).isActive = true
        mark.contentTintColor = NSColor.white

        let title = NSTextField(labelWithString: "虾缸 · 视觉预览")
        title.font = NSFont.systemFont(ofSize: 12.5, weight: .semibold)
        title.textColor = NSColor.white.withAlphaComponent(0.88)
        title.translatesAutoresizingMaskIntoConstraints = false

        let closeBtn = CloseButton(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
        closeBtn.toolTip = "退出预览"
        closeBtn.translatesAutoresizingMaskIntoConstraints = false

        let header = NSStackView(views: [mark, title, NSView(), closeBtn])
        header.orientation = .horizontal
        header.spacing = 7
        header.setHuggingPriority(.defaultHigh, for: .horizontal)
        header.translatesAutoresizingMaskIntoConstraints = false

        // 预览图容器
        imageHolder = NSView()
        imageHolder.wantsLayer = true
        imageHolder.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.35).cgColor
        imageHolder.layer?.cornerRadius = 10
        imageHolder.layer?.borderWidth = 1
        imageHolder.layer?.borderColor = NSColor.white.withAlphaComponent(0.10).cgColor
        imageHolder.layer?.masksToBounds = true
        imageHolder.translatesAutoresizingMaskIntoConstraints = false

        imageView = NSImageView()
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.alphaValue = 0.98
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageHolder.addSubview(imageView)

        caption = CapsuleLabel()
        caption.text = "已就绪 · 存档回看 / 实况 / AI 说一眼"
        caption.translatesAutoresizingMaskIntoConstraints = false

        sourcePopup = NSPopUpButton()
        rebuildSources(selecting: nil)
        sourcePopup.controlSize = .small
        sourcePopup.font = NSFont.systemFont(ofSize: 11)

        liveButton = NSButton(title: "▶ 实况", target: self, action: #selector(toggleLive))
        liveButton.bezelStyle = .rounded
        liveButton.controlSize = .small

        let seg = NSSegmentedControl(labels: ["📷 当前帧", "🧠 AI 说一眼"], trackingMode: .momentary, target: self, action: #selector(modeTap(_:)))
        seg.segmentStyle = .rounded
        seg.controlSize = .small

        let archiveBtn = NSButton(title: "🗂 存档", target: self, action: #selector(showArchiveTap))
        archiveBtn.bezelStyle = .rounded
        archiveBtn.controlSize = .small

        let controls = NSStackView(views: [sourcePopup, liveButton, archiveBtn, seg])
        controls.orientation = .horizontal
        controls.spacing = 6
        controls.edgeInsets = NSEdgeInsets(top: 2, left: 2, bottom: 2, right: 2)
        controls.translatesAutoresizingMaskIntoConstraints = false

        let body = NSStackView(views: [header, imageHolder, caption, controls])
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 9
        body.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        body.translatesAutoresizingMaskIntoConstraints = false

        blur.addSubview(body)
        NSLayoutConstraint.activate([
            body.topAnchor.constraint(equalTo: blur.topAnchor),
            body.leadingAnchor.constraint(equalTo: blur.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: blur.trailingAnchor),
            body.bottomAnchor.constraint(equalTo: blur.bottomAnchor),

            header.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: 12),
            header.trailingAnchor.constraint(equalTo: blur.trailingAnchor, constant: -12),
            header.heightAnchor.constraint(equalToConstant: 22),

            imageHolder.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: 12),
            imageHolder.trailingAnchor.constraint(equalTo: blur.trailingAnchor, constant: -12),
            imageHolder.heightAnchor.constraint(greaterThanOrEqualToConstant: 270),

            caption.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: 12),
            caption.trailingAnchor.constraint(equalTo: blur.trailingAnchor, constant: -12),

            blur.widthAnchor.constraint(equalToConstant: 520),
        ])
        panel.contentView = blur

        showArchiveSilently()
        panel.center()
        panel.orderFrontRegardless()

        startTimers()
        _ = CGPreflightScreenCaptureAccess()
    }

    // ---------- 数据/动作 ----------
    func rebuildSources(selecting sel: String?) {
        sourcePopup.removeAllItems()
        sourcePopup.addItem(withTitle: "🖥 全屏")
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return }
        var owners = Set<String>()
        for w in list {
            guard let o = w[kCGWindowOwnerName as String] as? String else { continue }
            if o == "DSHPreview" || o.hasPrefix("虾缸") || isBlacklisted(o) { continue }
            owners.insert(o)
        }
        owners.sorted().forEach { sourcePopup.addItem(withTitle: $0) }
        if let s = sel { sourcePopup.selectItem(withTitle: s) }
    }

    @objc func modeTap(_ sender: NSSegmentedControl) {
        grabNow(annotate: sender.selectedSegment == 1)
    }
    @objc func showArchiveTap() { showArchiveSilently() }

    @objc func toggleLive() {
        liveOn.toggle()
        liveButton.title = liveOn ? "⏸ 停止" : "▶ 实况"
        guard liveOn else { return }
        if let scope = chosenScope(), isBlacklisted(scope) { privacyPause(scope); return }
        if let front = currentFrontApp(), isBlacklisted(front) { privacyPause(front); return }
        grabNow(annotate: false)
    }

    func privacyPause(_ app: String) {
        imageView.image = nil
        caption.text = "🔒 \(app) 在黑名单 · 已按隐私规则暂停采集"
        liveOn = false
        liveButton.title = "▶ 实况"
    }

    func chosenScope() -> String? {
        let t = sourcePopup.titleOfSelectedItem ?? ""
        return t.hasPrefix("🖥") ? nil : t
    }

    func showArchiveSilently() {
        if let img = latestArchive() {
            imageView.image = img
            caption.text = "🗂 存档 · 最近一张屏幕记忆"
        } else {
            caption.text = "暂无存档"
        }
    }

    func startTimers() {
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self = self, self.liveOn, self.panel.isVisible else { return }
            if let scope = self.chosenScope(), isBlacklisted(scope) { self.privacyPause(scope); return }
            if let front = currentFrontApp(), isBlacklisted(front) { self.privacyPause(front); return }
            self.grabNow(annotate: false)
        }
        annTimer = Timer.scheduledTimer(withTimeInterval: 90, repeats: true) { [weak self] _ in
            guard let self = self, self.panel.isVisible, self.liveOn else { return }
            self.grabNow(annotate: true)
        }
    }

    func grabNow(annotate: Bool) {
        if let scope = chosenScope(), isBlacklisted(scope) { privacyPause(scope); return }
        if annotate { caption.text = "🧠 分析中…" }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let img = try captureFrame(scope: self.chosenScope())
                DispatchQueue.main.async {
                    self.imageView.image = img
                    if !annotate {
                        let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
                        self.caption.text = "当前帧 \(f.string(from: Date())) · \(self.liveOn ? "实况中" : "手动")"
                    }
                }
                if annotate, let tiff = img.tiffRepresentation,
                   let rep = NSBitmapImageRep(data: tiff),
                   let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) {
                    aiCaption(jpegData: jpeg) { [weak self] text in
                        self?.caption.text = "🧠 \(text)"
                    }
                }
            } catch CaptureError.noPermission {
                DispatchQueue.main.async {
                    self.caption.text = "需要屏幕录制权限 → 系统设置 → 录屏 → 允许 DSHPreview"
                    _ = CGRequestScreenCaptureAccess()
                }
            } catch {
                DispatchQueue.main.async { self.caption.text = "捕获失败: \(error)" }
            }
        }
    }

    func applicationWillTerminate(_ n: Notification) {
        timer?.invalidate(); annTimer?.invalidate()
    }
}

// ---------- 显式入口 ----------
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
_ = CGPreflightScreenCaptureAccess()
app.setActivationPolicy(.accessory)
app.run()
