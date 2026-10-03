"""SageMaker serving contract for NVIDIA Magpie TTS on CPU through NeMo-Speech.cpp's C ABI.

GET /ping is healthy only after every pinned file verified and the model loaded.
POST /invocations accepts {"text": ..., "speaker": "jason"} and returns JSON with a
base64 16-bit mono 22,050 Hz WAV and the runtime's own timings. One request runs at a
time; each has a hard deadline and an audio-length cap. Standard library only.
"""
from __future__ import annotations

import array
import base64
import ctypes as C
import hashlib
import io
import json
import os
import resource
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from worker import BoundedWorker

BUNDLE = json.loads(Path(os.environ.get("EDDIE_SPEECH_BUNDLE", "/opt/eddie-speech/magpie-v2607.json")).read_text())
MODEL_DIR = Path(os.environ.get("EDDIE_SPEECH_MODEL_DIR", "/opt/ml/model"))
RUNTIME = Path(os.environ.get("EDDIE_SPEECH_RUNTIME", "/opt/magpie-runtime/lib/libnemo_speech_tts.so"))
SAMPLE_RATE = BUNDLE["sampleRateHz"]
MAX_TEXT = 200
MAX_AUDIO_SECONDS = 60
DEADLINE_SECONDS = float(os.environ.get("EDDIE_SPEECH_DEADLINE_SECONDS", "55"))
_PCM_CALLBACK = C.CFUNCTYPE(C.c_bool, C.POINTER(C.c_uint8), C.c_size_t, C.c_void_p)
_LOCK = threading.Lock()
_STATE: dict = {"ready": False, "error": None}


class ModelConfig(C.Structure):
    _fields_ = [("size", C.c_size_t), ("magpie_model", C.c_char_p),
                ("codec_model", C.c_char_p), ("tokenizer_model_dir", C.c_char_p),
                ("text_normalizer_model_dir", C.c_char_p)]


class RuntimeConfig(C.Structure):
    _fields_ = [("size", C.c_size_t)] + [(key, C.c_int32) for key in (
        "speaker", "threads", "codec_threads", "seed", "steps", "top_k", "chunk_frames",
        "codec_queue_depth", "codec_history_frames", "codec_future_frames", "window_ms"
    )] + [("temperature", C.c_float), ("override_temperature", C.c_bool),
         ("cfg_scale", C.c_float), ("override_cfg_scale", C.c_bool)] + [
        (key, C.c_bool) for key in ("use_cfg", "use_local_transformer", "use_kv_cache",
                                   "use_stateful_codec", "codec_cpu", "flush_partial_chunk", "verbose")
    ] + [(key, C.c_int) for key in ("lt_backend", "sampling_backend", "uma_mode", "longform_mode")
    ] + [("lt_fp32", C.c_bool)]


class SynthesizerConfig(C.Structure):
    _fields_ = [("size", C.c_size_t), ("model", C.POINTER(ModelConfig)),
                ("runtime", C.POINTER(RuntimeConfig)), ("default_language_code", C.c_char_p),
                ("default_voice_name", C.c_char_p)]


class SynthesisOptions(C.Structure):
    _fields_ = [("size", C.c_size_t), ("request_id", C.c_char_p), ("language_code", C.c_char_p)] + [
        (key, C.c_int32) for key in ("speaker", "seed", "steps", "top_k")
    ] + [("temperature", C.c_float), ("override_temperature", C.c_bool),
         ("cfg_scale", C.c_float), ("override_cfg_scale", C.c_bool),
         ("voice_name", C.c_char_p), ("output_sample_rate", C.c_int32)]


class SynthesisStats(C.Structure):
    _fields_ = [("size", C.c_size_t)] + [(key, C.c_int32) for key in (
        "sample_rate", "generated_frames", "chunks", "e2e_chunks")
    ] + [("samples_written", C.c_uint64)] + [(key, C.c_double) for key in (
        "tokenizer_ms", "encoder_ms", "audio_s", "elapsed_s", "rtf", "rtfx", "ttfa_ms",
        "icl_avg_ms", "icl_min_ms", "icl_max_ms", "decoder_audio_s", "decoder_elapsed_s",
        "decoder_rtfx", "decoder_ttft_ms", "decoder_itl_avg_ms", "decoder_itl_min_ms",
        "decoder_itl_max_ms", "decoder_itl_p95_ms", "decoder_itl_p99_ms", "codec_audio_s",
        "codec_elapsed_s", "codec_rtfx", "codec_ttfa_ms", "codec_icl_avg_ms", "codec_icl_min_ms",
        "codec_icl_max_ms", "codec_icl_p95_ms", "codec_icl_p99_ms", "e2e_ttfa_ms",
        "e2e_icl_avg_ms", "e2e_icl_min_ms", "e2e_icl_max_ms", "e2e_icl_p95_ms",
        "e2e_icl_p99_ms", "e2e_rtfx")]


def cpu_limit() -> int:
    """vCPUs actually granted: a container quota, else the scheduler's CPU set."""
    count = len(os.sched_getaffinity(0))
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            count = min(count, max(1, int(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return max(1, min(16, count))


def peak_rss_mib() -> float:
    # Linux reports ru_maxrss in KiB.
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)


def verify_bundle() -> None:
    """Refuse to load anything that differs from the reviewed bundle."""
    for item in BUNDLE["files"]:
        path = MODEL_DIR / item["name"]
        if path.is_symlink() or not path.is_file() or path.stat().st_size != item["size"]:
            raise RuntimeError(f"Model file missing or incomplete: {item['name']}")
        with path.open("rb") as file:
            if hashlib.file_digest(file, "sha256").hexdigest() != item["sha256"]:
                raise RuntimeError(f"Model file failed verification: {item['name']}")


def load_library():
    lib = C.CDLL(str(RUNTIME))
    for name, result in (("runtime_config_default", RuntimeConfig),
                         ("synthesis_options_default", SynthesisOptions),
                         ("synthesis_stats_default", SynthesisStats)):
        fn = getattr(lib, "nemo_speech_tts_" + name)
        fn.argtypes, fn.restype = [], result
    lib.nemo_speech_tts_create.argtypes = [C.POINTER(SynthesizerConfig), C.POINTER(C.c_void_p)]
    lib.nemo_speech_tts_create.restype = C.c_int
    lib.nemo_speech_tts_destroy.argtypes, lib.nemo_speech_tts_destroy.restype = [C.c_void_p], None
    for name in ("sample_rate", "speaker_count"):
        fn = getattr(lib, "nemo_speech_tts_" + name)
        fn.argtypes, fn.restype = [C.c_void_p], C.c_int32
    lib.nemo_speech_tts_synthesize_text.argtypes = [
        C.c_void_p, C.POINTER(SynthesisOptions), C.c_char_p, _PCM_CALLBACK, C.c_void_p,
        C.POINTER(SynthesisStats)]
    lib.nemo_speech_tts_synthesize_text.restype = C.c_int
    for name in ("last_error", "version"):
        fn = getattr(lib, "nemo_speech_tts_" + name)
        fn.argtypes, fn.restype = [], C.c_char_p
    return lib


def load() -> None:
    started = time.monotonic()
    verify_bundle()
    verified = time.monotonic()
    lib = load_library()
    if lib.nemo_speech_tts_version().decode() != BUNDLE["runtime"]["reportedVersion"]:
        raise RuntimeError("The native runtime version does not match the reviewed recipe.")
    by_role = {item["role"]: item["name"] for item in BUNDLE["files"] if item["role"] != "tokenizer"}
    paths = [str(MODEL_DIR / name).encode() for name in (by_role["tts"], by_role["codec"], "tokenizer")]
    model = ModelConfig(C.sizeof(ModelConfig), *paths, None)
    config = lib.nemo_speech_tts_runtime_config_default()
    # Generation and the codec each run a busy-waiting thread pool. Together they
    # must not exceed the vCPUs: 4 + 4 threads on 4 vCPUs made a one-second
    # sentence take over 20 seconds. Split the CPUs between the two pools.
    total = cpu_limit()
    codec = int(os.environ.get("EDDIE_SPEECH_CODEC_THREADS", "0")) or max(1, total // 2)
    threads = int(os.environ.get("EDDIE_SPEECH_THREADS", "0")) or max(1, total - codec)
    config.threads, config.codec_threads = threads, codec
    config.seed, config.steps = 9023, 2048
    config.codec_cpu, config.verbose = True, False
    config.lt_backend, config.sampling_backend, config.uma_mode, config.longform_mode = 1, 1, 1, 0
    settings = SynthesizerConfig(C.sizeof(SynthesizerConfig), C.pointer(model),
                                 C.pointer(config), b"en-US", None)
    handle = C.c_void_p()
    if lib.nemo_speech_tts_create(C.byref(settings), C.byref(handle)):
        raise RuntimeError("Magpie could not load: " + lib.nemo_speech_tts_last_error().decode(errors="replace")[:300])
    if lib.nemo_speech_tts_sample_rate(handle) != SAMPLE_RATE or \
            lib.nemo_speech_tts_speaker_count(handle) != len(BUNDLE["speakers"]):
        lib.nemo_speech_tts_destroy(handle)
        raise RuntimeError("Magpie reported an unexpected sample rate or speaker catalog.")
    _STATE.update(lib=lib, handle=handle, threads=threads, codecThreads=codec, ready=True,
                  verifySeconds=round(verified - started, 2),
                  loadSeconds=round(time.monotonic() - verified, 2))


def _synthesize_native(text: str, speaker: str) -> dict:
    if speaker not in BUNDLE["speakers"]:
        raise ValueError("Choose a listed Magpie preset speaker.")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise ValueError(f"Supply 1-{MAX_TEXT} characters of text.")
    if not _LOCK.acquire(blocking=False):
        raise BlockingIOError("This trial runs one request at a time; retry when the current one finishes.")
    try:
        lib, handle = _STATE["lib"], _STATE["handle"]
        options = lib.nemo_speech_tts_synthesis_options_default()
        options.speaker = BUNDLE["speakers"][speaker]
        options.language_code, options.seed, options.steps = b"en-US", 9023, 2048
        stats = lib.nemo_speech_tts_synthesis_stats_default()
        pcm = bytearray()
        stopped = {"reason": None}
        deadline = time.monotonic() + DEADLINE_SECONDS

        @_PCM_CALLBACK
        def receive(data, size, _user):
            if size % 2 or len(pcm) + size > SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS:
                stopped["reason"] = "audio length limit"
                return False
            if time.monotonic() > deadline:
                stopped["reason"] = "deadline"
                return False
            pcm.extend(C.string_at(data, size))
            return True

        started = time.monotonic()
        status = lib.nemo_speech_tts_synthesize_text(
            handle, C.byref(options), text.encode("utf-8"), receive, None, C.byref(stats))
        wall = time.monotonic() - started
        if time.monotonic() >= deadline:
            stopped["reason"] = "deadline"
        if stopped["reason"]:
            raise RuntimeError(f"Stopped at the {stopped['reason']}; no partial audio is returned.")
        if status:
            raise RuntimeError("Magpie did not finish: " + lib.nemo_speech_tts_last_error().decode(errors="replace")[:300])
        if len(pcm) < SAMPLE_RATE // 5 or stats.samples_written * 2 != len(pcm):
            raise RuntimeError("Magpie returned incomplete or empty audio.")
        samples = array.array("h", pcm)
        if sys.byteorder != "little":
            samples.byteswap()
        peak = max(abs(value) for value in samples)
        if peak < 128:
            raise RuntimeError("Magpie returned silent audio.")
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm)
        audio = output.getvalue()
        return {
            "audio": base64.b64encode(audio).decode(), "format": "audio/wav",
            "sampleRateHz": SAMPLE_RATE, "channels": 1, "bitsPerSample": 16,
            "audioSeconds": round(len(pcm) / 2 / SAMPLE_RATE, 3),
            "synthesisSeconds": round(stats.elapsed_s, 3), "wallSeconds": round(wall, 3),
            "generatedFrames": stats.generated_frames, "peakSample": peak,
            "audioSha256": hashlib.sha256(audio).hexdigest(),
            "textSha256": hashlib.sha256(text.encode()).hexdigest(),
            "speaker": speaker, "threads": _STATE["threads"], "codecThreads": _STATE["codecThreads"],
            "peakRssMiB": peak_rss_mib(),
            "modelLoadSeconds": _STATE["loadSeconds"], "verifySeconds": _STATE["verifySeconds"],
            "bundle": BUNDLE["id"], "runtimeRevision": BUNDLE["runtime"]["revision"],
        }
    finally:
        _LOCK.release()


def _model_process(connection) -> None:
    """Load once in the child. Only the HTTP parent owns the deadline watchdog."""
    try:
        load()
        details = {k: _STATE[k] for k in ("threads", "codecThreads", "verifySeconds", "loadSeconds")}
        connection.send_bytes(json.dumps({"status": "ready", "details": details}).encode())
        while True:
            request = json.loads(connection.recv_bytes(8192))
            try:
                result = _synthesize_native(request["text"], request["speaker"])
                message = {"ok": True, "result": result}
            except (RuntimeError, ValueError, TypeError):
                message = {"ok": False}
            connection.send_bytes(json.dumps(message).encode())
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


_ENGINE = BoundedWorker(_model_process, deadline=DEADLINE_SECONDS)


def synthesize(text: str, speaker: str) -> dict:
    if not isinstance(speaker, str) or speaker not in BUNDLE["speakers"]:
        raise ValueError("Choose a listed Magpie preset speaker.")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise ValueError(f"Supply 1-{MAX_TEXT} characters of text.")
    return _ENGINE.invoke({"text": text, "speaker": speaker})


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802 - SageMaker contract
        if self.path != "/ping":
            return self._send(404, {"error": "not found"})
        if _ENGINE.ready:
            return self._send(200, {"status": "ready"})
        return self._send(503, {"status": "loading" if not _ENGINE.error else "failed"})

    def do_POST(self):  # noqa: N802 - SageMaker contract
        if self.path != "/invocations":
            return self._send(404, {"error": "not found"})
        if not _ENGINE.ready:
            return self._send(503, {"error": "The model is not loaded."})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._send(400, {"error": "Supply a valid Content-Length."})
        if not 0 < length <= 8192:
            return self._send(413, {"error": "Request body must be 1-8192 bytes."})
        try:
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ValueError("Send a JSON object.")
            self._send(200, synthesize(request.get("text"), request.get("speaker", "jason")))
        except BlockingIOError as error:
            self._send(429, {"error": str(error)})
        except TimeoutError as error:
            self._send(504, {"error": str(error)})
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self._send(400, {"error": str(error)})
        except RuntimeError as error:
            self._send(500, {"error": str(error)})

    def log_message(self, fmt, *args):  # Text and audio are never logged.
        sys.stderr.write("%s %s\n" % (self.command, self.path))


def main() -> None:
    def background():
        _ENGINE.start()
        print(json.dumps({"event": "loaded" if _ENGINE.ready else "load-failed",
                          **_ENGINE.details}), flush=True)

    threading.Thread(target=background, daemon=True).start()
    try:
        # Required container port; SageMaker reaches it through authenticated InvokeEndpoint.
        ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()  # nosec B104
    finally:
        _ENGINE.close()


if __name__ == "__main__":
    main()
