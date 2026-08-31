// 大神 · Universal 便携桌面应用 — 内置 Node/DSH 的 DeepSeek Harness 界面外壳
// 分别编译 arm64 与 x86_64 后由 lipo 合并；Host 与用户数据隔离在应用程序支持目录。
import Cocoa
import WebKit
import Speech
import AVFoundation

let PROCESS_ENVIRONMENT = ProcessInfo.processInfo.environment
let PORT = Int(PROCESS_ENVIRONMENT["DASHEN_PORT"] ?? "3080") ?? 3080
let UI_URL = "http://127.0.0.1:\(PORT)"
let DEFAULT_SUPPORT_ROOT = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/大神")
let APP_SUPPORT_ROOT = PROCESS_ENVIRONMENT["DASHEN_SUPPORT_ROOT"] ?? DEFAULT_SUPPORT_ROOT
let HOST_SCRIPT = Bundle.main.resourceURL?.appendingPathComponent("bin/dashen-runtime").path ?? ""
let BACKGROUND_LAUNCH_SENTINEL = (APP_SUPPORT_ROOT as NSString).appendingPathComponent("background-launch")
let BACKGROUND_LAUNCH_MAX_AGE: TimeInterval = 5 * 60

// WKWebView 会吃掉无边框标题栏的鼠标事件。用一条完全透明的原生视图
// 接管顶部空白区域的按下事件，恢复系统窗口拖动，同时避开左侧红绿灯和右侧工具按钮。
final class WindowDragRegionView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var loadInFlight = false
    var isTerminating = false
    var statusItem: NSStatusItem!
    var hostHealthTimer: Timer?
    var hostWakeObserver: NSObjectProtocol?
    var hostHealthProbeInFlight = false
    var hostEnsureInFlight = false
    var backgroundRecoveryLaunch = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        backgroundRecoveryLaunch = consumeBackgroundLaunchSentinel()
        NSApp.setActivationPolicy(.regular)
        installMainMenu()
        installStatusItem()

        let rect = NSRect(x: 0, y: 0, width: 1280, height: 840)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        // 一体化无外框: 透明标题栏、隐藏标题、无分隔线(只留红绿灯)
        window.title = ""
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.minSize = NSSize(width: 960, height: 600)
        window.center()

        let config = WKWebViewConfiguration()
        // 只在原生客户端标记 macOS 窗口安全区；普通浏览器不改动布局。
        let desktopMarker = WKUserScript(
            source: "document.documentElement.dataset.shrimpDesktop = 'true'",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(desktopMarker)
        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // 原生↔Web 语音桥: Web 端按钮 → 原生 SFSpeechRecognizer
        webView.configuration.userContentController.add(self, name: "shrimpVoice")
        let contentContainer = NSView(frame: rect)
        contentContainer.autoresizingMask = [.width, .height]
        webView.frame = contentContainer.bounds
        webView.autoresizingMask = [.width, .height]
        contentContainer.addSubview(webView)
        window.contentView = contentContainer

        let dragHeight: CGFloat = 32
        let dragLeft: CGFloat = 96
        let dragRight: CGFloat = 300
        let dragRegion = WindowDragRegionView(frame: NSRect(
            x: dragLeft,
            y: max(0, contentContainer.bounds.height - dragHeight),
            width: max(120, contentContainer.bounds.width - dragLeft - dragRight),
            height: dragHeight
        ))
        dragRegion.autoresizingMask = [.width, .minYMargin]
        dragRegion.setAccessibilityElement(false)
        contentContainer.addSubview(dragRegion, positioned: .above, relativeTo: webView)

        // LaunchAgent recovery opens 大神 with -gj so TCC attaches to this App
        // without stealing focus. A normal user double-click still presents it.
        if !backgroundRecoveryLaunch {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }

        guard prepareBundledRuntimePermission() else {
            DispatchQueue.main.async { NSApp.terminate(nil) }
            return
        }
        promptForAPIIfNeeded()
        startHostRecovery()
        installHostHealthMonitoring()
    }

    // 红色关闭按钮只隐藏窗口，保留 App、WebView 和 3080 Host。
    // Dock 点击图标可恢复原窗口；只有显式“退出大神”才终止 App 和服务。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if isTerminating { return true }
        sender.orderOut(nil)
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            backgroundRecoveryLaunch = false
            window.makeKeyAndOrderFront(nil)
            sender.activate(ignoringOtherApps: true)
        }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        isTerminating = true
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopHostHealthMonitoring()
        if audioEngine.isRunning || recognitionRequest != nil || recognitionTask != nil {
            cleanupRecording()
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [HOST_SCRIPT, "stop"]
        process.environment = portableProcessEnvironment()
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            // App 仍应退出；下次启动会通过 ensure-web 校正 Host 状态。
        }
    }

    // Watchdog writes this only for a hidden recovery launch. Always consume
    // the marker so a stale launch request cannot suppress a later user open.
    func consumeBackgroundLaunchSentinel() -> Bool {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: BACKGROUND_LAUNCH_SENTINEL) else { return false }
        defer { try? fileManager.removeItem(atPath: BACKGROUND_LAUNCH_SENTINEL) }
        guard let attributes = try? fileManager.attributesOfItem(atPath: BACKGROUND_LAUNCH_SENTINEL),
              let modified = attributes[.modificationDate] as? Date else { return false }
        let age = Date().timeIntervalSince(modified)
        return age >= -60 && age <= BACKGROUND_LAUNCH_MAX_AGE
    }

    func installHostHealthMonitoring() {
        hostHealthTimer?.invalidate()
        hostHealthTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.checkHostHealth()
        }
        hostHealthTimer?.tolerance = 3
        hostWakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self?.checkHostHealth()
            }
        }
    }

    func stopHostHealthMonitoring() {
        hostHealthTimer?.invalidate()
        hostHealthTimer = nil
        if let observer = hostWakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            hostWakeObserver = nil
        }
    }

    // 标准编辑菜单: 程序化 app 没有 mainMenu 时 Cmd+C/V/X/A 等编辑快捷键
    // 不会分发到 first responder(WKWebView 的 textarea),导致无法粘贴/复制。
    func installMainMenu() {
        let mainMenu = NSMenu()

        // App 菜单
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        let apiItem = NSMenuItem(title: "配置 API…", action: #selector(showAPISettings), keyEquivalent: ",")
        apiItem.target = self
        appMenu.addItem(apiItem)
        let runtimeItem = NSMenuItem(title: "修复内置 Node 权限…", action: #selector(repairBundledRuntimePermissions), keyEquivalent: "")
        runtimeItem.target = self
        appMenu.addItem(runtimeItem)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出大神", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // 编辑菜单 — 让 WKWebView 的 textarea 支持复制/粘贴/剪切/全选/撤销
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        NSApp.mainMenu = mainMenu
    }

    // ---- macOS 顶部菜单栏小 logo(虾缸 mark,有边框无文字) ----
    // 图标: Resources/menubar-logo.png(36px @2x, 展示 18pt)
    func installStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        guard let button = statusItem.button else { return }
        let iconPath = Bundle.main.path(forResource: "menubar-logo", ofType: "png") ?? ""
        if let img = NSImage(contentsOfFile: iconPath) {
            img.size = NSSize(width: 18, height: 18)
            button.image = img
        }
        button.toolTip = "大神"
        let menu = NSMenu()
        let showItem = NSMenuItem(title: "显示大神窗口", action: #selector(showMainWindow), keyEquivalent: "")
        showItem.target = self
        menu.addItem(showItem)
        // 托盘「刷新」: 仅重载 WKWebView 的 Web UI(浏览器级 ⌘R), 不触碰 host 进程。
        let refreshItem = NSMenuItem(title: "刷新", action: #selector(reloadWebView), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)
        let apiItem = NSMenuItem(title: "配置 API…", action: #selector(showAPISettings), keyEquivalent: "")
        apiItem.target = self
        menu.addItem(apiItem)
        let runtimeItem = NSMenuItem(title: "修复内置 Node 权限…", action: #selector(repairBundledRuntimePermissions), keyEquivalent: "")
        runtimeItem.target = self
        menu.addItem(runtimeItem)
        menu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "退出大神", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.target = NSApp
        menu.addItem(quitItem)
        statusItem.menu = menu
    }

    @objc func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    // 托盘「刷新」(⌘R): 等同浏览器刷新, 只重载 WebView 页面, 不重启 host。
    @objc func reloadWebView() {
        webView?.reload()
    }

    func portableProcessEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["DASHEN_PORT"] = String(PORT)
        environment["DASHEN_SUPPORT_ROOT"] = APP_SUPPORT_ROOT
        environment["DASHEN_WORKSPACE"] = environment["DASHEN_WORKSPACE"] ?? (NSHomeDirectory() as NSString).appendingPathComponent("Desktop")
        return environment
    }

    func installedCredentialsURL() -> URL {
        URL(fileURLWithPath: APP_SUPPORT_ROOT, isDirectory: true)
            .appendingPathComponent("dsh-home", isDirectory: true)
            .appendingPathComponent(".credentials.yaml")
    }

    func pendingCredentialsURL() -> URL {
        URL(fileURLWithPath: APP_SUPPORT_ROOT, isDirectory: true)
            .appendingPathComponent("pending-credentials.yaml")
    }

    func credentialsURLForWrite() -> URL {
        let installed = installedCredentialsURL()
        return FileManager.default.fileExists(atPath: installed.deletingLastPathComponent().path) ? installed : pendingCredentialsURL()
    }

    func hasDeepSeekCredential() -> Bool {
        for url in [installedCredentialsURL(), pendingCredentialsURL()] {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            if text.split(separator: "\n").contains(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("DEEPSEEK_API_KEY:") }) {
                return true
            }
        }
        return false
    }

    func yamlQuoted(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let array = String(data: data, encoding: .utf8), array.count >= 2 else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }

    func updateCredential(_ key: String, value: String, lines: inout [String]) {
        guard !value.isEmpty else { return }
        let prefix = "\(key):"
        if let index = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix(prefix) }) {
            lines[index] = "  \(key): \(yamlQuoted(value))"
            return
        }
        if let refsIndex = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "refs:" }) {
            lines.insert("  \(key): \(yamlQuoted(value))", at: refsIndex + 1)
        } else {
            lines.append("refs:")
            lines.append("  \(key): \(yamlQuoted(value))")
        }
    }

    func saveCredentials(deepSeek: String, zhipu: String) throws {
        let url = credentialsURLForWrite()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var lines: [String]
        if let existing = try? String(contentsOf: url, encoding: .utf8) {
            lines = existing.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        } else {
            lines = ["version: 1", "refs:"]
        }
        updateCredential("DEEPSEEK_API_KEY", value: deepSeek, lines: &lines)
        updateCredential("ZHIPU_API_KEY", value: zhipu, lines: &lines)
        try (lines.joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    func promptForAPIIfNeeded(force: Bool = false) {
        if !force && hasDeepSeekCredential() { return }
        let alert = NSAlert()
        alert.messageText = "配置大神 API"
        alert.informativeText = force
            ? "输入新密钥会更新对应配置；留空会保留原值。"
            : "DeepSeek API Key 用于基础模型调用；智谱 API Key 用于可选的图片、OCR 等能力。密钥只保存在当前 Mac。"
        alert.alertStyle = .informational

        let deepSeekField = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        deepSeekField.placeholderString = force ? "留空则保留现有 DeepSeek API Key" : "DeepSeek API Key"
        let zhipuField = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        zhipuField.placeholderString = "智谱 API Key（可选）"
        let grid = NSGridView(views: [
            [NSTextField(labelWithString: "DeepSeek"), deepSeekField],
            [NSTextField(labelWithString: "智谱"), zhipuField],
        ])
        grid.rowSpacing = 10
        grid.columnSpacing = 12
        alert.accessoryView = grid
        alert.addButton(withTitle: "保存并启动")
        alert.addButton(withTitle: "稍后配置")
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return }
        do {
            try saveCredentials(deepSeek: deepSeekField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
                                zhipu: zhipuField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
        } catch {
            let errorAlert = NSAlert()
            errorAlert.messageText = "API 配置保存失败"
            errorAlert.informativeText = error.localizedDescription
            errorAlert.alertStyle = .warning
            errorAlert.runModal()
        }
    }

    @objc func showAPISettings() {
        promptForAPIIfNeeded(force: true)
    }

    func runtimePermissionMarkerURL() -> URL {
        URL(fileURLWithPath: APP_SUPPORT_ROOT, isDirectory: true)
            .appendingPathComponent("runtime-permission-2.1.1")
    }

    func prepareBundledRuntimePermission(force: Bool = false) -> Bool {
        let bundlePath = Bundle.main.bundlePath
        if bundlePath.hasPrefix("/Volumes/") {
            let alert = NSAlert()
            alert.messageText = "请先安装大神"
            alert.informativeText = "不要直接从 DMG 中运行。请把大神拖入“应用程序”，退出当前窗口，再从“应用程序”启动。"
            alert.alertStyle = .warning
            alert.addButton(withTitle: "好")
            alert.runModal()
            return false
        }

        let marker = runtimePermissionMarkerURL()
        if !force && FileManager.default.fileExists(atPath: marker.path) { return true }

        let alert = NSAlert()
        alert.messageText = "允许大神运行内置 Node/DSH"
        alert.informativeText = "本安装包未经过 Apple 公证。macOS 可能单独拦截内置 Node。点击“允许并继续”只会移除当前大神.app 的下载隔离标记，不会关闭系统安全功能，也不会处理其他文件。"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "允许并继续")
        alert.addButton(withTitle: "退出")
        guard alert.runModal() == .alertFirstButtonReturn else { return false }

        let process = Process()
        let errorPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        process.arguments = ["-d", "-r", "com.apple.quarantine", bundlePath]
        process.standardError = errorPipe
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            showRuntimePermissionError(error.localizedDescription)
            return false
        }
        guard process.terminationStatus == 0 else {
            let data = errorPipe.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: data, encoding: .utf8) ?? "无法移除下载隔离标记。"
            showRuntimePermissionError(message)
            return false
        }
        do {
            try FileManager.default.createDirectory(at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
            try "2.1.1\n".write(to: marker, atomically: true, encoding: .utf8)
        } catch {
            showRuntimePermissionError(error.localizedDescription)
            return false
        }
        return true
    }

    func showRuntimePermissionError(_ detail: String) {
        let alert = NSAlert()
        alert.messageText = "内置 Node 权限修复失败"
        alert.informativeText = "请确认大神已经拖入“应用程序”，然后在终端执行：\n\nxattr -dr com.apple.quarantine /Applications/大神.app\n\n\(detail)"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "好")
        alert.runModal()
    }

    @objc func repairBundledRuntimePermissions() {
        if prepareBundledRuntimePermission(force: true) { startHostRecovery() }
    }

    // ---- 语音输入: macOS 系统语音识别(SFSpeechRecognizer),离线、中文 --
    var audioEngine = AVAudioEngine()
    var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    var recognitionTask: SFSpeechRecognitionTask?

    // Web 端按钮 → 原生: window.webkit.messageHandlers.shrimpVoice.postMessage('toggle')
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "shrimpVoice" else { return }
        micPressed()
    }

    // 录音状态 → Web 按钮: window.__shrimpVoiceState(state)
    func notifyVoiceState(_ state: String) {
        webView?.evaluateJavaScript("window.__shrimpVoiceState && window.__shrimpVoiceState('\(state)')") { _, _ in }
    }

    @objc func micPressed() {
        if audioEngine.isRunning {
            stopRecording(final: true)
        } else {
            startRecording()
        }
    }

    func startRecording() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard status == .authorized else {
                    self.notifyVoiceState("denied")
                    return
                }
                do {
                    try self.beginRecording()
                    self.notifyVoiceState("recording")
                } catch {
                    self.notifyVoiceState("error")
                }
            }
        }
    }

    func beginRecording() throws {
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
        guard let recognizer = recognizer, recognizer.isAvailable else {
            throw NSError(domain: "dashen", code: 1)
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        let node = audioEngine.inputNode
        let format = node.outputFormat(forBus: 0)
        node.removeTap(onBus: 0)
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            self.recognitionRequest?.append(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result, result.isFinal {
                self.injectText(result.bestTranscription.formattedString)
                self.cleanupRecording()
            } else if error != nil {
                if let result = result {
                    self.injectText(result.bestTranscription.formattedString)
                }
                self.cleanupRecording()
            } else if result != nil {
                // 实时预览: 部分结果发到 Web 按钮 tooltip(可选,不打扰)
            }
        }
    }

    func stopRecording(final: Bool) {
        if final {
            recognitionRequest?.endAudio()
        } else {
            cleanupRecording()
        }
    }

    func cleanupRecording() {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        recognitionRequest = nil
        recognitionTask = nil
        notifyVoiceState("idle")
    }

    // 把识别文本注入页面 textarea(受控组件: 原生 setter + input 事件)
    func injectText(_ text: String) {
        guard let webView = webView, !text.isEmpty else { return }
        // JSON 序列化文本,安全嵌入 JS
        let encoded: String
        if let data = try? JSONSerialization.data(withJSONObject: [text]) {
            let arr = String(data: data, encoding: .utf8) ?? "[]"
            encoded = String(arr.dropFirst().dropLast())
        } else {
            encoded = "\"\""
        }
        let js = """
        (() => {
          const ta = document.querySelector('textarea');
          if (!ta) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          const sep = (ta.value && !ta.value.endsWith('\\n')) ? ' ' : '';
          setter.call(ta, ta.value + sep + \(encoded));
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.focus();
          return true;
        })()
        """
        webView.evaluateJavaScript(js) { _, _ in }
    }

    // 后台确保服务运行。脚本可能先停掉旧 Host 再拉起新 Host，因此必须等
    // 脚本结束后再探测页面，不能看到旧 3080 就立即加载。
    func startHostRecovery() {
        guard !isTerminating, !hostEnsureInFlight else { return }
        hostEnsureInFlight = true
        ensureService { [weak self] in
            guard let self = self else { return }
            self.waitForStableService { [weak self] recovered in
                guard let self = self else { return }
                self.hostEnsureInFlight = false
                // A WebView reload is allowed only after two consecutive HTTP
                // probes prove that the Host recovered.  A failed ensure must
                // leave the current page untouched instead of reloading into a
                // white screen.
                guard recovered, !self.isTerminating else { return }
                self.loadWithRetry()
            }
        }
    }

    func checkHostHealth() {
        guard !isTerminating, !hostHealthProbeInFlight, !hostEnsureInFlight,
              let url = URL(string: UI_URL) else { return }
        hostHealthProbeInFlight = true
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let healthy = (response as? HTTPURLResponse).map { 200..<500 ~= $0.statusCode } ?? false
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.hostHealthProbeInFlight = false
                if !healthy { self.startHostRecovery() }
            }
        }.resume()
    }

    func ensureService(completion: @escaping () -> Void) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [HOST_SCRIPT, "start"]
        p.environment = portableProcessEnvironment()
        p.terminationHandler = { _ in
            DispatchQueue.main.async(execute: completion)
        }
        do {
            try p.run()
        } catch {
            DispatchQueue.main.async(execute: completion)
        }
    }

    func waitForStableService(attempt: Int = 0, stableChecks: Int = 0, completion: @escaping (Bool) -> Void) {
        guard attempt < 40, let url = URL(string: UI_URL) else {
            completion(false)
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let ok = (response as? HTTPURLResponse).map { 200..<500 ~= $0.statusCode } ?? false
            let nextStable = ok ? stableChecks + 1 : 0
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                guard let self = self else { return }
                if nextStable >= 2 {
                    completion(true)
                } else {
                    self.waitForStableService(attempt: attempt + 1, stableChecks: nextStable, completion: completion)
                }
            }
        }.resume()
    }

    func loadWithRetry() {
        guard !loadInFlight else { return }
        loadInFlight = true
        if let url = URL(string: UI_URL) {
            webView.load(URLRequest(url: url))
        }
    }

    // 大神内部页保留在当前窗口；充值等外部链接交给系统默认浏览器。
    func isInternalURL(_ url: URL) -> Bool {
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == PORT
    }

    func openExternalURL(_ url: URL) {
        guard url.scheme == "https" || url.scheme == "http" else { return }
        NSWorkspace.shared.open(url)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if isInternalURL(url) || url.scheme == "about" {
            decisionHandler(.allow)
            return
        }
        openExternalURL(url)
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            if isInternalURL(url) {
                webView.load(URLRequest(url: url))
            } else {
                openExternalURL(url)
            }
        }
        return nil
    }

    // 服务未就绪(连接被拒) → 2 秒后重试
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadInFlight = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.startHostRecovery()
        }
    }

    // Successful navigation closes the in-flight gate.  Without this reset a
    // later Host recovery or content-process restart cannot load the page.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadInFlight = false
    }

    // WKWebView may lose its content process while the Host is still alive.
    // Re-enter the same guarded recovery path; it reloads once only after the
    // Host has passed the two-probe stability gate.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loadInFlight = false
        startHostRecovery()
    }

    // ---- WKWebView 默认不实现 window.alert/confirm/prompt：不实现这些代理时
    // 三者会被静默吞掉，confirm 恒返回 false（undefined），导致「运行虾」「抓虾
    // 发布/方案确认」等依赖 confirm 的按钮点了毫无反应。这里补上原生对话框。
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        let response = alert.runModal()
        completionHandler(response == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        let textField = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        textField.stringValue = defaultText ?? ""
        alert.accessoryView = textField
        let response = alert.runModal()
        completionHandler(response == .alertFirstButtonReturn ? textField.stringValue : nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
