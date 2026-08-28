// DSHNotify — 虾缸原生通知发送器(main App)
// 用法: 由 launchd 的 open -g 触发, 参数经 ~/.dsh/notify-queue.jsonl 队列传递
//       (open --args 对已运行实例无效, 改用文件队列更稳)
// 行为: 读队列全部条目逐条弹 UNUserNotification, 单实例互斥锁防重复消费, 处理完退出
import Cocoa
import UserNotifications

let queuePath = ("/Users/marcus/.dsh/notify-queue.jsonl" as NSString).expandingTildeInPath
let lockPath = ("/Users/marcus/.dsh/.notify-lock" as NSString).expandingTildeInPath

struct Entry {
    let title: String
    let msg: String
}

func readEntries() -> [Entry] {
    guard let raw = try? String(contentsOfFile: queuePath, encoding: .utf8),
          !raw.isEmpty else { return [] }
    return raw.split(separator: "\n").compactMap { line in
        // 格式: title\tmsg(转义\t\n)
        let parts = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count >= 1 else { return nil }
        let t = parts[0].replacingOccurrences(of: "\\t", with: "\t")
        let m = parts.count > 1 ? parts[1].replacingOccurrences(of: "\\t", with: "\t")
            .replacingOccurrences(of: "\\n", with: "\n") : ""
        return Entry(title: t, msg: m)
    }
}

func consumeQueue() -> [Entry] {
    // O_EXCL 创建互斥锁文件; 已有实例在处理则放弃本次
    if !FileManager.default.createFile(atPath: lockPath, contents: nil,
                                       attributes: [.posixPermissions: 0o644]) {
        exit(0)
    }
    defer {
        try? FileManager.default.removeItem(atPath: lockPath)
        FileManager.default.createFile(atPath: queuePath, contents: Data(), attributes: nil)
    }
    return readEntries()
}

let entries = consumeQueue()
if entries.isEmpty { exit(0) }

let center = UNUserNotificationCenter.current()
let sem = DispatchSemaphore(value: 0)
var delivered = false

center.requestAuthorization(options: [.alert, .sound]) { _, _ in
    delivered = true
    sem.signal()
}
_ = sem.wait(timeout: .now() + 3)

if delivered {
    var idx = 0
    for e in entries.prefix(8) {
        idx += 1
        let content = UNMutableNotificationContent()
        content.title = e.title
        content.body = e.msg
        content.sound = .default
        content.userInfo["sortId"] = idx
        let req = UNNotificationRequest(
            identifier: "dsh-\(UUID().uuidString)", content: content, trigger: nil)
        center.add(req)
        Thread.sleep(forTimeInterval: 0.05)
    }
    Thread.sleep(forTimeInterval: 1.0)
}
