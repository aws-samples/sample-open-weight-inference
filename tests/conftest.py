"""Put backend/ on sys.path so tests import the same module paths Lambda uses.

The deployed zip root is backend/, making api, solver, and catalog top-level
packages. Tests import them the same way so an import that works locally cannot
fail in Lambda.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
