"""One local model process with a wall-clock deadline.

The HTTP process stays responsive while native inference runs in a spawned child.
A watchdog kills that child on expiry, including work that never calls back into
Python. Only bounded JSON bytes cross the private pipe; no request is unpickled
and no shell command is constructed. Model files remain outside this image.
"""
from __future__ import annotations

import json
import math
import multiprocessing
import threading
import time
from typing import Callable

MAX_REPLY = 4 * 1024 * 1024


class BoundedWorker:
    def __init__(self, target: Callable, *, deadline: float = 55, startup_timeout: float = 300):
        if not math.isfinite(deadline) or not 0 < deadline <= 55:
            raise ValueError("The inference deadline must be between 0 and 55 seconds.")
        if not math.isfinite(startup_timeout) or not 0 < startup_timeout <= 300:
            raise ValueError("The startup limit must be between 0 and 300 seconds.")
        self.target = target
        self.deadline = deadline
        self.startup_timeout = startup_timeout
        self.ready = False
        self.error: str | None = None
        self.details: dict = {}
        self._process = None
        self._connection = None
        self._closed = False
        self._request = threading.Lock()
        self._lifecycle = threading.Lock()

    def _retire(self) -> bool:
        self.ready = False
        self.details = {}
        process, connection = self._process, self._connection
        if connection is not None:
            connection.close()
            self._connection = None
        if process is not None:
            if process.pid is not None:
                if process.is_alive():
                    process.kill()
                process.join(timeout=1)
                if process.is_alive():
                    # Do not start a second model while an old worker still owns
                    # memory or CPU. Keep its handle so shutdown can retry.
                    self.error = "The previous model worker has not stopped."
                    return False
            process.close()
            self._process = None
        return True

    def start(self) -> None:
        with self._lifecycle:
            if self._closed or self.ready:
                return
            if not self._retire():
                return
            context = multiprocessing.get_context("spawn")
            parent, child = context.Pipe(duplex=True)
            process = context.Process(target=self.target, args=(child,), daemon=True)
            self._process, self._connection = process, parent
            try:
                process.start()
                child.close()
                until = time.monotonic() + self.startup_timeout
                while not parent.poll(min(0.1, max(0, until - time.monotonic()))):
                    if self._closed or time.monotonic() >= until:
                        raise RuntimeError("The model did not become ready within the startup limit.")
                message = json.loads(parent.recv_bytes(8192))
                if (self._closed or not isinstance(message, dict) or message.get("status") != "ready"
                        or not isinstance(message.get("details", {}), dict)):
                    raise RuntimeError("The model worker failed to load the verified bundle.")
                self.details = message.get("details", {})
                self.error, self.ready = None, True
            except Exception:
                child.close()
                self.error = "The model worker could not start."
                self._retire()

    def close(self) -> None:
        self._closed = True
        with self._request, self._lifecycle:
            self._retire()

    def invoke(self, request: dict) -> dict:
        raw = json.dumps(request).encode()
        if len(raw) > 8192:
            raise ValueError("The inference request exceeds its size limit.")
        if not self._request.acquire(blocking=False):
            raise BlockingIOError("This trial runs one request at a time; retry when it finishes.")
        restart = False
        try:
            if not self.ready or self._closed:
                raise RuntimeError("The model is loading. Retry after it becomes ready.")
            process, connection = self._process, self._connection
            expired = threading.Event()
            finished = threading.Event()
            completion = threading.Lock()
            deadline = time.monotonic() + self.deadline

            def stop_native_work():
                with completion:
                    if finished.is_set():
                        return
                    expired.set()
                    try:
                        process.kill()
                    except (OSError, ValueError):
                        pass  # It may already have exited.

            watchdog = threading.Timer(self.deadline, stop_native_work)
            watchdog.daemon = True
            watchdog.start()
            try:
                connection.send_bytes(raw)
                if not connection.poll(max(0, deadline - time.monotonic())):
                    stop_native_work()
                    raise TimeoutError
                # The watchdog also terminates a child that stalls during a reply.
                message = json.loads(connection.recv_bytes(MAX_REPLY))
                with completion:
                    if expired.is_set() or time.monotonic() >= deadline:
                        expired.set()
                        raise TimeoutError
                    finished.set()
                if not isinstance(message, dict) or message.get("ok") is not True:
                    restart = True
                    raise RuntimeError("The model did not complete the request. Its worker is restarting.")
                result = message.get("result")
                if not isinstance(result, dict):
                    restart = True
                    raise RuntimeError("The model returned an invalid response.")
                return result
            except (EOFError, OSError, ValueError) as error:
                restart = True
                if expired.is_set() or time.monotonic() >= deadline:
                    raise TimeoutError("The inference deadline was reached. The worker was stopped; no audio is returned.") from error
                raise RuntimeError("The model worker stopped unexpectedly. It is restarting.") from error
            finally:
                with completion:
                    finished.set()
                watchdog.cancel()
                restart = restart or expired.is_set() or not process.is_alive()
        finally:
            if restart:
                with self._lifecycle:
                    stopped = self._retire()
                if stopped and not self._closed:
                    threading.Thread(target=self.start, daemon=True).start()
            self._request.release()
