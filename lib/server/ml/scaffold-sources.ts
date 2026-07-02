import type { InferenceContract } from "@/lib/shared/inference-contract";
import type { MlDataContract } from "@/lib/shared/types";

export interface MlScaffoldFile {
  path: string;
  content: string;
}

export interface MlScaffoldCapabilities {
  torchAvailable: boolean;
}

export interface MlScaffoldPredict {
  entrypoint: string;
  contract: InferenceContract;
}

export interface MlScaffold {
  kind: string;
  entrypoint: string;
  metrics: string | null;
  summary: string | null;
  requirements: string;
  readme: string;
  files: MlScaffoldFile[];
  degradedFrom: string | null;
  /** Optional bundled inference surface (predict.py + a static contract). Absent for non-model scaffolds. */
  predict?: MlScaffoldPredict | null;
  /** How best to train this model (data regime/format + guidance), surfaced to the user in-app. */
  data: MlDataContract;
}

const DATA_CONTRACTS: Record<string, MlDataContract> = {
  "inference-eval": {
    recommendedMode: "single_corpus",
    supportedModes: ["builtin", "single_corpus", "train_val_test"],
    format: "text",
    accept: ".txt,.md,.text",
    builtinFallback: true,
    guidance:
      "Provide one plain-text corpus (a .txt of natural language). The model tokenizes it, holds out a validation slice, and packs training sequences internally. For a separate held-out test score, choose train+val+test and supply individual files. With no corpus it trains on a small built-in sample.",
  },
  "classical-ml": {
    recommendedMode: "train_test",
    supportedModes: ["builtin", "train_test", "train_val_test", "custom"],
    format: "csv",
    accept: ".csv",
    builtinFallback: true,
    guidance:
      "Provide a CSV with feature columns plus a label column. Supply a training CSV (and optionally a test CSV), or use the built-in demo dataset. Encoding and the train/test split happen internally.",
  },
  "eval-harness": {
    recommendedMode: "train_test",
    supportedModes: ["builtin", "train_test", "custom"],
    format: "csv",
    accept: ".csv",
    builtinFallback: true,
    guidance:
      "Provide a labeled CSV to score against the baseline ladder with a leakage check, or use the built-in dataset. The held-out split is made internally.",
  },
  numerical: {
    recommendedMode: "builtin",
    supportedModes: ["builtin"],
    format: "other",
    accept: null,
    builtinFallback: true,
    guidance: "This experiment generates its own data internally; no corpus is required.",
  },
  "peft-finetune": {
    recommendedMode: "jsonl_finetune",
    supportedModes: ["builtin", "jsonl_finetune"],
    format: "jsonl",
    accept: ".jsonl",
    builtinFallback: true,
    guidance:
      "Provide a JSONL file of fine-tuning examples (prompt/completion or messages records). Tokenization and assistant-only masking happen internally. With no file it uses a built-in sample.",
  },
  distillation: {
    recommendedMode: "builtin",
    supportedModes: ["builtin", "train_test"],
    format: "auto",
    accept: ".csv,.jsonl",
    builtinFallback: true,
    guidance:
      "Trains a teacher and distills a smaller student. It uses built-in/synthetic data by default; optionally provide a labeled dataset to distill on.",
  },
  "quantized-inference": {
    recommendedMode: "builtin",
    supportedModes: ["builtin"],
    format: "auto",
    accept: null,
    builtinFallback: true,
    guidance: "Quantizes a model and reports fidelity and throughput on built-in/synthetic data; no corpus is required.",
  },
  trm: {
    recommendedMode: "builtin",
    supportedModes: ["builtin"],
    format: "other",
    accept: null,
    builtinFallback: true,
    guidance: "Generates its own grid-puzzle tasks for exact-match evaluation; no corpus is required.",
  },
};

const DEFAULT_DATA_CONTRACT: MlDataContract = {
  recommendedMode: "builtin",
  supportedModes: ["builtin", "single_corpus", "custom"],
  format: "auto",
  accept: null,
  builtinFallback: true,
  guidance: "Provide a dataset for this experiment, or use the built-in data. All preparation happens internally at run time.",
};

function dataContractFor(kind: string): MlDataContract {
  return DATA_CONTRACTS[kind] ?? DEFAULT_DATA_CONTRACT;
}

export const ML_GITIGNORE = `__pycache__
.venv
*.pyc
.env
.orchestrator/
checkpoints/
*.joblib
*.pkl
*.pt
*.safetensors
*.gguf
*.onnx
mlruns/
.ml-cache/
data/
`;

const CLASSICAL_ML_TRAIN = `import argparse
import json
import os
import time


def load_run_config():
    config_path = os.environ.get("EXPERIMENT_CONFIG", "")
    if not config_path:
        candidate = os.path.join(".orchestrator", "experiment", "run_config.json")
        if os.path.exists(candidate):
            config_path = candidate
    if config_path and os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:
            return {}
    return {}


def cfg_int(cfg, key, default):
    value = cfg.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def write_lines(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + chr(10))


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def append_metric(path, payload):
    # Stream one metric row as it is produced (append + flush) so the live training chart updates during the
    # run; never buffer all rows and write once at the end. Returns the row so callers can also keep it.
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + chr(10))
        handle.flush()
    return payload


def main():
    parser = argparse.ArgumentParser(description="Classical ML experiment")
    parser.add_argument("--smoke", action="store_true", help="Fast deterministic pipeline check")
    args = parser.parse_args()

    cfg = load_run_config()
    seed = cfg_int(cfg, "seed", 42)
    subset = cfg_int(cfg, "subsetLimit", 0)

    import numpy as np
    from sklearn.datasets import load_iris
    from sklearn.model_selection import train_test_split, cross_val_score
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.dummy import DummyClassifier
    from sklearn.metrics import accuracy_score
    import joblib

    np.random.seed(seed)
    dataset = load_iris()
    features, target = dataset.data, dataset.target
    if subset > 0:
        features, target = features[:subset], target[:subset]

    if args.smoke:
        checks = []
        primary_value = 0.0
        passed_all = True

        def record(name, ok, detail):
            checks.append({"name": name, "passed": bool(ok), "detail": detail})

        try:
            sx, sy = features[:30], target[:30]
            model = RandomForestClassifier(n_estimators=8, random_state=seed)
            model.fit(sx, sy)
            preds = model.predict(sx)
            record("fit_predict", True, "model fit and produced predictions")

            primary_value = float(accuracy_score(sy, preds))
            record("metric_computes", primary_value >= 0.0, "train accuracy " + format(primary_value, ".3f"))

            os.makedirs("checkpoints", exist_ok=True)
            checkpoint_path = os.path.join("checkpoints", "smoke.joblib")
            joblib.dump(model, checkpoint_path)
            reloaded = joblib.load(checkpoint_path)
            roundtrip = bool(np.array_equal(reloaded.predict(sx), preds))
            record("checkpoint_roundtrip", roundtrip, "reloaded predictions identical" if roundtrip else "reloaded predictions diverged")
            passed_all = passed_all and roundtrip

            again = RandomForestClassifier(n_estimators=8, random_state=seed)
            again.fit(sx, sy)
            deterministic = bool(np.array_equal(again.predict(sx), preds))
            record("determinism", deterministic, "same seed reproduces predictions" if deterministic else "nondeterministic output")
            passed_all = passed_all and deterministic

            baseline = DummyClassifier(strategy="most_frequent")
            baseline.fit(sx, sy)
            base_value = float(accuracy_score(sy, baseline.predict(sx)))
            record("baseline_computes", base_value >= 0.0, "baseline accuracy " + format(base_value, ".3f"))
        except Exception as exc:
            record("smoke_exception", False, str(exc))
            passed_all = False

        report = {
            "checks": checks,
            "primary": {"name": "train_accuracy", "value": primary_value, "split": "train"},
            "passed": passed_all,
        }
        write_json("smoke_report.json", report)
        print(json.dumps(report))
        raise SystemExit(0 if passed_all else 1)

    started = time.time()
    rows = []
    open("metrics.jsonl", "w", encoding="utf-8").close()  # truncate; rows stream in via append_metric below
    x_train, x_test, y_train, y_test = train_test_split(
        features, target, test_size=0.25, random_state=seed, stratify=target
    )
    model = RandomForestClassifier(n_estimators=100, random_state=seed)
    fold_scores = cross_val_score(model, x_train, y_train, cv=5)
    for index, score in enumerate(fold_scores):
        rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": index, "split": "val", "name": "cv_accuracy", "value": float(score)}))

    model.fit(x_train, y_train)
    test_accuracy = float(accuracy_score(y_test, model.predict(x_test)))
    rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": len(fold_scores), "split": "test", "name": "accuracy", "value": test_accuracy}))

    baseline = DummyClassifier(strategy="most_frequent")
    baseline.fit(x_train, y_train)
    baseline_accuracy = float(accuracy_score(y_test, baseline.predict(x_test)))

    write_lines("metrics.jsonl", rows)  # idempotent final rewrite (identical content) — self-heals any partial flush

    peak_ram_mb = None
    try:
        import psutil
        peak_ram_mb = round(psutil.Process().memory_info().rss / (1024 * 1024), 1)
    except Exception:
        peak_ram_mb = None

    os.makedirs("checkpoints", exist_ok=True)
    joblib.dump(model, os.path.join("checkpoints", "model.joblib"))

    summary = {
        "primary": {"name": "accuracy", "value": test_accuracy, "split": "test"},
        "baseline": {"name": "accuracy", "value": baseline_accuracy, "split": "test", "strategy": "most_frequent"},
        "cv_mean": float(sum(fold_scores) / len(fold_scores)),
        "objectives": {"wall_s": round(time.time() - started, 3), "peak_ram_mb": peak_ram_mb},
        "seed": seed,
    }
    write_json("metrics.json", summary)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
`;

const NUMERICAL_SIM = `import argparse
import json
import os
import time


def load_run_config():
    config_path = os.environ.get("EXPERIMENT_CONFIG", "")
    if not config_path:
        candidate = os.path.join(".orchestrator", "experiment", "run_config.json")
        if os.path.exists(candidate):
            config_path = candidate
    if config_path and os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:
            return {}
    return {}


def cfg_int(cfg, key, default):
    value = cfg.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def simulate(steps, seed):
    import numpy as np
    rng = np.random.default_rng(seed)
    t = np.linspace(0.0, 10.0, steps)
    signal = np.exp(-0.2 * t) * np.cos(2.0 * t) + 0.05 * rng.standard_normal(steps)
    energy = float(np.sum(signal ** 2))
    return t, signal, energy


def main():
    parser = argparse.ArgumentParser(description="Numerical simulation experiment")
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()

    cfg = load_run_config()
    seed = cfg_int(cfg, "seed", 42)

    if args.smoke:
        checks = []
        passed_all = True
        primary_value = 0.0

        def record(name, ok, detail):
            checks.append({"name": name, "passed": bool(ok), "detail": detail})

        try:
            import numpy as np
            _, signal_a, energy_a = simulate(64, seed)
            record("runs", True, "simulation produced output")
            finite = bool(np.all(np.isfinite(signal_a)))
            record("finite_output", finite, "all values finite" if finite else "non-finite values present")
            passed_all = passed_all and finite
            primary_value = energy_a
            _, _, energy_b = simulate(64, seed)
            deterministic = abs(energy_a - energy_b) < 1e-9
            record("determinism", deterministic, "same seed reproduces energy" if deterministic else "nondeterministic")
            passed_all = passed_all and deterministic
        except Exception as exc:
            record("smoke_exception", False, str(exc))
            passed_all = False

        report = {"checks": checks, "primary": {"name": "energy", "value": primary_value, "split": "n/a"}, "passed": passed_all}
        with open("smoke_report.json", "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
        print(json.dumps(report))
        raise SystemExit(0 if passed_all else 1)

    started = time.time()
    steps = cfg_int(cfg, "subsetLimit", 0) or 500
    t, signal, energy = simulate(steps, seed)

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        plt.figure(figsize=(8, 4))
        plt.plot(t, signal, linewidth=1.2)
        plt.title("Damped oscillation")
        plt.xlabel("time")
        plt.ylabel("amplitude")
        plt.tight_layout()
        plt.savefig("simulation.png", dpi=120)
    except Exception:
        pass

    summary = {
        "primary": {"name": "energy", "value": float(energy), "split": "n/a"},
        "objectives": {"wall_s": round(time.time() - started, 3), "steps": steps},
        "seed": seed,
    }
    with open("metrics.json", "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
`;

const EVAL_HARNESS = `import argparse
import json
import os
import time


def load_run_config():
    config_path = os.environ.get("EXPERIMENT_CONFIG", "")
    if not config_path:
        candidate = os.path.join(".orchestrator", "experiment", "run_config.json")
        if os.path.exists(candidate):
            config_path = candidate
    if config_path and os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:
            return {}
    return {}


def cfg_int(cfg, key, default):
    value = cfg.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def write_lines(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + chr(10))


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def row_hash(values):
    return hash(tuple(round(float(v), 6) for v in values))


def build_baseline_ladder(x_train, y_train, x_test, y_test, seed):
    from sklearn.dummy import DummyClassifier
    from sklearn.metrics import accuracy_score
    ladder = []
    for strategy in ("most_frequent", "stratified", "uniform"):
        clf = DummyClassifier(strategy=strategy, random_state=seed)
        clf.fit(x_train, y_train)
        score = float(accuracy_score(y_test, clf.predict(x_test)))
        ladder.append({"name": strategy, "value": score, "split": "test"})
    return ladder


def leakage_check(x_train, x_test):
    train_hashes = set(row_hash(row) for row in x_train)
    overlap = sum(1 for row in x_test if row_hash(row) in train_hashes)
    return {"overlap_rows": int(overlap), "leaked": bool(overlap > 0)}


def append_metric(path, payload):
    # Stream one metric row as it is produced (append + flush) so the live training chart updates during the
    # run; never buffer all rows and write once at the end. Returns the row so callers can also keep it.
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + chr(10))
        handle.flush()
    return payload


def main():
    parser = argparse.ArgumentParser(description="Evaluation harness with baseline ladder")
    parser.add_argument("--smoke", action="store_true", help="Fast deterministic pipeline check")
    args = parser.parse_args()

    cfg = load_run_config()
    seed = cfg_int(cfg, "seed", 42)
    subset = cfg_int(cfg, "subsetLimit", 0)

    import numpy as np
    from sklearn.datasets import load_iris
    from sklearn.model_selection import train_test_split
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, f1_score

    np.random.seed(seed)
    dataset = load_iris()
    features, target = dataset.data, dataset.target
    if subset > 0:
        features, target = features[:subset], target[:subset]

    if args.smoke:
        checks = []
        passed_all = True
        primary_value = 0.0

        def record(name, ok, detail):
            checks.append({"name": name, "passed": bool(ok), "detail": detail})

        try:
            perm = np.random.RandomState(seed).permutation(len(features))
            sx, sy = features[perm][:60], target[perm][:60]
            xtr, xte, ytr, yte = train_test_split(sx, sy, test_size=0.5, random_state=seed, stratify=sy)
            model = LogisticRegression(max_iter=200)
            model.fit(xtr, ytr)
            preds = model.predict(xte)
            record("fit_predict", True, "model fit and predicted")

            primary_value = float(accuracy_score(yte, preds))
            record("metric_computes", primary_value >= 0.0, "accuracy " + format(primary_value, ".3f"))

            ladder = build_baseline_ladder(xtr, ytr, xte, yte, seed)
            record("baseline_ladder", len(ladder) == 3, "computed " + str(len(ladder)) + " baselines")

            leak = leakage_check(xtr, xte)
            record("leakage_check", not leak["leaked"], "no train/test overlap" if not leak["leaked"] else "overlap detected")
            passed_all = passed_all and (not leak["leaked"])

            again = LogisticRegression(max_iter=200)
            again.fit(xtr, ytr)
            deterministic = bool(np.array_equal(again.predict(xte), preds))
            record("determinism", deterministic, "same seed reproduces predictions" if deterministic else "nondeterministic")
            passed_all = passed_all and deterministic
        except Exception as exc:
            record("smoke_exception", False, str(exc))
            passed_all = False

        report = {
            "checks": checks,
            "primary": {"name": "accuracy", "value": primary_value, "split": "test", "goal": "max"},
            "passed": passed_all,
        }
        write_json("smoke_report.json", report)
        print(json.dumps(report))
        raise SystemExit(0 if passed_all else 1)

    started = time.time()
    x_train, x_test, y_train, y_test = train_test_split(
        features, target, test_size=0.25, random_state=seed, stratify=target
    )
    rows = []
    open("metrics.jsonl", "w", encoding="utf-8").close()  # truncate; rows stream in via append_metric below
    model = LogisticRegression(max_iter=500)

    # A non-iterative classifier has no training steps, so plot val accuracy as a learning curve over
    # training-set size: fit clones on growing subsets and score a held-out val slice. The val slice is
    # carved from train, so the final fit / test / primary / baseline path below is unchanged.
    from sklearn.base import clone
    xc_train, xc_val, yc_train, yc_val = train_test_split(
        x_train, y_train, test_size=0.25, random_state=seed, stratify=y_train
    )
    curve_n = len(xc_train)
    for frac in (0.25, 0.5, 0.75, 1.0):
        take = min(curve_n, max(8, int(curve_n * frac)))
        stage = clone(model)
        stage.fit(xc_train[:take], yc_train[:take])
        stage_acc = float(accuracy_score(yc_val, stage.predict(xc_val)))
        rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": int(frac * 100), "split": "val", "name": "accuracy", "value": stage_acc}))

    model.fit(x_train, y_train)
    preds = model.predict(x_test)
    test_accuracy = float(accuracy_score(y_test, preds))
    test_f1 = float(f1_score(y_test, preds, average="macro"))
    rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": 100, "split": "test", "name": "accuracy", "value": test_accuracy}))
    rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": 100, "split": "test", "name": "f1_macro", "value": test_f1}))

    ladder = build_baseline_ladder(x_train, y_train, x_test, y_test, seed)
    best_baseline = max(ladder, key=lambda item: item["value"])
    leak = leakage_check(x_train, x_test)

    write_lines("metrics.jsonl", rows)  # idempotent final rewrite (identical content) — self-heals any partial flush

    peak_ram_mb = None
    try:
        import psutil
        peak_ram_mb = round(psutil.Process().memory_info().rss / (1024 * 1024), 1)
    except Exception:
        peak_ram_mb = None

    summary = {
        "primary": {"name": "accuracy", "value": test_accuracy, "split": "test", "goal": "max"},
        "baseline": {"name": best_baseline["name"], "value": best_baseline["value"], "split": "test"},
        "baseline_ladder": ladder,
        "secondary": [{"name": "f1_macro", "value": test_f1, "split": "test", "goal": "max"}],
        "leakage": leak,
        "objectives": {"wall_s": round(time.time() - started, 3), "peak_ram_mb": peak_ram_mb},
        "seed": seed,
    }
    write_json("metrics.json", summary)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
`;

const PEFT_FINETUNE = `import argparse
import json
import os
import time


def load_run_config():
    config_path = os.environ.get("EXPERIMENT_CONFIG", "")
    if not config_path:
        candidate = os.path.join(".orchestrator", "experiment", "run_config.json")
        if os.path.exists(candidate):
            config_path = candidate
    if config_path and os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:
            return {}
    return {}


def cfg_int(cfg, key, default):
    value = cfg.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def cfg_float(cfg, key, default):
    value = cfg.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    return default


def write_lines(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + chr(10))


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def build_dataset(torch, n, dim, classes, seed, device):
    generator = torch.Generator().manual_seed(seed)
    centers = torch.randn(classes, dim, generator=generator) * 2.5
    labels = torch.randint(0, classes, (n,), generator=generator)
    features = centers[labels] + torch.randn(n, dim, generator=generator) * 0.6
    # Generate on CPU (deterministic), then move to the run device so model and inputs share a device.
    return features.to(device), labels.to(device)


def build_model(torch, nn, dim, hidden, classes, rank, seed):
    torch.manual_seed(seed)

    class LoraLinear(nn.Module):
        def __init__(self, in_features, out_features, rank, alpha):
            super().__init__()
            self.base = nn.Linear(in_features, out_features)
            for parameter in self.base.parameters():
                parameter.requires_grad = False
            self.lora_a = nn.Parameter(torch.randn(in_features, rank) * 0.02)
            self.lora_b = nn.Parameter(torch.zeros(rank, out_features))
            self.scaling = alpha / rank

        def forward(self, x):
            frozen = self.base(x)
            delta = (x @ self.lora_a) @ self.lora_b
            return frozen + self.scaling * delta

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.backbone = LoraLinear(dim, hidden, rank, rank * 2)
            self.activation = nn.ReLU()
            self.head = nn.Linear(hidden, classes)

        def forward(self, x):
            return self.head(self.activation(self.backbone(x)))

    return Net()


def trainable_parameters(model):
    return [p for p in model.parameters() if p.requires_grad]


def adapter_state(model):
    return {name: tensor for name, tensor in model.state_dict().items() if "lora_" in name or "head" in name}


def append_metric(path, payload):
    # Stream one metric row as it is produced (append + flush) so the live training chart updates during the
    # run; never buffer all rows and write once at the end. Returns the row so callers can also keep it.
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + chr(10))
        handle.flush()
    return payload


def main():
    parser = argparse.ArgumentParser(description="LoRA parameter-efficient fine-tuning on a frozen base")
    parser.add_argument("--smoke", action="store_true", help="Fast deterministic wiring check")
    args = parser.parse_args()

    cfg = load_run_config()
    seed = cfg_int(cfg, "seed", 42)
    lr = cfg_float(cfg, "lr", 0.05)
    epochs = cfg_int(cfg, "epochs", 0) or 120

    import torch
    import torch.nn as nn

    torch.use_deterministic_algorithms(True, warn_only=True)
    # Honor the device the orchestrator granted (ACF_DEVICE); fall back to CPU. Smoke runs pass ACF_DEVICE=cpu.
    requested_device = os.environ.get("ACF_DEVICE", "cpu").strip().lower()
    device = torch.device(requested_device) if requested_device.startswith("cuda") and torch.cuda.is_available() else torch.device("cpu")
    dim, hidden, classes, rank = 16, 32, 3, 4

    if args.smoke:
        checks = []
        passed_all = True
        primary_value = 0.0

        def record(name, ok, detail):
            checks.append({"name": name, "passed": bool(ok), "detail": detail})

        try:
            features, labels = build_dataset(torch, 24, dim, classes, seed, device)
            model = build_model(torch, nn, dim, hidden, classes, rank, seed).to(device)
            loss_fn = nn.CrossEntropyLoss()
            logits = model(features)
            loss0 = loss_fn(logits, labels)
            loss0_value = float(loss0.detach())
            record("forward_finite", bool(torch.isfinite(loss0)), "initial loss " + format(loss0_value, ".4f"))
            passed_all = passed_all and bool(torch.isfinite(loss0))

            loss0.backward()
            grads = [p.grad for p in trainable_parameters(model) if p.grad is not None]
            grads_finite = all(bool(torch.isfinite(g).all()) for g in grads)
            grads_nonzero = any(float(g.abs().sum()) > 0 for g in grads)
            record("backward_grads", grads_finite and grads_nonzero, "trainable grads finite and nonzero")
            passed_all = passed_all and grads_finite and grads_nonzero

            base_frozen = model.backbone.base.weight.grad is None
            record("base_frozen", base_frozen, "frozen base received no gradient" if base_frozen else "base unexpectedly trained")
            passed_all = passed_all and base_frozen

            opt = torch.optim.Adam(trainable_parameters(model), lr=lr)
            for _ in range(80):
                opt.zero_grad()
                loss = loss_fn(model(features), labels)
                loss.backward()
                opt.step()
            final_loss = float(loss_fn(model(features), labels))
            overfit = final_loss < loss0_value * 0.5
            record("overfit_tiny_batch", overfit, "loss " + format(loss0_value, ".3f") + " -> " + format(final_loss, ".3f"))
            passed_all = passed_all and overfit

            with torch.no_grad():
                preds = model(features).argmax(dim=1)
            primary_value = float((preds == labels).float().mean())

            os.makedirs("checkpoints", exist_ok=True)
            ckpt = os.path.join("checkpoints", "adapter_smoke.pt")
            torch.save(adapter_state(model), ckpt)
            reloaded = torch.load(ckpt, weights_only=True)
            model.load_state_dict(reloaded, strict=False)
            with torch.no_grad():
                preds2 = model(features).argmax(dim=1)
            roundtrip = bool(torch.equal(preds, preds2))
            record("checkpoint_roundtrip", roundtrip, "adapter reload identical" if roundtrip else "adapter reload diverged")
            passed_all = passed_all and roundtrip

            model_b = build_model(torch, nn, dim, hidden, classes, rank, seed).to(device)
            opt_b = torch.optim.Adam(trainable_parameters(model_b), lr=lr)
            for _ in range(80):
                opt_b.zero_grad()
                loss_b = loss_fn(model_b(features), labels)
                loss_b.backward()
                opt_b.step()
            deterministic = abs(float(loss_fn(model_b(features), labels)) - final_loss) < 1e-4
            record("determinism", deterministic, "same seed reproduces loss" if deterministic else "nondeterministic")
            passed_all = passed_all and deterministic
        except Exception as exc:
            record("smoke_exception", False, str(exc))
            passed_all = False

        report = {
            "checks": checks,
            "primary": {"name": "train_accuracy", "value": primary_value, "split": "train", "goal": "max"},
            "passed": passed_all,
        }
        write_json("smoke_report.json", report)
        print(json.dumps(report))
        raise SystemExit(0 if passed_all else 1)

    started = time.time()
    features, labels = build_dataset(torch, 256, dim, classes, seed, device)
    # train / val / test slices: val is held out from train so accuracy can be tracked per eval as a curve.
    val_split = 160
    test_split = 192
    x_train, y_train = features[:val_split], labels[:val_split]
    x_val, y_val = features[val_split:test_split], labels[val_split:test_split]
    x_test, y_test = features[test_split:], labels[test_split:]
    model = build_model(torch, nn, dim, hidden, classes, rank, seed).to(device)
    loss_fn = nn.CrossEntropyLoss()
    opt = torch.optim.Adam(trainable_parameters(model), lr=lr)

    rows = []
    open("metrics.jsonl", "w", encoding="utf-8").close()  # truncate; rows stream in via append_metric below
    for epoch in range(epochs):
        opt.zero_grad()
        loss = loss_fn(model(x_train), y_train)
        loss.backward()
        opt.step()
        if epoch % 10 == 0 or epoch == epochs - 1:
            rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": epoch, "split": "train", "name": "loss", "value": float(loss)}))
            with torch.no_grad():
                val_acc = float((model(x_val).argmax(dim=1) == y_val).float().mean())
            rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": epoch, "split": "val", "name": "accuracy", "value": val_acc}))

    with torch.no_grad():
        test_acc = float((model(x_test).argmax(dim=1) == y_test).float().mean())
    rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": epochs, "split": "test", "name": "accuracy", "value": test_acc}))
    write_lines("metrics.jsonl", rows)  # idempotent final rewrite (identical content) — self-heals any partial flush

    total_params = sum(p.numel() for p in model.parameters())
    trainable = sum(p.numel() for p in trainable_parameters(model))

    values, counts = torch.unique(y_train, return_counts=True)
    majority = values[int(counts.argmax())]
    baseline_acc = float((y_test == majority).float().mean())

    os.makedirs("checkpoints", exist_ok=True)
    torch.save(adapter_state(model), os.path.join("checkpoints", "adapter.pt"))

    peak_ram_mb = None
    try:
        import psutil
        peak_ram_mb = round(psutil.Process().memory_info().rss / (1024 * 1024), 1)
    except Exception:
        peak_ram_mb = None

    summary = {
        "primary": {"name": "accuracy", "value": test_acc, "split": "test", "goal": "max"},
        "baseline": {"name": "most_frequent", "value": baseline_acc, "split": "test"},
        "objectives": {
            "wall_s": round(time.time() - started, 3),
            "peak_ram_mb": peak_ram_mb,
            "trainable_params": trainable,
            "total_params": total_params,
            "trainable_ratio": round(trainable / total_params, 5),
        },
        "seed": seed,
        "method": "lora",
    }
    write_json("metrics.json", summary)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
`;

const QUANTIZED_INFERENCE = `import argparse
import json
import os
import time


def load_run_config():
    config_path = os.environ.get("EXPERIMENT_CONFIG", "")
    if not config_path:
        candidate = os.path.join(".orchestrator", "experiment", "run_config.json")
        if os.path.exists(candidate):
            config_path = candidate
    if config_path and os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:
            return {}
    return {}


def cfg_int(cfg, key, default):
    value = cfg.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def write_lines(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + chr(10))


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def build_model(torch, nn, dim, hidden, out, seed):
    torch.manual_seed(seed)
    model = nn.Sequential(nn.Linear(dim, hidden), nn.ReLU(), nn.Linear(hidden, out))
    for parameter in model.parameters():
        parameter.requires_grad = False
    return model


def quantize_int8(torch, tensor):
    max_abs = float(tensor.abs().max())
    if max_abs == 0.0:
        return torch.zeros_like(tensor, dtype=torch.int8), 1.0
    scale = max_abs / 127.0
    quantized = torch.clamp(torch.round(tensor / scale), -127, 127).to(torch.int8)
    return quantized, scale


def dequantize(torch, quantized, scale):
    return quantized.to(torch.float32) * scale


def quantize_model(torch, model):
    packed = {}
    for name, tensor in model.state_dict().items():
        if tensor.dtype.is_floating_point and tensor.dim() == 2:
            quantized, scale = quantize_int8(torch, tensor)
            packed[name] = {"q": quantized, "scale": scale}
        else:
            packed[name] = {"raw": tensor}
    return packed


def load_quantized(torch, model, packed):
    new_state = {}
    for name, tensor in model.state_dict().items():
        entry = packed[name]
        if "q" in entry:
            new_state[name] = dequantize(torch, entry["q"], entry["scale"])
        else:
            new_state[name] = entry["raw"]
    model.load_state_dict(new_state)
    return model


def float_bytes(torch, model):
    return sum(p.numel() * 4 for p in model.state_dict().values() if p.dtype.is_floating_point)


def int8_bytes(model):
    total = 0
    for tensor in model.state_dict().values():
        if tensor.dtype.is_floating_point and tensor.dim() == 2:
            total += tensor.numel()
        else:
            total += tensor.numel() * 4
    return total


def cosine(torch, a, b):
    flat_a = a.flatten()
    flat_b = b.flatten()
    denom = float(flat_a.norm()) * float(flat_b.norm())
    if denom == 0.0:
        return 1.0
    return float((flat_a @ flat_b) / denom)


def main():
    parser = argparse.ArgumentParser(description="Post-training int8 quantization for inference")
    parser.add_argument("--smoke", action="store_true", help="Fast deterministic quantization check")
    args = parser.parse_args()

    cfg = load_run_config()
    seed = cfg_int(cfg, "seed", 42)

    import torch
    import torch.nn as nn

    torch.manual_seed(seed)
    device = torch.device("cpu")
    dim, hidden, out = 32, 64, 8

    if args.smoke:
        checks = []
        passed_all = True
        primary_value = 0.0

        def record(name, ok, detail):
            checks.append({"name": name, "passed": bool(ok), "detail": detail})

        try:
            model = build_model(torch, nn, dim, hidden, out, seed).to(device)
            inputs = torch.randn(16, dim)
            with torch.no_grad():
                reference = model(inputs)
            record("fp32_inference", bool(torch.isfinite(reference).all()), "fp32 output finite")

            packed = quantize_model(torch, model)
            quant_model = build_model(torch, nn, dim, hidden, out, seed).to(device)
            quant_model = load_quantized(torch, quant_model, packed)
            with torch.no_grad():
                quant_out = quant_model(inputs)
            record("int8_inference", bool(torch.isfinite(quant_out).all()), "int8 output finite")

            similarity = cosine(torch, reference, quant_out)
            primary_value = similarity
            close = similarity > 0.99
            record("quant_fidelity", close, "cosine vs fp32 " + format(similarity, ".4f"))
            passed_all = passed_all and close

            os.makedirs("checkpoints", exist_ok=True)
            ckpt = os.path.join("checkpoints", "quant_smoke.pt")
            serializable = {name: (entry if "raw" in entry else {"q": entry["q"], "scale": entry["scale"]}) for name, entry in packed.items()}
            torch.save(serializable, ckpt)
            reloaded = torch.load(ckpt, weights_only=True)
            quant_model2 = load_quantized(torch, build_model(torch, nn, dim, hidden, out, seed).to(device), reloaded)
            with torch.no_grad():
                quant_out2 = quant_model2(inputs)
            roundtrip = bool(torch.allclose(quant_out, quant_out2, atol=1e-6))
            record("checkpoint_roundtrip", roundtrip, "reloaded quantized weights identical" if roundtrip else "roundtrip diverged")
            passed_all = passed_all and roundtrip

            fp_bytes = float_bytes(torch, model)
            q_bytes = int8_bytes(model)
            compressed = q_bytes < fp_bytes
            record("compression", compressed, "fp32 " + str(fp_bytes) + "B -> int8 " + str(q_bytes) + "B")
            passed_all = passed_all and compressed
        except Exception as exc:
            record("smoke_exception", False, str(exc))
            passed_all = False

        report = {
            "checks": checks,
            "primary": {"name": "cosine_similarity", "value": primary_value, "split": "n/a", "goal": "max"},
            "passed": passed_all,
        }
        write_json("smoke_report.json", report)
        print(json.dumps(report))
        raise SystemExit(0 if passed_all else 1)

    started = time.time()
    model = build_model(torch, nn, dim, hidden, out, seed).to(device)
    inputs = torch.randn(512, dim)
    with torch.no_grad():
        reference = model(inputs)

    packed = quantize_model(torch, model)
    quant_model = load_quantized(torch, build_model(torch, nn, dim, hidden, out, seed).to(device), packed)
    with torch.no_grad():
        quant_out = quant_model(inputs)

    similarity = cosine(torch, reference, quant_out)
    max_abs_err = float((reference - quant_out).abs().max())

    rows = []
    rows.append({"t": round(time.time() - started, 4), "step": 0, "split": "test", "name": "cosine_similarity", "value": similarity})
    rows.append({"t": round(time.time() - started, 4), "step": 0, "split": "test", "name": "max_abs_err", "value": max_abs_err})
    write_lines("metrics.jsonl", rows)

    fp_bytes = float_bytes(torch, model)
    q_bytes = int8_bytes(model)

    reps = 50
    warm = quant_model(inputs)
    decode_start = time.time()
    with torch.no_grad():
        for _ in range(reps):
            quant_model(inputs)
    decode_s = time.time() - decode_start
    throughput = round((reps * inputs.shape[0]) / decode_s, 2) if decode_s > 0 else 0.0

    peak_ram_mb = None
    try:
        import psutil
        peak_ram_mb = round(psutil.Process().memory_info().rss / (1024 * 1024), 1)
    except Exception:
        peak_ram_mb = None

    summary = {
        "primary": {"name": "cosine_similarity", "value": similarity, "split": "test", "goal": "max"},
        "baseline": {"name": "identity_floor", "value": 0.0, "split": "test"},
        "objectives": {
            "wall_s": round(time.time() - started, 3),
            "peak_ram_mb": peak_ram_mb,
            "fp32_bytes": fp_bytes,
            "int8_bytes": q_bytes,
            "compression_ratio": round(fp_bytes / q_bytes, 3) if q_bytes > 0 else 0.0,
            "max_abs_err": round(max_abs_err, 6),
            "samples_per_s": throughput,
        },
        "seed": seed,
        "method": "int8_post_training_quantization",
    }
    write_json("metrics.json", summary)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
`;

const TRM_DEEP_SUPERVISION = `import argparse
import json
import os
import time


def load_run_config():
    config_path = os.environ.get("EXPERIMENT_CONFIG", "")
    if not config_path:
        candidate = os.path.join(".orchestrator", "experiment", "run_config.json")
        if os.path.exists(candidate):
            config_path = candidate
    if config_path and os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:
            return {}
    return {}


def cfg_int(cfg, key, default):
    value = cfg.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def write_lines(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + chr(10))


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def make_puzzles(torch, count, cells, seed, device):
    generator = torch.Generator().manual_seed(seed)
    inputs = torch.randint(0, 2, (count, cells), generator=generator)
    shifted = torch.roll(inputs, shifts=-1, dims=1)
    targets = torch.bitwise_xor(inputs, shifted)
    # Generate on CPU (deterministic), then move to the run device so model and inputs share a device.
    return inputs.float().to(device), targets.long().to(device)


def build_trm(torch, nn, cells, hidden, depth, seed, device):
    torch.manual_seed(seed)

    class TinyRecursiveModel(nn.Module):
        def __init__(self):
            super().__init__()
            self.embed = nn.Linear(cells, hidden)
            self.block = nn.Sequential(nn.Linear(hidden * 2, hidden), nn.ReLU(), nn.Linear(hidden, hidden))
            self.norm = nn.LayerNorm(hidden)
            self.decoder = nn.Linear(hidden, cells * 2)
            self.depth = depth
            self.cells = cells

        def forward(self, x):
            x_embed = self.embed(x)
            h = torch.zeros_like(x_embed)
            logits_per_depth = []
            for _ in range(self.depth):
                h = self.norm(h + self.block(torch.cat([h, x_embed], dim=-1)))
                logits = self.decoder(h).view(x.shape[0], self.cells, 2)
                logits_per_depth.append(logits)
            return logits_per_depth

    return TinyRecursiveModel().to(device)


def deep_supervision_loss(loss_fn, logits_per_depth, targets):
    total = 0.0
    for logits in logits_per_depth:
        total = total + loss_fn(logits.reshape(-1, 2), targets.reshape(-1))
    return total


def exact_match(logits, targets):
    preds = logits.argmax(dim=-1)
    correct_rows = (preds == targets).all(dim=1)
    return float(correct_rows.float().mean())


def train_once(torch, nn, cells, hidden, depth, seed, epochs, lr, train_n, val_n, device):
    torch.manual_seed(seed)
    x_train, y_train = make_puzzles(torch, train_n, cells, seed, device)
    x_val, y_val = make_puzzles(torch, val_n, cells, seed + 1000, device)
    model = build_trm(torch, nn, cells, hidden, depth, seed, device)
    loss_fn = nn.CrossEntropyLoss()
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    history = []
    for epoch in range(epochs):
        opt.zero_grad()
        loss = deep_supervision_loss(loss_fn, model(x_train), y_train)
        loss.backward()
        opt.step()
        history.append(float(loss.detach()))
    with torch.no_grad():
        val_logits = model(x_val)
    per_depth = [exact_match(val_logits[d], y_val) for d in range(depth)]
    return model, history, per_depth, (x_val, y_val)


def append_metric(path, payload):
    # Stream one metric row as it is produced (append + flush) so the live training chart updates during the
    # run; never buffer all rows and write once at the end. Returns the row so callers can also keep it.
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + chr(10))
        handle.flush()
    return payload


def main():
    parser = argparse.ArgumentParser(description="Tiny Recursive Model with deep supervision and exact-match eval")
    parser.add_argument("--smoke", action="store_true", help="Fast deterministic wiring check")
    args = parser.parse_args()

    cfg = load_run_config()
    seed = cfg_int(cfg, "seed", 42)
    epochs = cfg_int(cfg, "epochs", 0) or 300
    depth = cfg_int(cfg, "maxSteps", 0) or 3
    cells, hidden = 8, 48
    lr = 0.01

    import torch
    import torch.nn as nn

    torch.use_deterministic_algorithms(True, warn_only=True)
    # Honor the device the orchestrator granted (ACF_DEVICE); fall back to CPU. Smoke runs pass ACF_DEVICE=cpu.
    requested_device = os.environ.get("ACF_DEVICE", "cpu").strip().lower()
    device = torch.device(requested_device) if requested_device.startswith("cuda") and torch.cuda.is_available() else torch.device("cpu")

    if args.smoke:
        checks = []
        passed_all = True
        primary_value = 0.0

        def record(name, ok, detail):
            checks.append({"name": name, "passed": bool(ok), "detail": detail})

        try:
            x, y = make_puzzles(torch, 16, cells, seed, device)
            model = build_trm(torch, nn, cells, hidden, depth, seed, device)
            loss_fn = nn.CrossEntropyLoss()
            logits = model(x)
            depth_ok = len(logits) == depth
            record("recursion_depth", depth_ok, "produced " + str(len(logits)) + " supervised depths")
            passed_all = passed_all and depth_ok

            loss0 = deep_supervision_loss(loss_fn, logits, y)
            loss0_value = float(loss0.detach())
            record("forward_finite", bool(torch.isfinite(loss0)), "deep-supervision loss " + format(loss0_value, ".4f"))
            passed_all = passed_all and bool(torch.isfinite(loss0))

            loss0.backward()
            grads = [p.grad for p in model.parameters() if p.grad is not None]
            grads_ok = all(bool(torch.isfinite(g).all()) for g in grads) and any(float(g.abs().sum()) > 0 for g in grads)
            record("backward_grads", grads_ok, "gradients finite and nonzero")
            passed_all = passed_all and grads_ok

            opt = torch.optim.Adam(model.parameters(), lr=lr)
            for _ in range(200):
                opt.zero_grad()
                loss = deep_supervision_loss(loss_fn, model(x), y)
                loss.backward()
                opt.step()
            final_loss = float(deep_supervision_loss(loss_fn, model(x), y).detach())
            overfit = final_loss < loss0_value * 0.5
            record("overfit_tiny_batch", overfit, "loss " + format(loss0_value, ".3f") + " -> " + format(final_loss, ".3f"))
            passed_all = passed_all and overfit

            with torch.no_grad():
                final_logits = model(x)
            primary_value = exact_match(final_logits[-1], y)
            record("exact_match_eval", primary_value >= 0.0, "train exact-match " + format(primary_value, ".3f"))

            os.makedirs("checkpoints", exist_ok=True)
            ckpt = os.path.join("checkpoints", "trm_smoke.pt")
            torch.save(model.state_dict(), ckpt)
            reloaded = build_trm(torch, nn, cells, hidden, depth, seed, device)
            reloaded.load_state_dict(torch.load(ckpt, weights_only=True))
            with torch.no_grad():
                preds_a = model(x)[-1].argmax(dim=-1)
                preds_b = reloaded(x)[-1].argmax(dim=-1)
            roundtrip = bool(torch.equal(preds_a, preds_b))
            record("checkpoint_roundtrip", roundtrip, "reloaded model identical" if roundtrip else "reload diverged")
            passed_all = passed_all and roundtrip

            model_b = build_trm(torch, nn, cells, hidden, depth, seed, device)
            opt_b = torch.optim.Adam(model_b.parameters(), lr=lr)
            for _ in range(200):
                opt_b.zero_grad()
                loss_b = deep_supervision_loss(loss_fn, model_b(x), y)
                loss_b.backward()
                opt_b.step()
            det = abs(float(deep_supervision_loss(loss_fn, model_b(x), y).detach()) - final_loss) < 1e-3
            record("determinism", det, "same seed reproduces loss" if det else "nondeterministic")
            passed_all = passed_all and det
        except Exception as exc:
            record("smoke_exception", False, str(exc))
            passed_all = False

        report = {
            "checks": checks,
            "primary": {"name": "exact_match", "value": primary_value, "split": "train", "goal": "max"},
            "passed": passed_all,
        }
        write_json("smoke_report.json", report)
        print(json.dumps(report))
        raise SystemExit(0 if passed_all else 1)

    started = time.time()
    rows = []
    open("metrics.jsonl", "w", encoding="utf-8").close()  # truncate; rows stream in via append_metric below
    seeds = [seed, seed + 1, seed + 2]
    final_scores = []
    last_per_depth = []
    best_model = None
    best_score = -1.0
    for run_index, run_seed in enumerate(seeds):
        model, history, per_depth, _ = train_once(torch, nn, cells, hidden, depth, run_seed, epochs, lr, 256, 128, device)
        for step, value in enumerate(history):
            if step % 20 == 0 or step == len(history) - 1:
                rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": step, "split": "train", "name": "loss", "value": value, "depth": run_index}))
        for d, value in enumerate(per_depth):
            rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": epochs, "split": "val", "name": "exact_match", "value": value, "depth": d + 1}))
        final = per_depth[-1]
        final_scores.append(final)
        last_per_depth = per_depth
        if final > best_score:
            best_score = final
            best_model = model

    write_lines("metrics.jsonl", rows)  # idempotent final rewrite (identical content) — self-heals any partial flush

    mean_score = sum(final_scores) / len(final_scores)
    variance = sum((s - mean_score) ** 2 for s in final_scores) / len(final_scores)

    os.makedirs("checkpoints", exist_ok=True)
    if best_model is not None:
        torch.save(best_model.state_dict(), os.path.join("checkpoints", "trm.pt"))

    peak_ram_mb = None
    try:
        import psutil
        peak_ram_mb = round(psutil.Process().memory_info().rss / (1024 * 1024), 1)
    except Exception:
        peak_ram_mb = None

    summary = {
        "primary": {"name": "exact_match", "value": best_score, "split": "val", "goal": "max"},
        "baseline": {"name": "random_floor", "value": round(0.5 ** cells, 6), "split": "val"},
        "seed_variance": {"mean": round(mean_score, 5), "best": round(best_score, 5), "variance": round(variance, 6), "seeds": seeds},
        "per_depth_exact_match": [round(v, 5) for v in last_per_depth],
        "objectives": {"wall_s": round(time.time() - started, 3), "peak_ram_mb": peak_ram_mb, "recursion_depth": depth},
        "seed": seed,
        "method": "tiny_recursive_model_deep_supervision",
    }
    write_json("metrics.json", summary)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
`;

const DISTILLATION = `import argparse
import json
import os
import time


def load_run_config():
    config_path = os.environ.get("EXPERIMENT_CONFIG", "")
    if not config_path:
        candidate = os.path.join(".orchestrator", "experiment", "run_config.json")
        if os.path.exists(candidate):
            config_path = candidate
    if config_path and os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:
            return {}
    return {}


def cfg_int(cfg, key, default):
    value = cfg.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def write_lines(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + chr(10))


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def build_dataset(torch, n, dim, classes, seed, device):
    generator = torch.Generator().manual_seed(seed)
    centers = torch.randn(classes, dim, generator=generator) * 2.0
    labels = torch.randint(0, classes, (n,), generator=generator)
    features = centers[labels] + torch.randn(n, dim, generator=generator) * 0.8
    # Generate on CPU (deterministic), then move to the run device so models and inputs share a device.
    return features.to(device), labels.to(device)


def mlp(torch, nn, dim, hidden, classes, seed, device):
    torch.manual_seed(seed)
    return nn.Sequential(nn.Linear(dim, hidden), nn.ReLU(), nn.Linear(hidden, hidden), nn.ReLU(), nn.Linear(hidden, classes)).to(device)


def small_mlp(torch, nn, dim, hidden, classes, seed, device):
    torch.manual_seed(seed)
    return nn.Sequential(nn.Linear(dim, hidden), nn.ReLU(), nn.Linear(hidden, classes)).to(device)


def accuracy(torch, model, x, y):
    with torch.no_grad():
        return float((model(x).argmax(dim=1) == y).float().mean())


def train_supervised(torch, nn, model, x, y, epochs, lr):
    loss_fn = nn.CrossEntropyLoss()
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    for _ in range(epochs):
        opt.zero_grad()
        loss = loss_fn(model(x), y)
        loss.backward()
        opt.step()
    return model


def distill_loss(torch, nn, student_logits, teacher_logits, targets, temperature, alpha):
    ce = nn.functional.cross_entropy(student_logits, targets)
    soft_teacher = nn.functional.softmax(teacher_logits / temperature, dim=1)
    soft_student = nn.functional.log_softmax(student_logits / temperature, dim=1)
    kd = nn.functional.kl_div(soft_student, soft_teacher, reduction="batchmean") * (temperature * temperature)
    return alpha * kd + (1.0 - alpha) * ce


def append_metric(path, payload):
    # Stream one metric row as it is produced (append + flush) so the live training chart updates during the
    # run; never buffer all rows and write once at the end. Returns the row so callers can also keep it.
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + chr(10))
        handle.flush()
    return payload


def main():
    parser = argparse.ArgumentParser(description="Knowledge distillation from a teacher to a smaller student")
    parser.add_argument("--smoke", action="store_true", help="Fast deterministic distillation check")
    args = parser.parse_args()

    cfg = load_run_config()
    seed = cfg_int(cfg, "seed", 42)
    epochs = cfg_int(cfg, "epochs", 0) or 150
    dim, classes = 24, 5
    teacher_hidden, student_hidden = 96, 16
    temperature, alpha, lr = 3.0, 0.7, 0.01

    import torch
    import torch.nn as nn

    torch.use_deterministic_algorithms(True, warn_only=True)
    # Honor the device the orchestrator granted (ACF_DEVICE); fall back to CPU. Smoke runs pass ACF_DEVICE=cpu.
    requested_device = os.environ.get("ACF_DEVICE", "cpu").strip().lower()
    device = torch.device(requested_device) if requested_device.startswith("cuda") and torch.cuda.is_available() else torch.device("cpu")

    if args.smoke:
        checks = []
        passed_all = True
        primary_value = 0.0

        def record(name, ok, detail):
            checks.append({"name": name, "passed": bool(ok), "detail": detail})

        try:
            x, y = build_dataset(torch, 32, dim, classes, seed, device)
            teacher = mlp(torch, nn, dim, teacher_hidden, classes, seed, device)
            train_supervised(torch, nn, teacher, x, y, 60, lr)
            with torch.no_grad():
                teacher_logits = teacher(x)
            record("teacher_trains", bool(torch.isfinite(teacher_logits).all()), "teacher logits finite")

            student = small_mlp(torch, nn, dim, student_hidden, classes, seed, device)
            loss0 = distill_loss(torch, nn, student(x), teacher_logits, y, temperature, alpha)
            loss0_value = float(loss0.detach())
            record("kd_loss_finite", bool(torch.isfinite(loss0)), "distill loss " + format(loss0_value, ".4f"))
            passed_all = passed_all and bool(torch.isfinite(loss0))

            loss0.backward()
            grads = [p.grad for p in student.parameters() if p.grad is not None]
            grads_ok = all(bool(torch.isfinite(g).all()) for g in grads) and any(float(g.abs().sum()) > 0 for g in grads)
            record("student_grads", grads_ok, "student gradients finite and nonzero")
            passed_all = passed_all and grads_ok

            opt = torch.optim.Adam(student.parameters(), lr=lr)
            for _ in range(120):
                opt.zero_grad()
                loss = distill_loss(torch, nn, student(x), teacher(x).detach(), y, temperature, alpha)
                loss.backward()
                opt.step()
            final_loss = float(distill_loss(torch, nn, student(x), teacher(x).detach(), y, temperature, alpha).detach())
            overfit = final_loss < loss0_value * 0.7
            record("overfit_tiny_batch", overfit, "loss " + format(loss0_value, ".3f") + " -> " + format(final_loss, ".3f"))
            passed_all = passed_all and overfit

            primary_value = accuracy(torch, student, x, y)
            record("student_accuracy", primary_value >= 0.0, "train accuracy " + format(primary_value, ".3f"))

            os.makedirs("checkpoints", exist_ok=True)
            ckpt = os.path.join("checkpoints", "student_smoke.pt")
            torch.save(student.state_dict(), ckpt)
            reloaded = small_mlp(torch, nn, dim, student_hidden, classes, seed, device)
            reloaded.load_state_dict(torch.load(ckpt, weights_only=True))
            roundtrip = bool(torch.equal(student(x).argmax(dim=1), reloaded(x).argmax(dim=1)))
            record("checkpoint_roundtrip", roundtrip, "student reload identical" if roundtrip else "reload diverged")
            passed_all = passed_all and roundtrip
        except Exception as exc:
            record("smoke_exception", False, str(exc))
            passed_all = False

        report = {
            "checks": checks,
            "primary": {"name": "student_accuracy", "value": primary_value, "split": "train", "goal": "max"},
            "passed": passed_all,
        }
        write_json("smoke_report.json", report)
        print(json.dumps(report))
        raise SystemExit(0 if passed_all else 1)

    started = time.time()
    x, y = build_dataset(torch, 600, dim, classes, seed, device)
    # train / val / test slices: val is held out from train so student accuracy is tracked per eval as a curve.
    val_split = 400
    test_split = 480
    x_train, y_train = x[:val_split], y[:val_split]
    x_val, y_val = x[val_split:test_split], y[val_split:test_split]
    x_test, y_test = x[test_split:], y[test_split:]

    teacher = mlp(torch, nn, dim, teacher_hidden, classes, seed, device)
    train_supervised(torch, nn, teacher, x_train, y_train, epochs, lr)
    teacher_acc = accuracy(torch, teacher, x_test, y_test)
    with torch.no_grad():
        teacher_train_logits = teacher(x_train).detach()

    student = small_mlp(torch, nn, dim, student_hidden, classes, seed, device)
    loss_fn = nn.CrossEntropyLoss()
    opt = torch.optim.Adam(student.parameters(), lr=lr)
    rows = []
    open("metrics.jsonl", "w", encoding="utf-8").close()  # truncate; rows stream in via append_metric below
    for epoch in range(epochs):
        opt.zero_grad()
        loss = distill_loss(torch, nn, student(x_train), teacher_train_logits, y_train, temperature, alpha)
        loss.backward()
        opt.step()
        if epoch % 15 == 0 or epoch == epochs - 1:
            rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": epoch, "split": "train", "name": "kd_loss", "value": float(loss.detach())}))
            rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": epoch, "split": "val", "name": "accuracy", "value": accuracy(torch, student, x_val, y_val)}))
    distilled_acc = accuracy(torch, student, x_test, y_test)
    rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": epochs, "split": "test", "name": "accuracy", "value": distilled_acc}))

    scratch = small_mlp(torch, nn, dim, student_hidden, classes, seed, device)
    train_supervised(torch, nn, scratch, x_train, y_train, epochs, lr)
    scratch_acc = accuracy(torch, scratch, x_test, y_test)

    write_lines("metrics.jsonl", rows)  # idempotent final rewrite (identical content) — self-heals any partial flush

    values, counts = torch.unique(y_train, return_counts=True)
    majority = values[int(counts.argmax())]
    baseline_acc = float((y_test == majority).float().mean())

    os.makedirs("checkpoints", exist_ok=True)
    torch.save(student.state_dict(), os.path.join("checkpoints", "student.pt"))

    teacher_params = sum(p.numel() for p in teacher.parameters())
    student_params = sum(p.numel() for p in student.parameters())

    peak_ram_mb = None
    try:
        import psutil
        peak_ram_mb = round(psutil.Process().memory_info().rss / (1024 * 1024), 1)
    except Exception:
        peak_ram_mb = None

    summary = {
        "primary": {"name": "accuracy", "value": distilled_acc, "split": "test", "goal": "max"},
        "baseline": {"name": "most_frequent", "value": baseline_acc, "split": "test"},
        "secondary": [
            {"name": "teacher_accuracy", "value": teacher_acc, "split": "test", "goal": "max"},
            {"name": "student_from_scratch", "value": scratch_acc, "split": "test", "goal": "max"},
        ],
        "objectives": {
            "wall_s": round(time.time() - started, 3),
            "peak_ram_mb": peak_ram_mb,
            "teacher_params": teacher_params,
            "student_params": student_params,
            "compression_ratio": round(teacher_params / student_params, 3) if student_params > 0 else 0.0,
        },
        "seed": seed,
        "method": "knowledge_distillation",
    }
    write_json("metrics.json", summary)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
`;

const CHAR_LM_MODEL = `import torch
import torch.nn as nn

# A short built-in corpus (no downloads). Repetitive/structured so a tiny model learns visible patterns fast.
CORPUS = (
    "to be or not to be that is the question "
    "whether tis nobler in the mind to suffer "
    "the slings and arrows of outrageous fortune "
    "or to take arms against a sea of troubles "
    "and by opposing end them to die to sleep "
    "no more and by a sleep to say we end "
    "the heart ache and the thousand natural shocks "
    "that flesh is heir to tis a consummation "
    "devoutly to be wished to die to sleep "
    "to sleep perchance to dream ay there is the rub "
) * 8


def build_vocab(text):
    chars = sorted(set(text))
    stoi = {ch: i for i, ch in enumerate(chars)}
    itos = {i: ch for i, ch in enumerate(chars)}
    return chars, stoi, itos


def encode(text, stoi):
    return [stoi.get(ch, 0) for ch in text]


def decode(ids, itos):
    return "".join(itos.get(int(i), "") for i in ids)


class CharLm(nn.Module):
    def __init__(self, vocab_size, hidden):
        super().__init__()
        self.embed = nn.Embedding(vocab_size, hidden)
        self.gru = nn.GRU(hidden, hidden, batch_first=True)
        self.head = nn.Linear(hidden, vocab_size)

    def forward(self, tokens, state=None):
        embedded = self.embed(tokens)
        output, state = self.gru(embedded, state)
        return self.head(output), state


def build_model(vocab_size, hidden, seed=42):
    torch.manual_seed(seed)
    return CharLm(vocab_size, hidden)


def sample_next(logits, temperature=None, top_p=None, greedy=True):
    # logits: 1-D tensor over the vocab. Returns an int token id.
    if greedy or not temperature or float(temperature) <= 0:
        return int(torch.argmax(logits).item())
    probs = torch.softmax(logits / float(temperature), dim=-1)
    if top_p is not None and 0 < float(top_p) < 1:
        sorted_probs, sorted_idx = torch.sort(probs, descending=True)
        cumulative = torch.cumsum(sorted_probs, dim=-1)
        keep = cumulative <= float(top_p)
        keep[0] = True
        filtered = sorted_probs * keep.float()
        total = float(filtered.sum())
        if total <= 0:
            return int(sorted_idx[0].item())
        choice = int(torch.multinomial(filtered / total, 1).item())
        return int(sorted_idx[choice].item())
    return int(torch.multinomial(probs, 1).item())
`;

const CHAR_LM_TRAIN = `import argparse
import json
import os
import time

import torch
import torch.nn as nn

from model import CORPUS, build_model, build_vocab, encode, sample_next


def load_run_config():
    config_path = os.environ.get("EXPERIMENT_CONFIG", "")
    if not config_path:
        candidate = os.path.join(".orchestrator", "experiment", "run_config.json")
        if os.path.exists(candidate):
            config_path = candidate
    if config_path and os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:
            return {}
    return {}


def cfg_int(cfg, key, default):
    value = cfg.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def cfg_str(cfg, key, default):
    value = cfg.get(key)
    return value if isinstance(value, str) and value else default


def write_lines(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + chr(10))


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def append_metric(path, payload):
    # Stream one metric row as it is produced (append + flush) so the live training chart updates during the
    # run; never buffer all rows and write once at the end. Returns the row so callers can also keep it.
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + chr(10))
        handle.flush()
    return payload


def make_windows(ids, seq_len):
    count = len(ids) - seq_len
    if count <= 0:
        raise ValueError("corpus too short for the sequence length")
    xs = torch.zeros((count, seq_len), dtype=torch.long)
    ys = torch.zeros((count, seq_len), dtype=torch.long)
    for i in range(count):
        window = ids[i:i + seq_len + 1]
        xs[i] = torch.tensor(window[:-1], dtype=torch.long)
        ys[i] = torch.tensor(window[1:], dtype=torch.long)
    return xs, ys


def read_text_source(source):
    # Dataset contract (text): a folder -> concatenate all its files (sorted); a single file -> read it.
    # Returns "" on any failure so the caller can fall back to the built-in corpus.
    try:
        if os.path.isdir(source):
            parts = []
            for name in sorted(os.listdir(source)):
                file_path = os.path.join(source, name)
                if os.path.isfile(file_path):
                    try:
                        with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
                            parts.append(handle.read())
                    except Exception:
                        pass
            return chr(10).join(parts)
        if os.path.isfile(source):
            with open(source, "r", encoding="utf-8", errors="ignore") as handle:
                return handle.read()
    except Exception:
        return ""
    return ""


def main():
    parser = argparse.ArgumentParser(description="Character-level text language model")
    parser.add_argument("--smoke", action="store_true", help="Fast deterministic wiring check on CPU")
    args = parser.parse_args()

    cfg = load_run_config()
    seed = cfg_int(cfg, "seed", 42)
    seq_len = 32
    hidden = 128
    torch.manual_seed(seed)
    chars, stoi, itos = build_vocab(CORPUS)
    vocab_size = len(chars)
    ids = encode(CORPUS, stoi)
    loss_fn = nn.CrossEntropyLoss()

    if args.smoke:
        checks = []
        passed_all = True
        primary_value = 0.0

        def record(name, ok, detail):
            checks.append({"name": name, "passed": bool(ok), "detail": detail})

        try:
            xs, ys = make_windows(ids, seq_len)
            sx, sy = xs[:16], ys[:16]
            model = build_model(vocab_size, hidden, seed)
            logits, _ = model(sx)
            loss0 = loss_fn(logits.reshape(-1, vocab_size), sy.reshape(-1))
            loss0_value = float(loss0.detach())
            record("forward_finite", bool(torch.isfinite(loss0)), "loss " + format(loss0_value, ".4f"))
            passed_all = passed_all and bool(torch.isfinite(loss0))

            loss0.backward()
            grads = [p.grad for p in model.parameters() if p.grad is not None]
            grads_ok = all(bool(torch.isfinite(g).all()) for g in grads) and any(float(g.abs().sum()) > 0 for g in grads)
            record("backward_grads", grads_ok, "gradients finite and nonzero")
            passed_all = passed_all and grads_ok

            opt = torch.optim.Adam(model.parameters(), lr=0.01)
            for _ in range(120):
                opt.zero_grad()
                step_logits, _ = model(sx)
                loss = loss_fn(step_logits.reshape(-1, vocab_size), sy.reshape(-1))
                loss.backward()
                opt.step()
            final_loss = float(loss.detach())
            overfit = final_loss < loss0_value * 0.6
            record("overfit_tiny_batch", overfit, "loss " + format(loss0_value, ".3f") + " -> " + format(final_loss, ".3f"))
            passed_all = passed_all and overfit

            os.makedirs("checkpoints", exist_ok=True)
            ckpt = os.path.join("checkpoints", "smoke.pt")
            torch.save(model.state_dict(), ckpt)
            reloaded = build_model(vocab_size, hidden, seed)
            reloaded.load_state_dict(torch.load(ckpt, weights_only=True))
            model.eval()
            reloaded.eval()
            with torch.no_grad():
                a, _ = model(sx)
                b, _ = reloaded(sx)
            roundtrip = bool(torch.allclose(a, b, atol=1e-5))
            record("checkpoint_roundtrip", roundtrip, "reloaded forward identical" if roundtrip else "reloaded forward diverged")
            passed_all = passed_all and roundtrip

            with torch.no_grad():
                c, _ = build_model(vocab_size, hidden, seed)(sx)
                d, _ = build_model(vocab_size, hidden, seed)(sx)
            deterministic = bool(torch.equal(c, d))
            record("determinism", deterministic, "same seed reproduces init" if deterministic else "nondeterministic init")
            passed_all = passed_all and deterministic

            with torch.no_grad():
                trained_logits, _ = model(sx)
            primary_value = float((trained_logits.argmax(dim=-1) == sy).float().mean())
            record("metric_computes", primary_value >= 0.0, "train token accuracy " + format(primary_value, ".3f"))
        except Exception as exc:
            record("smoke_exception", False, str(exc))
            passed_all = False

        report = {
            "checks": checks,
            "primary": {"name": "next_char_accuracy", "value": primary_value, "split": "n/a", "goal": "max"},
            "passed": passed_all,
        }
        write_json("smoke_report.json", report)
        print(json.dumps(report))
        raise SystemExit(0 if passed_all else 1)

    device = cfg_str(cfg, "device", "cpu")
    if device not in ("cpu", "cuda", "mps"):
        device = "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        device = "cpu"
    epochs = cfg_int(cfg, "epochs", 0) or 8
    max_steps = cfg_int(cfg, "maxSteps", 0)
    subset = cfg_int(cfg, "subsetLimit", 0)
    batch_size = cfg_int(cfg, "batchSize", 0) or 64
    lr = cfg.get("lr") or cfg.get("learning_rate") or 0.003

    # Dataset contract (general): honor the user-selected training mode + role paths from run_config. The
    # orchestrator only assigns workspace locations to roles; this text model decides how to load them.
    dataset_mode = cfg_str(cfg, "dataset_mode", "builtin")
    train_path = cfg_str(cfg, "train_path", "")
    test_path = cfg_str(cfg, "test_path", "")
    corpus_path = cfg_str(cfg, "corpus_path", "")

    train_text = ""
    train_source = "builtin"
    if train_path:
        train_text = read_text_source(train_path)
        train_source = train_path
    elif corpus_path:
        train_text = read_text_source(corpus_path)
        train_source = corpus_path
    if not train_text.strip():
        train_text = CORPUS
        train_source = "builtin"

    test_text = ""
    test_source = None
    if test_path:
        test_text = read_text_source(test_path)
        if test_text.strip():
            test_source = test_path
        else:
            test_text = ""

    # Build the vocabulary over train+test so a character only seen in the held-out set never crashes encoding.
    chars, stoi, itos = build_vocab(train_text + test_text)
    vocab_size = len(chars)

    train_x, train_y = make_windows(encode(train_text, stoi), seq_len)
    if test_text.strip():
        val_x, val_y = make_windows(encode(test_text, stoi), seq_len)
        eval_split = "test"
    else:
        total = train_x.shape[0]
        val_count = max(1, total // 5)
        val_x, val_y = train_x[total - val_count:], train_y[total - val_count:]
        train_x, train_y = train_x[:total - val_count], train_y[:total - val_count]
        eval_split = "val"
    if subset > 0:
        train_x, train_y = train_x[:subset], train_y[:subset]

    model = build_model(vocab_size, hidden, seed).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=float(lr))
    val_x_d = val_x.to(device)
    val_y_d = val_y.to(device)

    started = time.time()
    open("metrics.jsonl", "w", encoding="utf-8").close()  # truncate; rows stream in via append_metric below
    rows = []
    step = 0
    train_n = train_x.shape[0]
    stop = False
    for epoch in range(epochs):
        perm = torch.randperm(train_n)
        for start in range(0, train_n, batch_size):
            idx = perm[start:start + batch_size]
            bx = train_x[idx].to(device)
            by = train_y[idx].to(device)
            opt.zero_grad()
            logits, _ = model(bx)
            loss = loss_fn(logits.reshape(-1, vocab_size), by.reshape(-1))
            loss.backward()
            opt.step()
            step += 1
            if step % 20 == 0:
                rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": step, "split": "train", "name": "loss", "value": float(loss.detach())}))
                model.eval()
                with torch.no_grad():
                    vlogits_step, _ = model(val_x_d)
                    val_acc_step = float((vlogits_step.argmax(dim=-1) == val_y_d).float().mean())
                model.train()
                rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": step, "split": eval_split, "name": "next_char_accuracy", "value": val_acc_step}))
            if max_steps > 0 and step >= max_steps:
                stop = True
                break
        if stop:
            break

    model.eval()
    with torch.no_grad():
        vlogits, _ = model(val_x_d)
        val_acc = float((vlogits.argmax(dim=-1) == val_y_d).float().mean())
        vloss = float(loss_fn(vlogits.reshape(-1, vocab_size), val_y_d.reshape(-1)).detach())
    rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": step, "split": eval_split, "name": "next_char_accuracy", "value": val_acc}))
    rows.append(append_metric("metrics.jsonl", {"t": round(time.time() - started, 4), "step": step, "split": eval_split, "name": "loss", "value": vloss}))
    write_lines("metrics.jsonl", rows)  # idempotent final rewrite (identical content) — self-heals any partial flush

    decode_start = time.time()
    generated_tokens = 0
    with torch.no_grad():
        logits, state = model(val_x_d[:1])
        for _ in range(64):
            nxt = sample_next(logits[0, -1, :], greedy=True)
            logits, state = model(torch.tensor([[nxt]], dtype=torch.long, device=device), state)
            generated_tokens += 1
    decode_s = time.time() - decode_start
    tokens_per_s = round(generated_tokens / decode_s, 2) if decode_s > 0 else 0.0

    os.makedirs("checkpoints", exist_ok=True)
    torch.save(model.state_dict(), os.path.join("checkpoints", "model.pt"))
    write_json(os.path.join("checkpoints", "vocab.json"), {"chars": chars, "hidden": hidden, "seq_len": seq_len})

    peak_ram_mb = None
    try:
        import psutil
        peak_ram_mb = round(psutil.Process().memory_info().rss / (1024 * 1024), 1)
    except Exception:
        peak_ram_mb = None

    summary = {
        "primary": {"name": "next_char_accuracy", "value": val_acc, "split": eval_split, "goal": "max"},
        "baseline": {"name": "uniform_random", "value": round(1.0 / vocab_size, 5), "split": eval_split},
        "objectives": {"wall_s": round(time.time() - started, 3), "peak_ram_mb": peak_ram_mb, "decode_tokens_per_s": tokens_per_s},
        "decode": {"strategy": "greedy", "max_new_tokens": 64},
        "seed": seed,
        "vocab_size": vocab_size,
        "dataset": {
            "mode": dataset_mode,
            "format": cfg_str(cfg, "dataset_format", "auto"),
            "train_source": train_source,
            "test_source": test_source,
            "train_chars": len(train_text),
            "test_chars": len(test_text),
        },
        "method": "char_level_language_model",
    }
    write_json("metrics.json", summary)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
`;

const CHAR_LM_PREDICT = `import json
import os
from pathlib import Path

import torch

from model import build_model, encode, sample_next

CHECKPOINT = Path("checkpoints") / "model.pt"
VOCAB = Path("checkpoints") / "vocab.json"

CONTRACT = {
    "task": "generation",
    "title": "Character-level text LM",
    "inputs": [
        {
            "name": "prompt",
            "modality": "text",
            "label": "Prompt",
            "help": "Type some text; the model continues it character by character.",
            "required": True,
            "example": "to be or not to ",
        }
    ],
    "output": {"kind": "text", "name": "completion"},
    "examples": [{"label": "soliloquy", "inputs": {"prompt": "to be or not to "}}],
    "batch": False,
}

_STATE = {"model": None, "itos": None, "stoi": None, "device": "cpu"}


def load():
    if not CHECKPOINT.exists() or not VOCAB.exists():
        raise FileNotFoundError("no trained model under checkpoints/ (run a short or full experiment first)")
    with open(VOCAB, "r", encoding="utf-8") as handle:
        meta = json.load(handle)
    chars = meta["chars"]
    hidden = int(meta.get("hidden", 128))
    stoi = {ch: i for i, ch in enumerate(chars)}
    itos = {i: ch for i, ch in enumerate(chars)}
    device = os.environ.get("ACF_DEVICE", "cpu")
    if device == "cuda" and not torch.cuda.is_available():
        device = "cpu"
    model = build_model(len(chars), hidden, seed=42)
    model.load_state_dict(torch.load(str(CHECKPOINT), map_location=device, weights_only=True))
    model.to(device)
    model.eval()
    _STATE.update({"model": model, "stoi": stoi, "itos": itos, "device": device})
    return model


def _opt_float(options, *keys):
    for key in keys:
        value = options.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                return None
    return None


def predict(inputs, options, ctx):
    if _STATE["model"] is None:
        load()
    model = _STATE["model"]
    stoi = _STATE["stoi"]
    itos = _STATE["itos"]
    device = _STATE["device"]
    options = options or {}
    prompt = str(inputs.get("prompt") or "")

    max_new = options.get("max_new_tokens")
    try:
        steps = int(max_new) if max_new is not None else 80
    except (TypeError, ValueError):
        steps = 80
    steps = max(1, min(steps, 400))
    greedy = bool(options.get("greedy", True))
    temperature = _opt_float(options, "temperature")
    top_p = _opt_float(options, "top_p", "topP")
    if not greedy and (temperature is None or temperature <= 0):
        temperature = 1.0

    context_ids = encode(prompt, stoi) or [0]
    tokens = torch.tensor([context_ids], dtype=torch.long, device=device)
    pieces = []
    with torch.no_grad():
        logits, state = model(tokens)
        for _ in range(steps):
            nxt = sample_next(logits[0, -1, :], temperature=temperature, top_p=top_p, greedy=greedy)
            ch = itos.get(int(nxt), "")
            pieces.append(ch)
            ctx.emit_token(ch)
            logits, state = model(torch.tensor([[nxt]], dtype=torch.long, device=device), state)
    return {"text": prompt + "".join(pieces)}
`;

const TEXT_GEN_PREDICT_CONTRACT: InferenceContract = {
  task: "generation",
  title: "Character-level text LM",
  inputs: [
    {
      name: "prompt",
      modality: "text",
      label: "Prompt",
      help: "Type some text; the model continues it character by character.",
      required: true,
      accept: null,
      example: "to be or not to ",
      multiple: false,
    },
  ],
  output: { kind: "text", name: "completion", unit: null, goal: null, labels: null },
  examples: [{ label: "soliloquy", inputs: { prompt: "to be or not to " } }],
  batch: false,
};

function textGenerationScaffold(): MlScaffold {
  return {
    kind: "inference-eval",
    entrypoint: "train.py",
    metrics: "metrics.jsonl",
    summary: "metrics.json",
    requirements: TORCH_REQUIREMENTS,
    readme: "# Character-level text language model\n\nTrains a small char-level LM on a built-in corpus, then serves text generation. Run `python train.py --smoke` for the wiring gate or `python train.py` for a full run.\n\nAfter a short or full run, open the Inference playground to type a prompt and stream a continuation (`predict.py`). This is a tiny demo LM (not coherent prose) and the template for wiring a real LLM's predict.py.\n",
    files: [
      { path: "model.py", content: CHAR_LM_MODEL },
      { path: "train.py", content: CHAR_LM_TRAIN },
      { path: "predict.py", content: CHAR_LM_PREDICT },
    ],
    degradedFrom: null,
    predict: { entrypoint: "predict.py", contract: TEXT_GEN_PREDICT_CONTRACT },
    data: dataContractFor("inference-eval"),
  };
}

const SKLEARN_REQUIREMENTS = "scikit-learn\nnumpy\npandas\njoblib\npsutil\n";
const CLASSICAL_REQUIREMENTS = "scikit-learn\nnumpy\npandas\njoblib\nmatplotlib\npsutil\n";
const NUMERICAL_REQUIREMENTS = "numpy\nscipy\nmatplotlib\npsutil\n";
const TORCH_REQUIREMENTS = "torch\nnumpy\npsutil\n";

const NUMERICAL_PATTERN = /\b(simulation|simulate|monte\s?carlo|\bode\b|differential equation|signal processing)\b/gi;
const EVAL_HARNESS_PATTERN = /\b(eval(?:uation)?\s+harness|benchmark|baseline ladder|leakage|contamination|holdout|hold-out)\b/gi;
const PEFT_PATTERN = /\b(fine[-\s]?tun(?:e|ing)|finetune|lora|qlora|peft|adapter|parameter[-\s]?efficient)\b/gi;
const QUANTIZE_PATTERN = /\b(quantiz(?:e|ation|ed)|int8|int4|8[-\s]?bit|4[-\s]?bit|gptq|awq|gguf|bitsandbytes)\b/gi;
const DISTILL_PATTERN = /\b(distill(?:ation)?|teacher[-\s]?student|knowledge transfer)\b/gi;
const TRM_PATTERN = /\b(tiny recursive model|\btrm\b|recursive reasoning|deep supervision|arc[-\s]?agi|grid puzzle|exact[-\s]?match puzzle)\b/gi;
const INFERENCE_PATTERN = /\b(inferenc\w*|serve|serving|generat\w*|decod\w*|language model|\bllm\b|small language model|chatbot|text generation|next[-\s]?token|autoregressive)\b/gi;

const SKLEARN_PREDICT = `import os

CONTRACT = {
    "task": "classification",
    "title": "Tabular model",
    "inputs": [
        {
            "name": "features",
            "modality": "tabular",
            "label": "Feature row",
            "help": "Comma- or space-separated numeric features for one sample (e.g. an iris row: 5.1, 3.5, 1.4, 0.2).",
            "required": True,
            "example": "5.1, 3.5, 1.4, 0.2",
        }
    ],
    "output": {"kind": "labels", "name": "class"},
    "examples": [{"label": "sample row", "inputs": {"features": "5.1, 3.5, 1.4, 0.2"}}],
    "batch": False,
}

_STATE = {"model": None}


def _checkpoint_path():
    for name in ("model.joblib", "model.pkl"):
        path = os.path.join("checkpoints", name)
        if os.path.exists(path):
            return path
    raise FileNotFoundError("no trained model under checkpoints/ (run a short or full experiment first)")


def load():
    import joblib
    model = joblib.load(_checkpoint_path())
    _STATE["model"] = model
    # Advertise a scalar output for regressors (estimators without a classes_ attribute).
    if hasattr(model, "classes_"):
        CONTRACT["task"] = "classification"
        CONTRACT["output"] = {"kind": "labels", "name": "class"}
    else:
        CONTRACT["task"] = "regression"
        CONTRACT["output"] = {"kind": "scalar", "name": "prediction"}
    return model


def _parse_row(value):
    import numpy as np
    if isinstance(value, (list, tuple)):
        nums = [float(v) for v in value]
    else:
        text = str(value if value is not None else "").strip()
        line = next((ln for ln in text.splitlines() if ln.strip()), "")
        parts = [p for chunk in line.split(",") for p in chunk.split()]
        nums = [float(p) for p in parts if p.strip() != ""]
    if not nums:
        raise ValueError("no numeric features were provided")
    return np.asarray(nums, dtype=float).reshape(1, -1)


def predict(inputs, options, ctx):
    model = _STATE["model"]
    if model is None:
        model = load()
    row = _parse_row(inputs.get("features"))
    expected = getattr(model, "n_features_in_", None)
    if expected is not None and row.shape[1] != expected:
        raise ValueError("expected " + str(expected) + " features but received " + str(row.shape[1]))
    if hasattr(model, "predict_proba") and hasattr(model, "classes_"):
        proba = model.predict_proba(row)[0]
        classes = [str(c) for c in list(getattr(model, "classes_", []))]
        ranked = sorted(zip(classes, [float(p) for p in proba]), key=lambda kv: kv[1], reverse=True)
        return {"labels": [{"label": name, "score": score} for name, score in ranked]}
    pred = model.predict(row)[0]
    if hasattr(model, "classes_"):
        return {"labels": [{"label": str(pred), "score": 1.0}]}
    return {"prediction": float(pred)}
`;

const CLASSICAL_PREDICT_CONTRACT: InferenceContract = {
  task: "classification",
  title: "Tabular model",
  inputs: [
    {
      name: "features",
      modality: "tabular",
      label: "Feature row",
      help: "Comma- or space-separated numeric features for one sample (e.g. an iris row: 5.1, 3.5, 1.4, 0.2).",
      required: true,
      accept: null,
      example: "5.1, 3.5, 1.4, 0.2",
      multiple: false,
    },
  ],
  output: { kind: "labels", name: "class", unit: null, goal: null, labels: null },
  examples: [{ label: "sample row", inputs: { features: "5.1, 3.5, 1.4, 0.2" } }],
  batch: false,
};

function classicalScaffold(degradedFrom: string | null): MlScaffold {
  return {
    kind: "classical-ml",
    entrypoint: "train.py",
    metrics: "metrics.jsonl",
    summary: "metrics.json",
    requirements: CLASSICAL_REQUIREMENTS,
    readme: "# Classical ML experiment\n\nRun `python train.py` for a full run (cross-validation, held-out test, baseline), or `python train.py --smoke` for the orchestrator smoke gate.\n\nAfter a short or full run, open the Inference playground to test your own feature rows against the trained model (`predict.py`).\n",
    files: [
      { path: "train.py", content: CLASSICAL_ML_TRAIN },
      { path: "predict.py", content: SKLEARN_PREDICT },
    ],
    degradedFrom,
    predict: { entrypoint: "predict.py", contract: CLASSICAL_PREDICT_CONTRACT },
    data: dataContractFor("classical-ml"),
  };
}

function numericalScaffold(): MlScaffold {
  return {
    kind: "numerical",
    entrypoint: "sim.py",
    metrics: null,
    summary: "metrics.json",
    requirements: NUMERICAL_REQUIREMENTS,
    readme: "# Numerical experiment\n\nRun `python sim.py` for a full run, or `python sim.py --smoke` for the orchestrator smoke gate.\n",
    files: [{ path: "sim.py", content: NUMERICAL_SIM }],
    degradedFrom: null,
    data: dataContractFor("numerical"),
  };
}

function evalHarnessScaffold(): MlScaffold {
  return {
    kind: "eval-harness",
    entrypoint: "eval.py",
    metrics: "metrics.jsonl",
    summary: "metrics.json",
    requirements: SKLEARN_REQUIREMENTS,
    readme: "# Evaluation harness\n\nTrains a model and scores it against a baseline ladder (most_frequent, stratified, uniform) with a train/test leakage check. Run `python eval.py` or `python eval.py --smoke`.\n",
    files: [{ path: "eval.py", content: EVAL_HARNESS }],
    degradedFrom: null,
    data: dataContractFor("eval-harness"),
  };
}

function torchScaffold(
  kind: string,
  entrypoint: string,
  body: string,
  readme: string,
): MlScaffold {
  return {
    kind,
    entrypoint,
    metrics: "metrics.jsonl",
    summary: "metrics.json",
    requirements: TORCH_REQUIREMENTS,
    readme,
    files: [{ path: entrypoint, content: body }],
    degradedFrom: null,
    data: dataContractFor(kind),
  };
}

interface ScaffoldIntent {
  /** Global-flagged keyword net; the number of matches is the raw signal. */
  pattern: RegExp;
  /** Specificity weight: high-precision technique terms outweigh broad, easily-incidental nets. */
  weight: number;
  /** Torch-requiring intents fall back to the classical scaffold when torch is unavailable. */
  requiresTorch: boolean;
  /** `degradedFrom` label recorded when a torch intent is downgraded to classical. */
  degradeName: string | null;
  build: () => MlScaffold;
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches === null ? 0 : matches.length;
}

export function selectMlScaffold(userRequest: string, caps: MlScaffoldCapabilities): MlScaffold {
  const text = userRequest ?? "";

  const intents: ScaffoldIntent[] = [
    {
      pattern: TRM_PATTERN,
      weight: 3,
      requiresTorch: true,
      degradeName: "trm",
      build: () =>
        torchScaffold(
          "trm",
          "trm.py",
          TRM_DEEP_SUPERVISION,
          "# Tiny Recursive Model\n\nA from-scratch recursive network with deep supervision and exact-match puzzle eval. Per-recursion-depth metrics are emitted with a `depth` field; final scores are reported with seed-variance. Run `python trm.py` or `python trm.py --smoke`.\n",
        ),
    },
    {
      pattern: DISTILL_PATTERN,
      weight: 3,
      requiresTorch: true,
      degradeName: "distillation",
      build: () =>
        torchScaffold(
          "distillation",
          "distill.py",
          DISTILLATION,
          "# Knowledge distillation\n\nTrains a teacher then distills it into a smaller student (KL on softened logits plus hard-label cross-entropy), comparing the distilled student against a from-scratch student and the teacher. Run `python distill.py` or `python distill.py --smoke`.\n",
        ),
    },
    {
      pattern: QUANTIZE_PATTERN,
      weight: 3,
      requiresTorch: true,
      degradeName: "quantized-inference",
      build: () =>
        torchScaffold(
          "quantized-inference",
          "quantize.py",
          QUANTIZED_INFERENCE,
          "# Quantized inference\n\nPost-training int8 quantization of a model with fidelity (cosine vs fp32), compression ratio, and throughput. Weights round-trip through a weights-only checkpoint load. Run `python quantize.py` or `python quantize.py --smoke`.\n",
        ),
    },
    {
      pattern: PEFT_PATTERN,
      weight: 3,
      requiresTorch: true,
      degradeName: "peft-finetune",
      build: () =>
        torchScaffold(
          "peft-finetune",
          "finetune.py",
          PEFT_FINETUNE,
          "# LoRA fine-tuning\n\nParameter-efficient fine-tuning: a frozen base with trainable low-rank adapters. Only the adapter and head train; the base stays frozen. Adapters round-trip through a weights-only checkpoint. Run `python finetune.py` or `python finetune.py --smoke`.\n",
        ),
    },
    {
      pattern: EVAL_HARNESS_PATTERN,
      weight: 2,
      requiresTorch: false,
      degradeName: null,
      build: () => evalHarnessScaffold(),
    },
    {
      pattern: INFERENCE_PATTERN,
      weight: 1,
      requiresTorch: true,
      degradeName: "inference-eval",
      build: () => textGenerationScaffold(),
    },
    {
      pattern: NUMERICAL_PATTERN,
      weight: 1,
      requiresTorch: false,
      degradeName: null,
      build: () => numericalScaffold(),
    },
  ];

  let winner: { intent: ScaffoldIntent; score: number } | null = null;
  for (const intent of intents) {
    const score = countMatches(text, intent.pattern) * intent.weight;
    if (score <= 0) {
      continue;
    }
    if (winner === null || score > winner.score) {
      winner = { intent, score };
    }
  }

  if (winner === null) {
    return classicalScaffold(null);
  }
  if (winner.intent.requiresTorch && !caps.torchAvailable) {
    return classicalScaffold(winner.intent.degradeName);
  }
  return winner.intent.build();
}
