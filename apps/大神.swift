// 大神 · 原生桌面应用 — DeepSeek Harness 界面外壳
// 双击启动: 确保 dsh web 服务运行 → 弹出原生窗口加载 DSH 界面(不开浏览器)
// 编译: swiftc -O -o 大神 大神.swift -framework Cocoa -framework WebKit -framework Speech -framework AVFoundation
import Cocoa
import WebKit
import Speech
import AVFoundation

let PORT = 3080
let UI_URL = "http://127.0.0.1:\(PORT)"
let ENSURE_SCRIPT = (("~" as NSString).expandingTildeInPath) + "/.dsh/scripts/ensure-web"

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

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var loadInFlight = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMainMenu()

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

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // 先等待 ensure-web 完成可能发生的 Host 重载，再连续确认两次 HTTP
        // 可用后加载页面，避免 WebView 命中旧插件 rev。
        ensureService { [weak self] in
            self?.waitForStableService()
        }
    }

    // 关闭窗口即退出 app;dsh 服务保持后台运行,下次双击秒开
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
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
            } else if let result = result {
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
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
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
    func ensureService(completion: @escaping () -> Void) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [ENSURE_SCRIPT]
        p.terminationHandler = { _ in
            DispatchQueue.main.async(execute: completion)
        }
        do {
            try p.run()
        } catch {
            DispatchQueue.main.async(execute: completion)
        }
    }

    func waitForStableService(attempt: Int = 0, stableChecks: Int = 0) {
        guard attempt < 40, let url = URL(string: UI_URL) else {
            loadWithRetry()
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
                    self.loadWithRetry()
                } else {
                    self.waitForStableService(attempt: attempt + 1, stableChecks: nextStable)
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
            self?.loadWithRetry()
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
