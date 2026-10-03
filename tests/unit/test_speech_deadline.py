"""Exercise a real spawned process without model files or cloud resources."""
import json
import os
from pathlib import Path
import sys
import threading
import time

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend/speech-runtime"))
from worker import BoundedWorker, MAX_REPLY


def model_double(connection):
    connection.send_bytes(json.dumps({"status": "ready", "details": {"pid": os.getpid()}}).encode())
    try:
        while True:
            request = json.loads(connection.recv_bytes(8192))
            mode = request.get("mode")
            if mode == "before-callback":
                time.sleep(10)  # Native work before any audio callback.
            if mode == "after-callback":
                # Audio already exists; post-processing must not evade the deadline.
                result = {"audio": "synthetic-valid-audio"}
                time.sleep(10)
            elif mode == "crash":
                return
            elif mode == "oversized":
                connection.send_bytes(b"x" * (MAX_REPLY + 1))
                continue
            else:
                time.sleep(request.get("delay", 0))
                result = {"audio": "synthetic-valid-audio", "pid": os.getpid()}
            connection.send_bytes(json.dumps({"ok": True, "result": result}).encode())
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


def never_ready(connection):
    time.sleep(10)


def wait_ready(worker):
    until = time.monotonic() + 5
    while not worker.ready and time.monotonic() < until:
        time.sleep(0.02)
    assert worker.ready, worker.error


@pytest.fixture
def engine():
    worker = BoundedWorker(model_double, deadline=0.2, startup_timeout=5)
    worker.start()
    assert worker.ready
    try:
        yield worker
    finally:
        worker.close()


@pytest.mark.parametrize("mode", ["before-callback", "after-callback"])
def test_native_work_is_killed_on_wall_clock_expiry_and_late_audio_is_rejected(engine, mode):
    old_process = engine._process
    old_pid = old_process.pid
    started = time.monotonic()
    with pytest.raises(TimeoutError, match="no audio is returned"):
        engine.invoke({"mode": mode})
    assert time.monotonic() - started < 2
    wait_ready(engine)
    assert engine._process.pid != old_pid
    assert engine.invoke({})["audio"] == "synthetic-valid-audio"


def test_success_reuses_the_loaded_model_and_rejects_overlapping_requests(engine):
    pid = engine.details["pid"]
    assert engine.invoke({})["pid"] == pid
    assert engine.invoke({})["pid"] == pid
    outcomes = []
    thread = threading.Thread(target=lambda: outcomes.append(engine.invoke({"delay": 0.1})))
    thread.start()
    until = time.monotonic() + 1
    while not engine._request.locked() and time.monotonic() < until:
        time.sleep(0.001)
    with pytest.raises(BlockingIOError, match="one request at a time"):
        engine.invoke({})
    thread.join(timeout=2)
    assert outcomes[0]["pid"] == pid


@pytest.mark.parametrize("mode", ["crash", "oversized"])
def test_dead_or_invalid_worker_restarts_without_returning_an_audio_response(engine, mode):
    old_pid = engine.details["pid"]
    with pytest.raises(RuntimeError, match="stopped unexpectedly"):
        engine.invoke({"mode": mode})
    wait_ready(engine)
    assert engine.details["pid"] != old_pid
    assert engine.invoke({})["audio"] == "synthetic-valid-audio"


def test_startup_is_bounded_and_close_does_not_wait_for_native_loading():
    worker = BoundedWorker(never_ready, deadline=0.1, startup_timeout=5)
    thread = threading.Thread(target=worker.start)
    thread.start()
    time.sleep(0.05)
    started = time.monotonic()
    worker.close()
    thread.join(timeout=1)
    assert time.monotonic() - started < 2 and not worker.ready
    assert worker._process is None


def test_request_and_configuration_limits(engine):
    with pytest.raises(ValueError, match="size limit"):
        engine.invoke({"text": "x" * 8193})
    assert engine.invoke({})["audio"]
    for deadline in (0, 56, float("nan"), float("inf")):
        with pytest.raises(ValueError):
            BoundedWorker(model_double, deadline=deadline)
