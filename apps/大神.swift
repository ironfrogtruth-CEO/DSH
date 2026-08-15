// 大神 · 原生桌面应用 — DeepSeek Harness 界面外壳
// 双击启动: 确保 dsh web 服务运行 → 弹出原生窗口加载 DSH 界面(不开浏览器)
// 编译: swiftc -O -o 大神 大神.swift -framework Cocoa -framework WebKit
import Cocoa
import WebKit

let PORT = 3080
let UI_URL = "http://127.0.0.1:\(PORT)"
let ENSURE_SCRIPT = (("~" as NSString).expandingTildeInPath) + "/.dsh/scripts/ensure-web"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var loadInFlight = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
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

        loadWithRetry()
    }

    // 关闭窗口即退出 app;dsh 服务保持后台运行,下次双击秒开
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
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
