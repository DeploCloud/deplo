import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cleanup", Path(__file__).with_name("main_host_cleanup.py"))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.projects = self.root / "projects"
        self.servers = self.root / "servers"
        self.projects.mkdir()
        self.servers.mkdir()
        for number in (139, 140, 141, 142, 143):
            (self.projects / f"deplo-live-{number}").mkdir()
        (self.projects / "deplo-live-current").symlink_to(self.projects / "deplo-live-142")
        self.now = time.time() + 2 * cleanup.MIN_AGE

    def selected(self):
        return cleanup.candidates(self.projects, self.servers, self.now)

    def test_keeps_active_rollback_and_staged_release(self):
        self.assertEqual(
            {p.name for p in self.selected()},
            {"deplo-live-139", "deplo-live-140"},
        )

    def test_recent_directories_are_kept(self):
        self.assertEqual(cleanup.candidates(self.projects, self.servers), [])

    def test_missing_or_external_active_release_refuses_cleanup(self):
        link = self.projects / "deplo-live-current"
        link.unlink()
        with self.assertRaises(RuntimeError):
            self.selected()
        link.symlink_to(self.root)
        with self.assertRaises(RuntimeError):
            self.selected()

    def test_only_previous_next_builds_are_selected(self):
        project = self.projects / "deplo-3100"
        project.mkdir()
        for name in (".next", ".next.prev-123", "node_modules", ".next.prev-not-a-build"):
            (project / name).mkdir()
        selected = self.selected()
        self.assertIn(project / ".next.prev-123", selected)
        self.assertNotIn(project / ".next", selected)
        self.assertNotIn(project / "node_modules", selected)
        self.assertNotIn(project / ".next.prev-not-a-build", selected)

    def test_symlinks_never_become_deletion_targets(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.projects / "deplo-live-100").symlink_to(outside)
        project = self.projects / "linked-project"
        project.symlink_to(outside)
        (outside / ".next.prev-123").mkdir()
        self.assertNotIn(self.projects / "deplo-live-100", self.selected())
        self.assertNotIn(project / ".next.prev-123", self.selected())

    def test_keeps_two_latest_vscode_versions(self):
        versions = []
        for index in range(4):
            path = self.servers / ("Stable-" + str(index) * 40)
            path.mkdir()
            os.utime(path, (100 + index, 100 + index))
            versions.append(path)
        selected = self.selected()
        self.assertTrue(all(p in selected for p in versions[:2]))
        self.assertTrue(all(p not in selected for p in versions[2:]))

    def test_process_symlink_config_mount_and_version_references(self):
        path = self.projects / "deplo-live-139"
        self.assertTrue(cleanup.protected(path, [path / "server.js"], [], []))
        self.assertTrue(cleanup.protected(path, [], [f"WorkingDirectory={path}"], []))
        self.assertTrue(cleanup.protected(path, [], [], [self.projects]))
        self.assertTrue(cleanup.protected(path, [], [], [path / "data"]))
        self.assertFalse(cleanup.protected(path, [Path(str(path) + "0")], [], []))
        version = "a" * 40
        path = self.servers / ("Stable-" + version)
        self.assertTrue(cleanup.protected(path, [], [f"/root/.vscode-server/code-{version}"], []))

    def test_rechecks_before_removing_and_honors_dry_run(self):
        path = self.projects / "deplo-live-139"
        with patch.object(cleanup, "candidates", side_effect=[[path], []]), \
             patch.object(cleanup, "live_references", return_value=([], [], [])), \
             patch.object(cleanup, "emit"):
            cleanup.cleanup()
        self.assertTrue(path.exists())
        with patch.object(cleanup, "candidates", return_value=[path]), \
             patch.object(cleanup, "live_references", return_value=([], [], [])), \
             patch.object(cleanup, "emit"):
            cleanup.cleanup(dry_run=True)
            self.assertTrue(path.exists())
            cleanup.cleanup()
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
