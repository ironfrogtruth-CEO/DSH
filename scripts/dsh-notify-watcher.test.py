#!/usr/bin/env python3
"""Pure failure-path tests for the DSH notification watcher.

These tests never open the ShrimpTank database and never write watcher state.
"""

import builtins
import json
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch


WATCHER = Path(__file__).resolve().parents[1] / "bin" / "dsh-notify-watcher.py"


class FailedSqliteResult:
    returncode = 1
    stderr = "authorization denied"
    stdout = ""


class NotifyWatcherFailureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = runpy.run_path(str(WATCHER), run_name="dsh_notify_watcher_under_test")

    def test_sqlite_failure_returns_json_serializable_seen_list(self):
        with patch.object(self.module["subprocess"], "run", return_value=FailedSqliteResult()):
            seen, alerts = self.module["scan_shrimp_runs"](
                {"shrimp_seen": ["run-1"]}, baseline=False
            )

        self.assertEqual(seen, ["run-1"])
        self.assertEqual(alerts, [])
        json.dumps({"shrimp_seen": seen})

    def test_heartbeat_read_failure_returns_json_serializable_seen_list(self):
        with patch.object(builtins, "open", side_effect=OSError("read failed")):
            seen, alerts = self.module["scan_heartbeats"](
                {"hb_seen_failed": ["heartbeat-1"]}, baseline=False
            )

        self.assertEqual(seen, ["heartbeat-1"])
        self.assertEqual(alerts, [])
        json.dumps({"hb_seen_failed": seen})


if __name__ == "__main__":
    unittest.main()
