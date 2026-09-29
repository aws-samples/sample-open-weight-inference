"""The container image must contain every backend package the app imports.

Regression: `agent/` was added to backend/ but not to the Dockerfile's COPY list, so
the image built and pushed cleanly, then crashed on import inside AgentCore. Every
request returned HTTP 424 with the detail replaced by a CloudWatch pointer, which is
an expensive way to discover a missing directory.
"""

from __future__ import annotations

import re
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2] / "backend"

# Not part of the runtime image.
EXCLUDED = {"__pycache__", "tests"}


def _copied_directories() -> set[str]:
    dockerfile = (BACKEND / "Dockerfile").read_text()
    return {
        match.group(1)
        for match in re.finditer(r"^COPY\s+([A-Za-z0-9_]+)/\s", dockerfile, re.M)
    }


def _python_packages() -> set[str]:
    return {
        child.name
        for child in BACKEND.iterdir()
        if child.is_dir()
        and child.name not in EXCLUDED
        and (child / "__init__.py").exists()
    }


def test_every_backend_package_is_copied_into_the_image():
    missing = _python_packages() - _copied_directories()
    assert not missing, (
        f"backend packages missing from the Dockerfile COPY list: {sorted(missing)}. "
        "The image will build and then crash on import inside AgentCore."
    )


def test_copied_directories_all_exist():
    stale = {d for d in _copied_directories() if not (BACKEND / d).is_dir()}
    assert not stale, f"Dockerfile copies directories that no longer exist: {sorted(stale)}"
