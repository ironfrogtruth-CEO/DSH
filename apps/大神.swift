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

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var loadInFlight = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMainMenu()
        ensureService()

        let rect = NSRect(x: 0, y: 0, width: 1280, height: 840)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "大神"
        window.minSize = NSSize(width: 960, height: 600)
        window.center()

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: rect, configuration: config)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        setupMicButton()

        loadWithRetry()
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
    var micButton: NSButton?

    func setupMicButton() {
        let item = NSTitlebarAccessoryViewController()
        micButton = NSButton(title: "🎤 语音输入", target: self, action: #selector(micPressed))
        micButton?.bezelStyle = .rounded
        micButton?.isContinuous = false
        micButton?.toolTip = "点击开始录音,再点结束,识别文字自动填入输入框"
        item.view = micButton ?? NSView()
        item.layoutAttribute = .trailing
        window.addTitlebarAccessoryViewController(item)
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
                    self.micButton?.title = "🎤 无权限"
                    return
                }
                do {
                    try self.beginRecording()
                    self.micButton?.title = "⏹ 结束"
                } catch {
                    self.micButton?.title = "🎤 启动失败"
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
                // 实时预览(可选): 显示在按钮 tooltip, 不打扰
                self.micButton?.toolTip = result.bestTranscription.formattedString
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
        micButton?.title = "🎤 语音输入"
        micButton?.toolTip = "点击开始录音,再点结束,识别文字自动填入输入框"
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

    // 后台确保服务运行(不打开浏览器,不杀已有实例)
    func ensureService() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [ENSURE_SCRIPT]
        try? p.run()
    }

    func loadWithRetry() {
        guard !loadInFlight else { return }
        loadInFlight = true
        if let url = URL(string: UI_URL) {
            webView.load(URLRequest(url: url))
        }
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
