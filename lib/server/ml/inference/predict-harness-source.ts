
export const PREDICT_HARNESS_FILENAME = "acf_predict_harness.py";

export const predictHarnessSource = `import json
import os
import sys
import time
import inspect
import threading
import traceback
import importlib.util
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

# Any library/user print() must not corrupt the NDJSON control stream: route everything except our protocol
# emits to stderr, and keep a private handle to the real stdout for the protocol.
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr
_NL = chr(10)
# predict() runs in a worker thread (for the per-request timeout) and may stream tokens while the main thread
# is blocked on future.result; serialize all protocol writes so lines never interleave.
_EMIT_LOCK = threading.Lock()

def _emit(obj):
    with _EMIT_LOCK:
        _REAL_STDOUT.write(json.dumps(obj) + _NL)
        _REAL_STDOUT.flush()

INFERENCE_DIR = os.path.realpath(os.environ.get("ACF_INFERENCE_DIR") or os.getcwd())
ENTRYPOINT = os.environ.get("ACF_PREDICT_ENTRYPOINT") or "predict.py"
DEVICE = os.environ.get("ACF_DEVICE") or "cpu"
try:
    TIMEOUT_S = float(os.environ.get("ACF_INFERENCE_TIMEOUT_S") or "120")
except Exception:
    TIMEOUT_S = 120.0

def _abs_inference(rel):
    target = os.path.realpath(os.path.join(INFERENCE_DIR, rel))
    if target != INFERENCE_DIR and not target.startswith(INFERENCE_DIR + os.sep):
        raise ValueError("path escapes the inference sandbox: " + str(rel))
    return target

def _resolve_files(value, depth=0):
    if depth > 12:
        return value
    if isinstance(value, dict):
        ref = value.get("$file")
        if isinstance(ref, str):
            return _abs_inference(ref)
        return {k: _resolve_files(v, depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_files(v, depth + 1) for v in value]
    return value

class Ctx:
    def __init__(self, request_id, device, handle=None):
        self.request_id = request_id
        self.device = device
        # The object load() returned (or None when predict.py has no load()). Exposed so a 3-arg
        # predict(inputs, options, ctx) can still reach the warm model via ctx.handle, in addition to the
        # 4-arg predict(inputs, options, ctx, handle) form. ctx is NEVER the handle itself.
        self.handle = handle
        self._out_dir = None
    def read_file(self, ref):
        if isinstance(ref, dict) and isinstance(ref.get("$file"), str):
            return _abs_inference(ref["$file"])
        if isinstance(ref, str):
            return ref if os.path.isabs(ref) else _abs_inference(ref)
        raise ValueError("unsupported file reference")
    def emit_token(self, text):
        # Stream an incremental piece of the output (e.g. a generated token) to the client. Optional: a model
        # that does not stream simply never calls this and returns its full result instead.
        if text is None:
            return
        _emit({"type": "token", "id": self.request_id, "text": str(text)})
    def _outputs_dir(self):
        if self._out_dir is None:
            self._out_dir = _abs_inference(os.path.join("outputs", self.request_id))
            os.makedirs(self._out_dir, exist_ok=True)
        return self._out_dir
    def write_file(self, name, data, mime=None):
        safe = os.path.basename(str(name)) or "output.bin"
        target = os.path.join(self._outputs_dir(), safe)
        mode = "wb" if isinstance(data, (bytes, bytearray)) else "w"
        with open(target, mode) as fh:
            fh.write(data)
        rel = os.path.relpath(target, INFERENCE_DIR).replace(os.sep, "/")
        ref = {"$file": rel}
        if mime:
            ref["mime"] = str(mime)
        return ref

def _load_module():
    entry = ENTRYPOINT if os.path.isabs(ENTRYPOINT) else os.path.join(os.getcwd(), ENTRYPOINT)
    if not os.path.exists(entry):
        raise FileNotFoundError("predict entrypoint not found: " + str(ENTRYPOINT))
    # The harness lives in .orchestrator/inference/, so sys.path[0] is that dir, not the workspace root.
    # Put the workspace root and the entrypoint's directory on sys.path so predict.py can import sibling
    # modules (e.g. "from model import ...") exactly as "python train.py" would.
    for candidate in (os.getcwd(), os.path.dirname(entry)):
        if candidate and candidate not in sys.path:
            sys.path.insert(0, candidate)
    spec = importlib.util.spec_from_file_location("acf_user_predict", entry)
    if spec is None or spec.loader is None:
        raise ImportError("could not load predict entrypoint: " + str(ENTRYPOINT))
    module = importlib.util.module_from_spec(spec)
    sys.modules["acf_user_predict"] = module
    spec.loader.exec_module(module)
    return module

def main():
    try:
        module = _load_module()
    except Exception as exc:
        _emit({"type": "error", "phase": "import", "message": str(exc), "traceback": traceback.format_exc()})
        return 2
    contract = getattr(module, "CONTRACT", None)
    if not isinstance(contract, dict):
        _emit({"type": "error", "phase": "contract", "message": "predict.py must define a CONTRACT dict"})
        return 2
    predict_fn = getattr(module, "predict", None)
    if not callable(predict_fn):
        _emit({"type": "error", "phase": "contract", "message": "predict.py must define predict(inputs, options, ctx)"})
        return 2
    handle = None
    load_fn = getattr(module, "load", None)
    try:
        if callable(load_fn):
            handle = load_fn()
    except Exception as exc:
        _emit({"type": "error", "phase": "load", "message": str(exc), "traceback": traceback.format_exc()})
        return 3

    try:
        accepts_handle = len(inspect.signature(predict_fn).parameters) >= 4
    except (ValueError, TypeError):
        accepts_handle = False

    _emit({"type": "ready", "contract": contract, "device": DEVICE})

    executor = ThreadPoolExecutor(max_workers=1)

    def run_one(inputs, options, ctx):
        if accepts_handle:
            return predict_fn(inputs, options, ctx, handle)
        return predict_fn(inputs, options, ctx)

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            _emit({"type": "error", "id": None, "message": "invalid JSON request: " + str(exc)})
            continue
        rtype = req.get("type")
        rid = req.get("id")
        if rtype == "shutdown":
            break
        if rtype == "ping":
            _emit({"type": "pong", "id": rid})
            continue
        if rtype != "predict":
            _emit({"type": "error", "id": rid, "message": "unknown request type: " + str(rtype)})
            continue
        try:
            inputs = _resolve_files(req.get("inputs") if req.get("inputs") is not None else {})
        except Exception as exc:
            _emit({"type": "error", "id": rid, "message": str(exc)})
            continue
        options = req.get("options") or {}
        ctx = Ctx(str(rid), DEVICE, handle)
        started = time.time()
        future = executor.submit(run_one, inputs, options, ctx)
        try:
            outputs = future.result(timeout=TIMEOUT_S)
        except FutureTimeout:
            _emit({"type": "error", "id": rid, "message": "prediction timed out after " + str(int(TIMEOUT_S)) + "s"})
            _REAL_STDOUT.flush()
            # A hung prediction holds the single worker thread; exit hard so the orchestrator restarts cleanly.
            os._exit(4)
        except Exception as exc:
            _emit({"type": "error", "id": rid, "message": str(exc), "traceback": traceback.format_exc()})
            continue
        elapsed_ms = int((time.time() - started) * 1000)
        if not isinstance(outputs, (dict, list)):
            outputs = {"value": outputs}
        _emit({"type": "result", "id": rid, "outputs": outputs, "timing_ms": elapsed_ms})
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;
