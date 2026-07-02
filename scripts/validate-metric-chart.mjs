import {
  assignAxes,
  axisForKey,
  bestIndexByGoal,
  boundsFor,
  compareSeriesForDisplay,
  distinctValueCount,
  formatSecondaryTick,
  formatTick,
  isBounded01Series,
  isBoundedScoreMetric,
  logBoundsForKeys,
  MAX_AXES,
  MAX_SERIES,
  metricGoal,
  nearestPointForX,
  shouldUseLogScale,
  resolvePrimaryKey,
  resolveSecondaryAxis,
  scoreBounds,
  secondaryScaleKeys,
  seriesScale,
  snapToSampleX,
} from "../components/ml/metric-chart-scale.ts";


let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log("  PASS", name, detail ? "(" + detail + ")" : "");
  } else {
    failed += 1;
    failures.push(name + (detail ? " - " + detail : ""));
    console.log("  FAIL", name, detail ? "(" + detail + ")" : "");
  }
}

function mk(name, split, ys) {
  return {
    key: `${name}::${split}`,
    name,
    split,
    points: ys.map((y, i) => ({ x: i, y, step: i })),
  };
}

const loss = mk("loss", "train", [
  0.872, 0.103, 0.526, 0.588, 0.196, 0.053, 0.017, 0.045, 0.017, 0.004, 0.0038, 0.0093, 0.0146, 0.0408,
  0.0122, 0.0162, 0.0164, 0.0574, 0.0302, 0.0228, 0.0061, 0.0020, 0.0048, 0.0039, 0.0023, 0.00039,
]);
const valRmse = mk("rmse", "val", [0.0801, 0.0611, 0.0616, 0.0631]);
const valPearson = mk("pearson", "val", [0.9772, 0.977, 0.974, 0.9709]);
const valSpearman = mk("spearman", "val", [1, 1, 1, 1]);
const testRmse = mk("rmse", "test", [0.0934]);
const testPearson = mk("pearson", "test", [0.9553]);
const testSpearman = mk("spearman", "test", [0.9]);
const observed = [loss, valRmse, valPearson, valSpearman, testRmse, testPearson, testSpearman];

const observedSecondary = secondaryScaleKeys(observed);
check(
  "observed run -> single shared axis (no secondary)",
  observedSecondary.size === 0,
  `secondary=${observedSecondary.size}`,
);
check("observed run -> metric bounds span all series", (() => {
  const b = boundsFor(observed, observedSecondary, "metric");
  return b !== null && b.min < 0.01 && b.max > 0.95;
})());
check("observed run -> no count axis", boundsFor(observed, observedSecondary, "count") === null);

const allOnes = [
  mk("pearson", "val", [0.97, 0.98, 0.99]),
  mk("spearman", "val", [1, 1, 1]),
  mk("accuracy", "val", [0.95, 0.96, 0.97]),
];
check("all ~1 metrics -> no split", secondaryScaleKeys(allOnes).size === 0);

const withCounts = [
  mk("loss", "train", [0.5, 0.4, 0.3]),
  mk("tokens", "train", [5000, 8000, 12000]),
];
const countSecondary = secondaryScaleKeys(withCounts);
check("loss + counts -> exactly one secondary", countSecondary.size === 1, `secondary=${countSecondary.size}`);
check("loss + counts -> counts on secondary", countSecondary.has("tokens::train"));
check("loss + counts -> loss stays primary", !countSecondary.has("loss::train"));
check("loss + counts -> count bounds populated", (() => {
  const b = boundsFor(withCounts, countSecondary, "count");
  return b !== null && b.max > 11000;
})());

check("single series -> no split", secondaryScaleKeys([mk("loss", "train", [1, 2, 3])]).size === 0);

const onePoint = [mk("rmse", "test", [0.0934])];
check("single-point series -> bounds expand (not zero-width)", (() => {
  const b = boundsFor(onePoint, new Set(), "metric");
  return b !== null && b.max > b.min;
})());
check("single-point series -> bestIndexByGoal returns 0", bestIndexByGoal(onePoint[0].points, "min") === 0);

check("all-equal series -> 1 distinct value", distinctValueCount(valSpearman.points) === 1);
check("varied series -> multiple distinct values", distinctValueCount(valRmse.points) === 4);

const spiky = [];
for (let i = 0; i < 99; i += 1) spiky.push({ x: i, y: 100 + (i % 5), step: i });
spiky.push({ x: 99, y: 5000, step: 99 });
const spikeScale = seriesScale(spiky);
check("p95 scale ignores lone spike", spikeScale > 90 && spikeScale < 200, `scale=${spikeScale.toFixed(1)}`);

check("formatTick small range -> 3 decimals", formatTick(0.07, 0.02) === "0.070", formatTick(0.07, 0.02));
check("formatTick wide range -> 2 decimals", formatTick(0.5, 2) === "0.50", formatTick(0.5, 2));
check("formatTick tiny range -> 4 decimals", formatTick(0.0006, 0.0008) === "0.0006", formatTick(0.0006, 0.0008));
check(
  "formatSecondaryTick 0.977 is NOT rounded to '1'",
  formatSecondaryTick(0.977, 1.0, 1.0) !== "1" && formatSecondaryTick(0.977, 1.0, 1.0) === "0.98",
  formatSecondaryTick(0.977, 1.0, 1.0),
);
check("formatSecondaryTick large count -> k", formatSecondaryTick(12000, 12000, 12000) === "12k", formatSecondaryTick(12000, 12000, 12000));
check("formatSecondaryTick mid count -> 1.5k", formatSecondaryTick(1500, 1500, 1500) === "1.5k", formatSecondaryTick(1500, 1500, 1500));

check("metricGoal loss -> min", metricGoal("loss") === "min");
check("metricGoal rmse -> min", metricGoal("rmse") === "min");
check("metricGoal mae -> min", metricGoal("mae") === "min");
check("metricGoal pearson -> max", metricGoal("pearson") === "max");
check("metricGoal spearman -> max", metricGoal("spearman") === "max");
check("metricGoal accuracy -> max", metricGoal("accuracy") === "max");

check("resolvePrimaryKey exact name+split", resolvePrimaryKey(observed, "spearman", "test") === "spearman::test");
check("resolvePrimaryKey name-only fallback", resolvePrimaryKey(observed, "rmse", "holdout") === "rmse::val");
check("resolvePrimaryKey no match -> null", resolvePrimaryKey(observed, "f1", "test") === null);

const primaryKey = resolvePrimaryKey(observed, "spearman", "test");
const sorted = [...observed].sort((a, b) => compareSeriesForDisplay(a, b, primaryKey));
check("sort -> primary series first", sorted[0].key === "spearman::test", sorted[0].key);
check("sort -> loss is the headline non-primary", sorted[1].key === "loss::train", sorted[1].key);
check("sort -> val metrics outrank test/extra within top 4", (() => {
  const top4 = sorted.slice(0, 4).map((s) => s.key);
  return top4.includes("loss::train") && top4.includes("rmse::val");
})());
check("sort -> val before test for same metric (rmse)", (() => {
  const valIdx = sorted.findIndex((s) => s.key === "rmse::val");
  const testIdx = sorted.findIndex((s) => s.key === "rmse::test");
  return valIdx >= 0 && testIdx >= 0 && valIdx < testIdx;
})());

const clsLoss = mk("loss", "train", [1.2, 0.9, 0.72, 0.58, 0.46, 0.37, 0.3, 0.25, 0.21, 0.18, 0.15, 0.12, 0.1, 0.09]);
const clsValAcc = mk("accuracy", "val", [0.42, 0.58, 0.69, 0.78, 0.85, 0.9]);
const clsTestAcc = mk("accuracy", "test", [0.9]);
const clsRun = [clsLoss, clsValAcc, clsTestAcc];
const clsSecondary = secondaryScaleKeys(clsRun);
check("classification run -> single shared axis (loss + accuracy together)", clsSecondary.size === 0, `secondary=${clsSecondary.size}`);
check("classification run -> accuracy goal is max", metricGoal("accuracy") === "max");
check("classification run -> val accuracy is a multi-point curve", clsValAcc.points.length >= 5);
const clsPrimary = resolvePrimaryKey(clsRun, "accuracy", "test");
const clsKept = [...clsRun].sort((a, b) => compareSeriesForDisplay(a, b, clsPrimary)).slice(0, MAX_SERIES).map((s) => s.key);
check("classification run -> val accuracy kept (not capped out)", clsKept.includes("accuracy::val"), clsKept.join(","));
check("classification run -> test accuracy (primary) kept", clsKept.includes("accuracy::test"));
check("classification run -> loss kept", clsKept.includes("loss::train"));

check("isBoundedScoreMetric accuracy -> true", isBoundedScoreMetric("accuracy") === true);
check("isBoundedScoreMetric next_char_accuracy -> true", isBoundedScoreMetric("next_char_accuracy") === true);
check("isBoundedScoreMetric exact_match -> true", isBoundedScoreMetric("exact_match") === true);
check("isBoundedScoreMetric f1_macro -> true", isBoundedScoreMetric("f1_macro") === true);
check("isBoundedScoreMetric loss -> false", isBoundedScoreMetric("loss") === false);
check("isBoundedScoreMetric rmse -> false", isBoundedScoreMetric("rmse") === false);
check("isBoundedScoreMetric pearson -> false", isBoundedScoreMetric("pearson") === false);
check("isBoundedScoreMetric substring 'backtrack' not matched", isBoundedScoreMetric("backtrack") === false);

const lossAccAxis = resolveSecondaryAxis(clsRun);
check("loss + accuracy -> score axis exists", lossAccAxis !== null && lossAccAxis.kind === "score", lossAccAxis ? lossAccAxis.kind : "null");
check("loss + accuracy -> both accuracy series on score axis", (() => {
  return lossAccAxis !== null && lossAccAxis.keys.has("accuracy::val") && lossAccAxis.keys.has("accuracy::test");
})());
check("loss + accuracy -> loss stays on primary axis", lossAccAxis !== null && !lossAccAxis.keys.has("loss::train"));
check("loss + accuracy -> score axis bounds fixed to [0,1]", (() => {
  const b = scoreBounds(clsRun, lossAccAxis.keys);
  return b !== null && b.min === 0 && b.max >= 1 && b.max < 1.05;
})());

const pureAcc = [mk("accuracy", "val", [0.5, 0.7, 0.9]), mk("accuracy", "test", [0.88])];
check("pure accuracy -> no split", resolveSecondaryAxis(pureAcc) === null);

const lossRmse = [mk("loss", "train", [1.0, 0.5, 0.2]), mk("rmse", "val", [0.4, 0.3, 0.25])];
check("loss + rmse -> no split (bounded guard intact)", resolveSecondaryAxis(lossRmse) === null);

const lossAccCounts = [mk("loss", "train", [0.5, 0.4]), mk("accuracy", "val", [0.6, 0.7]), mk("tokens", "train", [5000, 9000])];
const mixedAxis = resolveSecondaryAxis(lossAccCounts);
check("count beats score for the secondary axis", mixedAxis !== null && mixedAxis.kind === "count", mixedAxis ? mixedAxis.kind : "null");
check("count precedence -> tokens on secondary, not accuracy", (() => {
  return mixedAxis !== null && mixedAxis.keys.has("tokens::train") && !mixedAxis.keys.has("accuracy::val");
})());

check("isBounded01Series accuracy (by name) -> true", isBounded01Series(mk("accuracy", "val", [0.5, 0.6])) === true);
check("isBounded01Series correlation in [0,1] -> true", isBounded01Series(mk("pearson", "val", [0.9, 0.95])) === true);
check("isBounded01Series loss>1 -> false", isBounded01Series(mk("loss", "train", [3.2, 1.5])) === false);
check("isBounded01Series perplexity -> false", isBounded01Series(mk("perplexity", "val", [120, 80])) === false);

const lossU = mk("loss", "train", [3.5, 2.8, 2.0, 1.4, 0.9, 0.6]);
const accU = mk("accuracy", "val", [0.4, 0.55, 0.7, 0.82]);
const perp = mk("perplexity", "val", [300, 180, 120, 80, 55]);

const axes3 = assignAxes([lossU, accU, perp], "accuracy::val");
check("3-axis: exactly 3 axes", axes3.length === 3, `n=${axes3.length}`);
const accAxis = axisForKey(axes3, "accuracy::val");
check("3-axis: accuracy on the score axis", accAxis !== null && accAxis.kind === "score");
check(
  "3-axis: score axis fixed to [0,1]",
  accAxis !== null && accAxis.bounds.min === 0 && accAxis.bounds.max >= 1 && accAxis.bounds.max < 1.05,
);
const lossAxis3 = axisForKey(axes3, "loss::train");
const perpAxis3 = axisForKey(axes3, "perplexity::val");
check("3-axis: loss and perplexity on DIFFERENT axes", lossAxis3 !== null && perpAxis3 !== null && lossAxis3.id !== perpAxis3.id);
check("3-axis: perplexity axis scaled to its own range (max>50)", perpAxis3 !== null && perpAxis3.bounds.max > 50);
check("3-axis: loss axis stays near loss range (max<6)", lossAxis3 !== null && lossAxis3.bounds.max < 6);
check("3-axis: primary (accuracy) is the inner-left axis", axes3[0].keys.has("accuracy::val") && axes3[0].side === "left");
check("3-axis: at most 2 axes per side", (() => {
  const l = axes3.filter((a) => a.side === "left").length;
  const r = axes3.filter((a) => a.side === "right").length;
  return l <= 2 && r <= 2;
})());

const counts = mk("tokens", "train", [5000, 12000, 30000]);
const axes4 = assignAxes([lossU, accU, perp, counts], "accuracy::val");
check("4-axis: exactly 4 axes", axes4.length === 4, `n=${axes4.length}`);
check("4-axis: balanced 2 left + 2 right", (() => {
  const l = axes4.filter((a) => a.side === "left").length;
  const r = axes4.filter((a) => a.side === "right").length;
  return l === 2 && r === 2;
})());
check("4-axis: counts axis is the large-scale one (max>1000)", (() => {
  const a = axisForKey(axes4, "tokens::train");
  return a !== null && a.bounds.max > 1000;
})());

const huge = mk("flops", "train", [1e6, 2e6, 3e6]);
const axes5 = assignAxes([lossU, accU, perp, counts, huge], "accuracy::val");
check("5 scales -> capped at MAX_AXES", axes5.length === MAX_AXES, `n=${axes5.length}`);
check("5 scales -> a merged axis is disclosed", axes5.some((a) => a.merged === true));

const axesLP = assignAxes([lossU, perp], "loss::train");
check("loss + perplexity -> 2 separate axes", axesLP.length === 2, `n=${axesLP.length}`);
check("loss + perplexity -> perplexity on its own axis", (() => {
  const la = axisForKey(axesLP, "loss::train");
  const pa = axisForKey(axesLP, "perplexity::val");
  return la !== null && pa !== null && la.id !== pa.id;
})());

const lossClose = mk("loss", "train", [4.0, 3.1, 2.4, 1.8, 1.3, 1.0]);
const perpClose = mk("perplexity", "val", [30, 22, 16, 12, 9, 7]); // ratio to loss ~7.5x, under the 8x split
const axesClose = assignAxes([lossClose, perpClose], "loss::train");
check("close-scale loss + perplexity -> 2 separate axes", axesClose.length === 2, `n=${axesClose.length}`);
check("close-scale -> perplexity NOT on loss axis", (() => {
  const la = axisForKey(axesClose, "loss::train");
  const pa = axisForKey(axesClose, "perplexity::val");
  return la !== null && pa !== null && la.id !== pa.id;
})());
check("close-scale -> loss axis bounded to loss range (max<6)", (() => {
  const la = axisForKey(axesClose, "loss::train");
  return la !== null && la.bounds.max < 6;
})());

const axesSameName = assignAxes([mk("loss", "train", [3, 2, 1]), mk("loss", "val", [3.2, 2.4, 1.6])], "loss::val");
check("same-name loss/train + loss/val -> single loss axis", axesSameName.length === 1, `n=${axesSameName.length}`);

const axesObserved = assignAxes(observed, resolvePrimaryKey(observed, "spearman", "test"));
check("all-[0,1] observed run -> single axis", axesObserved.length === 1, `n=${axesObserved.length}`);
check("all-[0,1] observed run -> that axis is the score axis", axesObserved.length === 1 && axesObserved[0].kind === "score");

const perpWide = mk("perplexity", "val", [60, 20, 9, 5, 3, 2.2]); // 27x spread -> log
const lossNarrow = mk("loss", "train", [4.1, 3.0, 2.2, 1.6, 1.1, 0.8]); // ~5x spread -> linear
check("shouldUseLogScale wide perplexity -> true", shouldUseLogScale([perpWide]) === true);
check("shouldUseLogScale narrow loss -> false", shouldUseLogScale([lossNarrow]) === false);
check("shouldUseLogScale with a non-positive value -> false (log undefined)", shouldUseLogScale([mk("x", "v", [100, 5, 0])]) === false);
check("logBoundsForKeys -> positive, padded outward", (() => {
  const b = logBoundsForKeys([perpWide], new Set(["perplexity::val"]));
  return b !== null && b.min > 0 && b.min < 2.2 && b.max > 60;
})());

const logAxisRun = assignAxes([mk("next_char_accuracy", "val", [0.1, 0.4, 0.7, 0.85]), lossNarrow, perpWide], "next_char_accuracy::val");
check("perplexity axis -> log scale", (() => {
  const a = axisForKey(logAxisRun, "perplexity::val");
  return a !== null && a.scale === "log";
})());
check("loss axis -> linear scale", (() => {
  const a = axisForKey(logAxisRun, "loss::train");
  return a !== null && a.scale === "linear";
})());
check("score (accuracy) axis -> linear scale", (() => {
  const a = axisForKey(logAxisRun, "next_char_accuracy::val");
  return a !== null && a.scale === "linear";
})());

const hoverSeries = mk("loss", "train", [0.9, 0.6, 0.4, 0.3]); // points at x = 0,1,2,3
check("nearestPointForX exact hit -> that point", nearestPointForX(hoverSeries.points, 2)?.x === 2);
check("nearestPointForX between points -> closer one", nearestPointForX(hoverSeries.points, 1.4)?.x === 1);
check("nearestPointForX rounds to nearer side", nearestPointForX(hoverSeries.points, 1.6)?.x === 2);
check("nearestPointForX before first -> first", nearestPointForX(hoverSeries.points, -5)?.x === 0);
check("nearestPointForX after last -> last", nearestPointForX(hoverSeries.points, 99)?.x === 3);
check("nearestPointForX ties -> earlier point", nearestPointForX(hoverSeries.points, 0.5)?.x === 0);
check("nearestPointForX empty -> null", nearestPointForX([], 1) === null);

const snapA = mk("loss", "train", [1, 0.8, 0.5]); // x = 0,1,2
const snapB = mk("accuracy", "val", [0.4, 0.7]); // x = 0,1 (val evals are sparser than train)
check("snapToSampleX snaps to nearest union x", snapToSampleX([snapA, snapB], 1.9) === 2);
check("snapToSampleX picks an existing sample x", (() => {
  const xs = new Set([0, 1, 2]);
  return xs.has(snapToSampleX([snapA, snapB], 1.2));
})());
check("snapToSampleX no data -> null", snapToSampleX([], 1) === null);
check("snapToSampleX empty-points series -> null", snapToSampleX([mk("loss", "train", [])], 1) === null);

console.log("");
console.log(`metric-chart validation: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log("  -", f);
  process.exit(1);
}
