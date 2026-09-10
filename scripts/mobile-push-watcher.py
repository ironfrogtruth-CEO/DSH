#!/Library/Frameworks/Python.framework/Versions/3.11/bin/python3
"""dsh-mobile-push watcher — 消费 outbox.jsonl 并经 pywebpush 发送 Web Push。

由 LaunchAgent cn.yizhiwa.dashen.mobile-push-watcher 常驻（KeepAlive），每 5 秒：
  1. 从 ~/.dsh/private/mobile-push/outbox.jsonl 的已记录字节偏移读取完整行
     （偏移持久化在 state.json，防重放；不完整尾行留待下次）。
  2. 普通行 {id,title,body,path,attempts,...}：向 subscriptions.json 全部订阅
     发送，payload = {title, body, badge:<未读数>, url}；单订阅失败最多重试
     2 次；最终失败写 ~/.dsh/logs/mobile-push-watcher.err。
  3. {clear:true} 行：未读数清零（对应打开页面后 clearAppBadge）。
  4. 订阅为空时只消费不报错。

state.json: {"offset": <int bytes consumed>, "unread": <int>, "updatedAt": <ISO>}
"""
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

DSH_HOME = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh"))
PUSH_DIR = DSH_HOME / "private" / "mobile-push"
OUTBOX = PUSH_DIR / "outbox.jsonl"
STATE = PUSH_DIR / "state.json"
SUBSCRIPTIONS = PUSH_DIR / "subscriptions.json"
VAPID = PUSH_DIR / "vapid.json"
ERR_LOG = DSH_HOME / "logs" / "mobile-push-watcher.err"
INTERVAL_SECONDS = 5
MAX_ATTEMPTS = 3  # 首次 + 2 次重试

sys.path.insert(0, str(Path(__file__).resolve().parent))


def log_error(message: str) -> None:
    try:
        ERR_LOG.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).isoformat()
        with ERR_LOG.open("a", encoding="utf-8") as handle:
            handle.write(f"{stamp} {message}\n")
    except OSError:
        pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_state(state: dict) -> None:
    try:
        PUSH_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        STATE.write_text(
            json.dumps({"offset": state["offset"], "unread": state["unread"], "updatedAt": now_iso()}, ensure_ascii=False),
            encoding="utf-8",
        )
        os.chmod(STATE, 0o600)
    except OSError as error:
        log_error(f"state write failed: {error}")


def load_state() -> dict:
    value = load_json(STATE, None)
    if not isinstance(value, dict) or not isinstance(value.get("offset"), int) or value["offset"] < 0:
        return {"offset": 0, "unread": 0}
    return {"offset": value["offset"], "unread": int(value.get("unread", 0))}


def load_vapid() -> dict:
    value = load_json(VAPID, None)
    if not isinstance(value, dict):
        raise RuntimeError("vapid.json 缺失或非法")
    private, subject, public = value.get("private"), value.get("subject"), value.get("public")
    if not (isinstance(private, str) and private and isinstance(subject, str) and subject and isinstance(public, str) and public):
        raise RuntimeError("vapid.json 缺少 public/private/subject")
    return {"private": private, "subject": subject, "public": public}


def send_to_subscription(subscription: dict, payload: dict, vapid: dict) -> None:
    """单次真实发送；任何异常向上抛出由调用方计次重试。

    pywebpush.webpush 接受 base64url 原始私钥字符串（Vapid.from_string，
    与 vapid.json 的 private 字段同格式），并自行生成 VAPID Authorization。
    """
    from pywebpush import webpush

    endpoint = subscription.get("endpoint")
    keys = subscription.get("keys") if isinstance(subscription.get("keys"), dict) else {}
    if not isinstance(endpoint, str) or not endpoint.startswith("https://"):
        raise ValueError(f"无效订阅 endpoint: {endpoint!r}")
    response = webpush(
        subscription_info={"endpoint": endpoint, "keys": {"p256dh": keys.get("p256dh", ""), "auth": keys.get("auth", "")}},
        data=json.dumps(payload, ensure_ascii=False),
        vapid_private_key=vapid["private"],
        vapid_claims={"sub": vapid["subject"]},
        ttl=3600,
    )
    if getattr(response, "status_code", 0) not in (200, 201):
        raise RuntimeError(f"push endpoint 返回 {getattr(response, 'status_code', '?')}")


def _audience(endpoint: str) -> str:
    from urllib.parse import urlsplit

    parts = urlsplit(endpoint)
    return f"{parts.scheme}://{parts.netloc}"


def process_line(line: str, vapid: dict, badge: int) -> tuple[bool, bool]:
    """返回 (是否普通推送行, 是否全部订阅发送成功或无订阅)。badge 为该条推送应显示的未读数。"""
    try:
        task = json.loads(line)
    except ValueError as error:
        log_error(f"outbox 行解析失败: {error}; 原文: {line[:200]}")
        return (False, True)
    if not isinstance(task, dict):
        return (False, True)
    if task.get("clear") is True:
        return (False, True)
    if not isinstance(task.get("title"), str) or not task.get("id"):
        log_error(f"outbox 行缺少 id/title，跳过: {line[:200]}")
        return (False, True)
    subscriptions = load_json(SUBSCRIPTIONS, [])
    if not isinstance(subscriptions, list):
        subscriptions = []
    if not subscriptions:
        return (True, True)
    all_ok = True
    for subscription in subscriptions:
        attempts = 0
        delivered = False
        while attempts < MAX_ATTEMPTS and not delivered:
            attempts += 1
            try:
                send_to_subscription(subscription, {"title": task["title"], "body": str(task.get("body", "")), "badge": badge, "url": str(task.get("path", "/"))}, vapid)
                delivered = True
            except Exception as error:  # noqa: BLE001 — 单订阅失败必须隔离
                detail = f"task={task.get('id')} attempt={attempts}/{MAX_ATTEMPTS} endpoint={subscription.get('endpoint', '')[:64]} error={error}"
                if attempts >= MAX_ATTEMPTS:
                    log_error(f"推送最终失败: {detail}\n{traceback.format_exc(limit=3)}")
                    all_ok = False
                else:
                    time.sleep(0.5)
    return (True, all_ok)


def drain(outbox: Path, state: dict, vapid: dict) -> int:
    """消费所有完整行；返回本次消费的普通推送条数。"""
    try:
        size = outbox.stat().st_size
    except OSError:
        return 0
    if size < state["offset"]:
        # 文件被截断/轮转：从头开始，避免永久卡死。
        state["offset"] = 0
        state.setdefault("unread", 0)
    if size == state["offset"]:
        return 0
    pushed = 0
    with outbox.open("rb") as handle:
        handle.seek(state["offset"])
        blob = handle.read(size - state["offset"])
    end = state["offset"]
    last_newline = blob.rfind(b"\n")
    if last_newline == -1:
        return 0
    chunk = blob[:last_newline]
    end += last_newline + 1
    for raw_line in chunk.split(b"\n"):
        if not raw_line.strip():
            continue
        try:
            line = raw_line.decode("utf-8")
        except UnicodeDecodeError:
            log_error("outbox 行非 UTF-8，跳过")
            continue
        task = None
        try:
            parsed = json.loads(line)
            if isinstance(parsed, dict):
                task = parsed
        except ValueError:
            pass
        if isinstance(task, dict) and task.get("clear") is True:
            # 打开页面后的清除信号：未读数清零（clearAppBadge 在客户端同步执行）。
            state["unread"] = 0
            continue
        is_push, ok = process_line(line, vapid, int(state.get("unread", 0)) + 1)
        if is_push and ok:
            pushed += 1
            state["unread"] = int(state.get("unread", 0)) + 1
        elif is_push and not ok:
            # 发送失败也不重放（偏移已越过），仅保留错误日志。
            pass
    state["offset"] = end
    return pushed


def main() -> int:
    vapid = load_vapid()
    state = load_state()
    while True:
        try:
            drain(OUTBOX, state, vapid)
            save_state(state)
        except Exception as error:  # noqa: BLE001 — 守护进程必须存活
            log_error(f"drain 异常: {error}\n{traceback.format_exc(limit=5)}")
            time.sleep(INTERVAL_SECONDS)
            continue
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
