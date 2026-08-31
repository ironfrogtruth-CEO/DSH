#!/usr/bin/env python3
"""DSH 原生通知监听器 — launchd KeepAlive 常驻。

监听两类事件并弹系统通知:
1. 虾运行终态: ~/Desktop/虾缸/data/shrimptank.db runs 表 (只读)
2. 心跳失败: ~/.dsh/heartbeats.json tasks[].status==failed 且出现新 lastRunId

状态基线持久化在 ~/.dsh/notify-watcher-state.json, 重启不会重放历史。
"""
import json
import os
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
STATE_PATH = os.path.join(HOME, ".dsh", "notify-watcher-state.json")
HB_PATH = os.path.join(HOME, ".dsh", "heartbeats.json")
SHRIMP_DB = os.path.join(HOME, "Desktop", "虾缸", "data", "shrimptank.db")
NOTIFY_SH = os.path.join(HOME, ".dsh", "bin", "dsh-notify.sh")

TERMINAL_OK = {"done"}
TERMINAL_BAD = {"failed", "stopped", "blocked_ai_provider"}

def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return None  # None = 首次运行, 只建基线不通知

def save_state(st):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, STATE_PATH)

def notify(title, msg):
    try:
        subprocess.run([NOTIFY_SH, title, msg], timeout=10,
                       capture_output=True)
    except Exception as e:
        print(f"notify error: {e}", file=sys.stderr)

def scan_shrimp_runs(st, baseline):
    """只读扫描虾缸 runs 表新增终态。返回 (新seen集合, 通知列表)"""
    seen = set(st.get("shrimp_seen", []))
    alerts = []
    try:
        # canonical ShrimpTank DB 禁止写入; /usr/bin/sqlite3 -readonly 是本机
        # 已验证的只读通道(Python sqlite3 模块在 WAL 场景报 authorization denied)
        out = subprocess.run(
            ["/usr/bin/sqlite3", "-readonly", SHRIMP_DB,
             "SELECT id||'|'||status||'|'||display_name FROM runs "
             "WHERE status IN ('done','failed','stopped','blocked_ai_provider')"],
            timeout=15, capture_output=True, text=True)
        if out.returncode != 0:
            raise RuntimeError(out.stderr.strip() or f"rc={out.returncode}")
        rows = [ln.split("|", 2) for ln in out.stdout.splitlines() if "|" in ln]
    except Exception as e:
        print(f"shrimp db error: {e}", file=sys.stderr)
        # `seen` is an internal set for de-duplication; persist only a JSON
        # compatible list when the read-only DB probe is unavailable.
        return list(seen), []
    current = set()
    for rid, status, name in rows:
        current.add(rid)
        if rid in seen:
            continue
        label = "成功" if status in TERMINAL_OK else f"终止({status})"
        alerts.append((f'虾运行{label}', f"{name} · {status}"))
    # 只保留最近200个已见id防止无限增长
    recent = list(current)[-200:]
    return recent, ([] if baseline else alerts)

def scan_heartbeats(st, baseline):
    """心跳任务失败检测: 状态 failed 且 lastRunId 是新的。"""
    seen = set(st.get("hb_seen_failed", []))
    alerts = []
    try:
        with open(HB_PATH) as f:
            data = json.load(f)
        tasks = data.get("tasks", [])
    except Exception as e:
        print(f"heartbeat read error: {e}", file=sys.stderr)
        # Keep the failure path serializable for the atomic state checkpoint.
        return list(seen), []
    for t in tasks:
        if t.get("status") != "failed":
            continue
        run_id = t.get("lastRunId") or t.get("name")
        if run_id in seen:
            continue
        err = (t.get("lastError") or "").strip().splitlines()
        brief = next((ln for ln in reversed(err) if ln.strip()), "")[:120]
        alerts.append((f"心跳失败: {t.get('name', '?')}", brief))
        seen.add(run_id)
    recent = list(seen)[-100:]
    return recent, ([] if baseline else alerts)

def main():
    st = load_state()
    baseline = st is None
    st = st or {"shrimp_seen": [], "hb_seen_failed": []}

    shrimp_seen, shrimp_alerts = scan_shrimp_runs(st, baseline)
    hb_seen, hb_alerts = scan_heartbeats(st, baseline)

    st["shrimp_seen"] = shrimp_seen if shrimp_seen else st.get("shrimp_seen", [])
    st["hb_seen_failed"] = hb_seen if hb_seen else st.get("hb_seen_failed", [])

    all_alerts = shrimp_alerts + hb_alerts
    save_state(st)
    if not baseline:
        for title, msg in all_alerts[:10]:  # 单轮最多10条防风暴
            notify(title, msg)
            time.sleep(0.4)
        if len(all_alerts) > 10:
            notify("大神 Harness", f"另有 {len(all_alerts)-10} 条事件未展示")

if __name__ == "__main__":
    main()
