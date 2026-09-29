"""Workshop result files must be private from creation and replace links safely."""
from __future__ import annotations

import importlib.util
import json
import stat
from pathlib import Path


def test_result_is_private_and_does_not_follow_a_preexisting_symlink(tmp_path):
    spec = importlib.util.spec_from_file_location(
        "workshop_result", Path(__file__).resolve().parents[2] / "scripts/workshop/bootstrap.py")
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    victim = tmp_path / "unrelated.txt"
    victim.write_text("keep this")
    result = tmp_path / "output" / "result.json"
    result.parent.mkdir()
    result.symlink_to(victim)
    bootstrap.write_result(result, {"CheckpointStatus": "Published"})
    assert victim.read_text() == "keep this"
    assert not result.is_symlink()
    assert stat.S_IMODE(result.stat().st_mode) == 0o600
    assert json.loads(result.read_text()) == {"CheckpointStatus": "Published"}
    assert not list(result.parent.glob(".eddie-result-*"))
