"""mobile-push-watcher 单元测试（mock 发送，不联网）。

运行: /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 -m unittest test_mobile_push_watcher.py -v
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path.home() / ".dsh" / "scripts" / "mobile-push-watcher.py"


def load_module(tmp: Path):
    spec = importlib.util.spec_from_file_location("mpw", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.OUTBOX = tmp / "outbox.jsonl"
    module.STATE = tmp / "state.json"
    module.SUBSCRIPTIONS = tmp / "subscriptions.json"
    module.ERR_LOG = tmp / "watcher.err"
    return module


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.mpw = load_module(self.tmp)
        self.sent = []

        def fake_send(subscription, payload, vapid):
            self.sent.append((subscription["endpoint"], payload))
            if self.fail_endpoint and subscription["endpoint"] == self.fail_endpoint:
                raise RuntimeError("mock delivery failure")

        self.fail_endpoint = None
        self.mpw.send_to_subscription = fake_send

    def write_vapid(self):
        self.mpw.VAPID = self.tmp / "vapid.json"
        self.mpw.VAPID.write_text(json.dumps({
            "public": "BPub",
            "private": "Prvt",
            "subject": "mailto:dashen@yizhiwa.cn",
        }), encoding="utf-8")
        return {"private": "Prvt", "subject": "mailto:dashen@yizhiwa.cn", "public": "BPub"}

    def test_drain_consumes_and_increments_badge(self):
        vapid = self.write_vapid()
        self.mpw.SUBSCRIPTIONS.write_text(json.dumps([
            {"endpoint": "https://push.example/a", "keys": {"p256dh": "k", "auth": "a"}},
        ]), encoding="utf-8")
        self.mpw.OUTBOX.write_text(
            json.dumps({"id": "t1", "title": "大神 · 会话已完成", "body": "b", "path": "/", "attempts": 0, "createdAt": "now"}) + "\n" +
            json.dumps({"id": "t2", "title": "大神 · 会话已完成", "body": "b2", "path": "/", "attempts": 0, "createdAt": "now"}) + "\n",
            encoding="utf-8",
        )
        state = {"offset": 0, "unread": 0}
        pushed = self.mpw.drain(self.mpw.OUTBOX, state, vapid)
        self.assertEqual(pushed, 2)
        self.assertEqual(state["unread"], 2)
        self.assertEqual(state["offset"], self.mpw.OUTBOX.stat().st_size)
        self.assertEqual(len(self.sent), 2)
        # badge 随发送递增：第一条约 1，第二条约 2
        self.assertEqual(self.sent[0][1]["badge"], 1)
        self.assertEqual(self.sent[1][1]["badge"], 2)
        # 重复 drain 不重放（字节偏移防重放）
        self.assertEqual(self.mpw.drain(self.mpw.OUTBOX, state, vapid), 0)
        self.assertEqual(len(self.sent), 2)

    def test_clear_line_resets_unread(self):
        vapid = self.write_vapid()
        self.mpw.SUBSCRIPTIONS.write_text(json.dumps([
            {"endpoint": "https://push.example/a", "keys": {"p256dh": "k", "auth": "a"}},
        ]), encoding="utf-8")
        self.mpw.OUTBOX.write_text(
            json.dumps({"id": "t1", "title": "t", "body": "b", "path": "/", "attempts": 0, "createdAt": "now"}) + "\n" +
            json.dumps({"id": "c1", "title": "", "body": "", "path": "/", "attempts": 0, "createdAt": "now", "clear": True}) + "\n",
            encoding="utf-8",
        )
        state = {"offset": 0, "unread": 5}
        self.mpw.drain(self.mpw.OUTBOX, state, vapid)
        self.assertEqual(state["unread"], 0)

    def test_incomplete_tail_line_not_consumed(self):
        vapid = self.write_vapid()
        self.mpw.SUBSCRIPTIONS.write_text(json.dumps([]), encoding="utf-8")
        complete = json.dumps({"id": "t1", "title": "t", "body": "b", "path": "/", "attempts": 0, "createdAt": "now"}) + "\n"
        partial = json.dumps({"id": "t2", "title": "t"})
        self.mpw.OUTBOX.write_text(complete + partial, encoding="utf-8")
        state = {"offset": 0, "unread": 0}
        self.mpw.drain(self.mpw.OUTBOX, state, vapid)
        self.assertEqual(state["offset"], len(complete.encode("utf-8")))

    def test_empty_subscriptions_consume_without_error(self):
        vapid = self.write_vapid()
        self.mpw.SUBSCRIPTIONS.write_text(json.dumps([]), encoding="utf-8")
        self.mpw.OUTBOX.write_text(
            json.dumps({"id": "t1", "title": "t", "body": "b", "path": "/", "attempts": 0, "createdAt": "now"}) + "\n",
            encoding="utf-8",
        )
        state = {"offset": 0, "unread": 0}
        pushed = self.mpw.drain(self.mpw.OUTBOX, state, vapid)
        self.assertEqual(pushed, 1)
        self.assertEqual(len(self.sent), 0)
        self.assertEqual(state["unread"], 1)
        self.assertFalse(self.mpw.ERR_LOG.exists())

    def test_failed_subscription_retried_at_most_twice(self):
        vapid = self.write_vapid()
        self.mpw.SUBSCRIPTIONS.write_text(json.dumps([
            {"endpoint": "https://push.example/bad", "keys": {"p256dh": "k", "auth": "a"}},
            {"endpoint": "https://push.example/good", "keys": {"p256dh": "k", "auth": "a"}},
        ]), encoding="utf-8")
        self.fail_endpoint = "https://push.example/bad"
        attempts = {"n": 0}
        real_send = self.mpw.send_to_subscription

        def counting_send(subscription, payload, v):
            if subscription["endpoint"] == self.fail_endpoint:
                attempts["n"] += 1
            return real_send(subscription, payload, v)

        self.mpw.send_to_subscription = counting_send
        self.mpw.OUTBOX.write_text(
            json.dumps({"id": "t1", "title": "t", "body": "b", "path": "/", "attempts": 0, "createdAt": "now"}) + "\n",
            encoding="utf-8",
        )
        state = {"offset": 0, "unread": 0}
        pushed = self.mpw.drain(self.mpw.OUTBOX, state, vapid)
        self.assertEqual(pushed, 0)  # 有失败则不计入已推送
        self.assertEqual(attempts["n"], 3)  # 首次 + 2 次重试
        self.assertTrue(self.mpw.ERR_LOG.exists())
        self.assertIn("推送最终失败", self.mpw.ERR_LOG.read_text(encoding="utf-8"))

    def test_truncated_outbox_resets_offset(self):
        vapid = self.write_vapid()
        self.mpw.OUTBOX.write_text("stale content\n", encoding="utf-8")
        state = {"offset": 999, "unread": 3}
        pushed = self.mpw.drain(self.mpw.OUTBOX, state, vapid)
        # 截断后从 0 重新消费一次且不卡死：偏移推进到当前文件末尾。
        self.assertEqual(state["offset"], self.mpw.OUTBOX.stat().st_size)
        self.assertEqual(pushed, 0)
        self.assertEqual(state["unread"], 3)

    def test_vapid_missing_fails_closed(self):
        self.mpw.VAPID = self.tmp / "absent-vapid.json"
        with self.assertRaises(RuntimeError):
            self.mpw.load_vapid()


if __name__ == "__main__":
    unittest.main()
