import { pathToFileURL } from "node:url";
import { database } from "../src/lib/db";
import { sourceDatabaseUrl } from "./database-urls";

export type RepeatSalePair = {
  property_key: string;
  suburb: string;
  postcode: string | null;
  property_type: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  car_spaces: number | null;
  land_size_sqm: number | null;
  earlier_sold_date: string;
  later_sold_date: string;
  earlier_price_aud: number;
  later_price_aud: number;
  holding_days: number;
};

type MedianYear = { year: number; sale_count: number; median_price_aud: number };
export type AnnualMedianPoint = { year: number; sale_count: number; median_price_aud: number };
type PropertyProfile = Pick<RepeatSalePair, "property_key" | "suburb" | "postcode" | "property_type" | "bedrooms" | "bathrooms" | "car_spaces" | "land_size_sqm">;
type FitRow = RepeatSalePair & { earlierYear: number; laterYear: number; logChange: number };

const REFERENCE_YEAR = 2020;
const REPORT_START = 2009;
const REPORT_END = 2025;
const MIN_HOLD_SENSITIVITIES = [0, 90, 180, 365] as const;
const CONFIDENCE_Z = 1.959963984540054;

function compositionComparison(repeatPairs: RepeatSalePair[], population: PropertyProfile[]) {
  const latestRepeatProperty = new Map<string, RepeatSalePair>();
  for (const pair of repeatPairs) {
    const prior = latestRepeatProperty.get(pair.property_key);
    if (!prior || pair.later_sold_date > prior.later_sold_date) latestRepeatProperty.set(pair.property_key, pair);
  }

  const profile = (row: PropertyProfile): PropertyProfile => row;
  const repeat = [...latestRepeatProperty.values()].map(profile);
  const categorical = (label: string, get: (row: PropertyProfile) => unknown) => {
    const summarize = (rows: PropertyProfile[]) => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const value = get(row);
        const key = value === null || value === undefined || value === "" ? "Missing" : String(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].map(([category, count]) => ({ category, count, sharePct: 100 * count / rows.length }));
    };
    const repeatDist = summarize(repeat), populationDist = summarize(population);
    const popByCategory = new Map(populationDist.map((row) => [row.category, row]));
    return {
      field: label,
      repeatPropertyCount: repeat.length,
      pricedSalePropertyCount: population.length,
      categories: repeatDist.map((row) => ({
        category: row.category, repeatCount: row.count, repeatSharePct: row.sharePct,
        populationCount: popByCategory.get(row.category)?.count ?? 0,
        populationSharePct: popByCategory.get(row.category)?.sharePct ?? 0,
        shareDifferencePoints: row.sharePct - (popByCategory.get(row.category)?.sharePct ?? 0),
      })).sort((a, b) => Math.abs(b.shareDifferencePoints) - Math.abs(a.shareDifferencePoints)),
    };
  };
  const landBand = (value: unknown) => {
    const area = Number(value);
    if (!Number.isFinite(area) || area <= 0) return null;
    if (area < 200) return "<200 sqm";
    if (area < 400) return "200-399 sqm";
    if (area < 600) return "400-599 sqm";
    if (area < 1000) return "600-999 sqm";
    if (area < 2000) return "1000-1999 sqm";
    return "2000+ sqm";
  };
  const suburbCounts = (rows: PropertyProfile[]) => {
    const counts = new Map<string, number>();
    rows.forEach((row) => counts.set(row.suburb, (counts.get(row.suburb) ?? 0) + 1));
    return counts;
  };
  const repeatSuburbs = suburbCounts(repeat), populationSuburbs = suburbCounts(population);
  const repeatN = repeat.length, populationN = population.length;
  const suburbComparison = [...new Set([...repeatSuburbs.keys(), ...populationSuburbs.keys()])].map((suburb) => {
    const repeatCount = repeatSuburbs.get(suburb) ?? 0, populationCount = populationSuburbs.get(suburb) ?? 0;
    const repeatSharePct = 100 * repeatCount / repeatN, populationSharePct = 100 * populationCount / populationN;
    return { suburb, repeatCount, repeatSharePct, populationCount, populationSharePct, shareDifferencePoints: repeatSharePct - populationSharePct };
  }).sort((a, b) => Math.abs(b.shareDifferencePoints) - Math.abs(a.shareDifferencePoints));
  const concentration = (counts: Map<string, number>, n: number) => [...counts.values()].sort((a, b) => b - a).reduce((sum, count, index) => sum + (index < 10 ? count : 0), 0) / n * 100;
  return {
    definition: "Unique properties represented in at least one untrimmed valid-price, positive-hold consecutive pair, using the latest qualifying repeat-pair endpoint profile; compared with unique properties having at least one positive-priced serving-scope house sale, represented by their latest positive-priced sale.",
    repeatSaleProperties: repeat.length,
    fullPricedSaleProperties: population.length,
    repeatTop10SuburbSharePct: concentration(repeatSuburbs, repeatN),
    populationTop10SuburbSharePct: concentration(populationSuburbs, populationN),
    largestSuburbShareDifferences: suburbComparison.slice(0, 20),
    characteristics: [
      categorical("suburb", (row) => row.suburb),
      categorical("postcode", (row) => row.postcode),
      categorical("property_type", (row) => row.property_type),
      categorical("bedrooms", (row) => row.bedrooms),
      categorical("bathrooms", (row) => row.bathrooms),
      categorical("car_spaces", (row) => row.car_spaces),
      categorical("land_size_band", (row) => landBand(row.land_size_sqm)),
    ],
  };
}

function yearOf(date: string) {
  const year = Number(date.slice(0, 4));
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error(`Invalid sale date in repeat-sales sample: ${date}`);
  return year;
}

function solveAndInvert(matrix: number[][], rhs: number[]) {
  const n = rhs.length;
  const augmented = matrix.map((row, i) => [...row, rhs[i], ...Array.from({ length: n }, (_, j) => +(i === j))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) pivot = row;
    if (Math.abs(augmented[pivot][col]) < 1e-12) throw new Error("Repeat-sales design is numerically singular");
    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];
    const divisor = augmented[col][col];
    for (let j = col; j < 2 * n + 1; j++) augmented[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let j = col; j < 2 * n + 1; j++) augmented[row][j] -= factor * augmented[col][j];
    }
  }
  return {
    coefficients: augmented.map((row) => row[n]),
    inverse: augmented.map((row) => row.slice(n + 1)),
  };
}

function symmetricEigenvalues(input: number[][]) {
  const a = input.map((row) => [...row]);
  const n = a.length;
  for (let iteration = 0; iteration < 100 * n * n; iteration++) {
    let p = 0, q = 1, largest = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (Math.abs(a[i][j]) > largest) { largest = Math.abs(a[i][j]); p = i; q = j; }
    }
    if (largest < 1e-12) break;
    const angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(angle), s = Math.sin(angle);
    const app = c * c * a[p][p] - 2 * s * c * a[p][q] + s * s * a[q][q];
    const aqq = s * s * a[p][p] + 2 * s * c * a[p][q] + c * c * a[q][q];
    for (let k = 0; k < n; k++) {
      if (k === p || k === q) continue;
      const akp = c * a[k][p] - s * a[k][q];
      const akq = s * a[k][p] + c * a[k][q];
      a[k][p] = a[p][k] = akp;
      a[k][q] = a[q][k] = akq;
    }
    a[p][p] = app;
    a[q][q] = aqq;
    a[p][q] = a[q][p] = 0;
  }
  return a.map((row, i) => row[i]).sort((x, y) => y - x);
}

function dot(left: number[], right: number[]) {
  return left.reduce((sum, value, i) => sum + value * right[i], 0);
}

function quadratic(vector: number[], matrix: number[][]) {
  return dot(vector, matrix.map((row) => dot(row, vector)));
}

function summarizeResidualGroups(rows: FitRow[], residuals: number[]) {
  const summarize = (items: { residual: number; propertyKey: string }[]) => {
    const values = items.map((item) => item.residual).sort((a, b) => a - b);
    const absolute = values.map(Math.abs).sort((a, b) => a - b);
    return {
      pairCount: items.length,
      uniqueProperties: new Set(items.map((item) => item.propertyKey)).size,
      meanLogResidual: values.reduce((sum, value) => sum + value, 0) / values.length,
      rmseLog: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length),
      medianLogResidual: values[Math.floor(values.length / 2)],
      medianAbsoluteLogResidual: absolute[Math.floor(absolute.length / 2)],
      p95AbsoluteLogResidual: absolute[Math.min(absolute.length - 1, Math.floor(absolute.length * 0.95))],
    };
  };
  const groupBy = (key: (row: FitRow) => string) => {
    const groups = new Map<string, { residual: number; propertyKey: string }[]>();
    rows.forEach((row, index) => {
      const name = key(row);
      const values = groups.get(name) ?? [];
      values.push({ residual: residuals[index], propertyKey: row.property_key });
      groups.set(name, values);
    });
    return [...groups.entries()].map(([group, values]) => ({ group, ...summarize(values) }));
  };
  const holdingPeriod = (days: number) => days < 365 ? "0-<1y" : days < 3 * 365 ? "1-<3y" : days < 5 * 365 ? "3-<5y" : days < 10 * 365 ? "5-<10y" : "10y+";
  const bySuburb = groupBy((row) => row.suburb);
  return {
    byHoldingPeriod: groupBy((row) => holdingPeriod(row.holding_days)),
    byLaterEndpointYear: groupBy((row) => String(row.laterYear)),
    suburbCoverage: { representedSuburbs: bySuburb.length, allSuburbs: bySuburb.length,
      topByAbsoluteMeanResidual: [...bySuburb].sort((a, b) => Math.abs(b.meanLogResidual) - Math.abs(a.meanLogResidual)).slice(0, 15),
      topByRmse: [...bySuburb].sort((a, b) => b.rmseLog - a.rmseLog).slice(0, 15),
      lowestSupport: [...bySuburb].sort((a, b) => a.pairCount - b.pairCount).slice(0, 15) },
  };
}

export function fitRepeatSales(
  rows: RepeatSalePair[],
  minHoldingDays: number,
  options: { maxEndpointYear?: number; robust?: boolean; maxIterations?: number; huberK?: number } = {},
) {
  const { maxEndpointYear = Number.POSITIVE_INFINITY, robust = false, maxIterations = 1000, huberK = 1.345 } = options;
  const selected = rows.filter((row) => row.holding_days >= minHoldingDays && yearOf(row.later_sold_date) <= maxEndpointYear);
  const fitRows: FitRow[] = selected.map((row) => ({
    ...row,
    earlierYear: yearOf(row.earlier_sold_date),
    laterYear: yearOf(row.later_sold_date),
    logChange: Math.log(row.later_price_aud / row.earlier_price_aud),
  }));
  const years = [...new Set(fitRows.flatMap((row) => [row.earlierYear, row.laterYear]))].sort((a, b) => a - b);
  const coefficientsYears = years.filter((year) => year !== REFERENCE_YEAR);
  const columnForYear = new Map(coefficientsYears.map((year, index) => [year, index]));
  const p = coefficientsYears.length;
  const xtx = Array.from({ length: p }, () => Array(p).fill(0) as number[]);
  const vectors = fitRows.map((row) => {
    const vector = Array(p).fill(0) as number[];
    const earlier = columnForYear.get(row.earlierYear);
    const later = columnForYear.get(row.laterYear);
    if (earlier !== undefined) vector[earlier] -= 1;
    if (later !== undefined) vector[later] += 1;
    return vector;
  });
  const informativeIndices = vectors.flatMap((vector, i) => vector.some((value) => value !== 0) ? [i] : []);
  if (!informativeIndices.length) throw new Error("Repeat-sales sample has no cross-year identifying pairs");
  const addWeightedRow = (index: number, weight: number, rhs: number[]) => {
    const vector = vectors[index];
    for (let i = 0; i < p; i++) {
      rhs[i] += weight * vector[i] * fitRows[index].logChange;
      for (let j = 0; j < p; j++) xtx[i][j] += weight * vector[i] * vector[j];
    }
  };
  const buildSystem = (weights: number[]) => {
    for (const row of xtx) row.fill(0);
    const rhs = Array(p).fill(0) as number[];
    for (const i of informativeIndices) addWeightedRow(i, weights[i], rhs);
    return { rhs, ...solveAndInvert(xtx, rhs) };
  };
  if (!years.includes(REFERENCE_YEAR)) throw new Error(`Reference year ${REFERENCE_YEAR} is absent from this fit`);
  let weights = Array(fitRows.length).fill(1) as number[];
  let { coefficients, inverse } = buildSystem(weights);
  const eigenvalues = symmetricEigenvalues(xtx);
  const largestEigenvalue = eigenvalues[0] ?? 0;
  const eigenTolerance = largestEigenvalue * p * Number.EPSILON * 10;
  const rank = eigenvalues.filter((value) => value > eigenTolerance).length;
  const singularValues = eigenvalues.filter((value) => value > 0).map(Math.sqrt);
  const conditionNumber = rank === p && singularValues.length ? singularValues[0] / singularValues.at(-1)! : null;
  if (rank !== p) throw new Error(`Repeat-sales design rank deficient: rank ${rank} of ${p}; years ${years.join(",")}`);
  let iterations = 0, converged = true, robustScale = 0;
  if (robust) {
    converged = false;
    const initialResiduals = informativeIndices.map((i) => fitRows[i].logChange - dot(vectors[i], coefficients));
    const orderedInitial = [...initialResiduals].sort((a, b) => a - b);
    const initialMedian = orderedInitial[Math.floor(orderedInitial.length / 2)];
    const initialDeviations = initialResiduals.map((residual) => Math.abs(residual - initialMedian)).sort((a, b) => a - b);
    robustScale = initialDeviations[Math.floor(initialDeviations.length / 2)] / 0.6744897501960817;
    if (!Number.isFinite(robustScale)) throw new Error("Huber IRLS produced an invalid robust scale");
    if (robustScale <= 1e-12) {
      robustScale = Math.max(1e-12, Math.sqrt(initialResiduals.reduce((sum, residual) => sum + (residual - initialMedian) ** 2, 0) / initialResiduals.length));
    }
    for (iterations = 1; iterations <= maxIterations; iterations++) {
      const nextWeights = Array(fitRows.length).fill(0) as number[];
      for (const i of informativeIndices) {
        const standardized = Math.abs(fitRows[i].logChange - dot(vectors[i], coefficients)) / robustScale;
        nextWeights[i] = standardized <= huberK ? 1 : huberK / standardized;
      }
      const next = buildSystem(nextWeights);
      const coefficientChange = Math.max(...next.coefficients.map((value, i) => Math.abs(value - coefficients[i])));
      const weightChange = Math.max(...informativeIndices.map((i) => Math.abs(nextWeights[i] - weights[i])));
      coefficients = next.coefficients;
      inverse = next.inverse;
      weights = nextWeights;
      if (coefficientChange < 1e-8 && weightChange < 1e-8) {
        converged = true;
        break;
      }
    }
    if (!converged) throw new Error(`Huber IRLS failed to converge within ${maxIterations} iterations`);
  }
  const residuals = fitRows.map((row, i) => row.logChange - dot(vectors[i], coefficients));
  const crossResiduals = informativeIndices.map((i) => residuals[i]);
  const crossMean = crossResiduals.reduce((sum, residual) => sum + residual, 0) / crossResiduals.length;
  const crossSse = crossResiduals.reduce((sum, residual) => sum + residual * residual, 0);
  const crossSst = informativeIndices.reduce((sum, i) => sum + (fitRows[i].logChange - crossMean) ** 2, 0);
  const crossAbsResiduals = crossResiduals.map(Math.abs).sort((a, b) => a - b);
  const clusters = new Map<string, number[]>();
  fitRows.forEach((row, index) => {
    if (vectors[index].some((value) => value !== 0)) {
      const score = clusters.get(row.property_key) ?? Array(p).fill(0) as number[];
      if (robust) {
        const standardized = residuals[index] / robustScale;
        const psi = Math.max(-huberK, Math.min(huberK, standardized));
        for (let col = 0; col < p; col++) score[col] += vectors[index][col] * psi;
      } else {
        for (let col = 0; col < p; col++) score[col] += vectors[index][col] * residuals[index];
      }
      clusters.set(row.property_key, score);
    }
  });
  const clusterCount = clusters.size;
  if (clusterCount <= 1 || informativeIndices.length <= p) throw new Error("Insufficient pair or property-cluster count for clustered uncertainty");
  const meat = Array.from({ length: p }, () => Array(p).fill(0) as number[]);
  for (const score of clusters.values()) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) meat[i][j] += score[i] * score[j];
  const bread = Array.from({ length: p }, () => Array(p).fill(0) as number[]);
  for (const i of informativeIndices) {
    const robustWeight = robust ? +(Math.abs(residuals[i] / robustScale) <= huberK) : 1;
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) bread[a][b] += robustWeight * vectors[i][a] * vectors[i][b];
  }
  const breadInverse = robust ? solveAndInvert(bread, Array(p).fill(0) as number[]).inverse : inverse;
  const propertySuburb = new Map(fitRows.map((row) => [row.property_key, row.suburb]));
  const scoreNorms: { propertyKey: string; suburb: string; score: number[]; norm: number; approximateMaxIndexShiftPoints: number }[] =
    [...clusters.entries()].map(([propertyKey, score]) => ({
    propertyKey,
    suburb: propertySuburb.get(propertyKey) ?? "Unknown",
    score,
    norm: Math.sqrt(dot(score, score)),
    approximateMaxIndexShiftPoints: 0,
  }));
  const totalScoreNorm = scoreNorms.reduce((sum, item) => sum + item.norm, 0);
  const suburbScores = new Map<string, number[]>();
  for (const item of scoreNorms) {
    const score = suburbScores.get(item.suburb) ?? Array(p).fill(0) as number[];
    for (let col = 0; col < p; col++) score[col] += item.score[col];
    suburbScores.set(item.suburb, score);
  }
  const approximateIndexShift = (score: number[]) => {
    const coefficientShift = breadInverse.map((row) => -dot(row, score) * (robust ? robustScale : 1));
    const reportShifts = coefficientsYears.map((year, i) => ({ year, change: coefficientShift[i] }));
    return Math.max(...reportShifts.filter((item) => item.year >= REPORT_START && item.year <= REPORT_END)
      .map((item) => Math.abs(100 * Math.exp(coefficients[columnForYear.get(item.year)!]) * (Math.exp(item.change) - 1))));
  };
  for (const item of scoreNorms) item.approximateMaxIndexShiftPoints = approximateIndexShift(item.score);
  scoreNorms.sort((a, b) => b.approximateMaxIndexShiftPoints - a.approximateMaxIndexShiftPoints);
  const influentialSuburbs = [...suburbScores.entries()].map(([suburb, score]) => ({
    suburb,
    uniqueProperties: scoreNorms.filter((item) => item.suburb === suburb).length,
    clusterScoreNorm: Math.sqrt(dot(score, score)),
    approximateMaxIndexShiftPoints: approximateIndexShift(score),
  })).sort((a, b) => b.approximateMaxIndexShiftPoints - a.approximateMaxIndexShiftPoints);
  const covariance = Array.from({ length: p }, () => Array(p).fill(0) as number[]);
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) {
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) covariance[i][j] += breadInverse[i][a] * meat[a][b] * breadInverse[b][j];
  }
  if (robust) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) covariance[i][j] *= robustScale * robustScale;
  const effectivePairs = informativeIndices.length;
  const finiteClusterCorrection = (clusterCount / (clusterCount - 1)) * ((effectivePairs - 1) / (effectivePairs - p));
  const allRowsCorrection = (clusterCount / (clusterCount - 1)) * ((fitRows.length - 1) / (fitRows.length - p));
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) covariance[i][j] *= finiteClusterCorrection;

  const contrast = (leftYear: number, rightYear?: number) => {
    const c = Array(p).fill(0) as number[];
    const left = columnForYear.get(leftYear);
    const right = rightYear === undefined ? undefined : columnForYear.get(rightYear);
    if (left !== undefined) c[left] += 1;
    if (right !== undefined) c[right] -= 1;
    return { estimate: dot(c, coefficients), standardError: Math.sqrt(Math.max(0, quadratic(c, covariance))) };
  };
  const annualIndex = [];
  for (let year = REPORT_START; year <= REPORT_END; year++) {
    if (!years.includes(year)) {
      annualIndex.push({ year, estimable: false });
      continue;
    }
    const level = contrast(year);
    const previous = contrast(year - 1);
    const annual = contrast(year, year - 1);
    const coefficientColumn = columnForYear.get(year);
    const previousColumn = columnForYear.get(year - 1);
    const levelSupport = informativeIndices.filter((index) => coefficientColumn !== undefined && vectors[index][coefficientColumn] !== 0);
    const annualSupport = informativeIndices.filter((index) =>
      (coefficientColumn === undefined ? 0 : vectors[index][coefficientColumn])
      - (previousColumn === undefined ? 0 : vectors[index][previousColumn]) !== 0);
    annualIndex.push({
      year,
      estimable: true,
      index: 100 * Math.exp(level.estimate),
      indexLower95: 100 * Math.exp(level.estimate - CONFIDENCE_Z * level.standardError),
      indexUpper95: 100 * Math.exp(level.estimate + CONFIDENCE_Z * level.standardError),
      annualChangePct: 100 * (Math.exp(annual.estimate) - 1),
      annualChangeLower95Pct: 100 * (Math.exp(annual.estimate - CONFIDENCE_Z * annual.standardError) - 1),
      annualChangeUpper95Pct: 100 * (Math.exp(annual.estimate + CONFIDENCE_Z * annual.standardError) - 1),
      annualChangeStandardErrorLog: annual.standardError,
      previousYearLevelStandardErrorLog: previous.standardError,
      levelIdentifyingPairCount: levelSupport.length,
      levelContributingPropertyCount: new Set(levelSupport.map((index) => fitRows[index].property_key)).size,
      annualChangeIdentifyingPairCount: annualSupport.length,
      annualChangeContributingPropertyCount: new Set(annualSupport.map((index) => fitRows[index].property_key)).size,
    });
  }
  return {
    minHoldingDays,
    specification: robust ? "Huber M-estimator via IRLS" : "unweighted OLS",
    reportingWindow: `${REPORT_START}-${REPORT_END}`,
    referenceYear: REFERENCE_YEAR,
    modelYears: years,
    nuisanceYearsOutsideHeadline: years.filter((year) => year < REPORT_START || year > REPORT_END),
    pairCount: fitRows.length,
    informativeCrossYearPairCount: effectivePairs,
    sameCalendarYearDiagnosticPairCount: fitRows.length - effectivePairs,
    uniqueContributingProperties: clusterCount,
    influenceDiagnostics: {
      largestPropertyScoreShare: (scoreNorms[0]?.norm ?? 0) / totalScoreNorm,
      top10PropertyScoreShare: scoreNorms.slice(0, 10).reduce((sum, item) => sum + item.norm, 0) / totalScoreNorm,
      top20PropertyScoreShare: scoreNorms.slice(0, 20).reduce((sum, item) => sum + item.norm, 0) / totalScoreNorm,
      topPropertiesByApproximateMaxIndexShift: scoreNorms.slice(0, 10).map(({ suburb, norm, approximateMaxIndexShiftPoints }) => ({
        suburb, scoreShare: norm / totalScoreNorm, approximateMaxIndexShiftPoints,
      })),
      topSuburbsByApproximateMaxIndexShift: influentialSuburbs.slice(0, 15),
      caution: "Property influence uses clustered score norms; suburb deletion shifts are first-order score approximations, not exact leave-one-market-out refits.",
    },
    designColumns: p,
    designRank: rank,
    designConditionNumber: conditionNumber,
    covariance: robust
      ? "property-clustered Huber estimating-equation sandwich; approximate 95% normal-Wald intervals; robust scale treated as fixed"
      : "property-clustered CR1 sandwich; 95% normal-Wald intervals; CR1 N counts only cross-year coefficient-informing pairs",
    cr1Correction: { used: finiteClusterCorrection, ifSameYearRowsWereIncorrectlyCounted: allRowsCorrection },
    robustFit: robust ? {
      huberK,
      scaleEstimator: "Fixed at initial OLS residual MAD divided by 0.6744897501960817; when <=1e-12, fallback to initial cross-year residual RMS around the median, floored at 1e-12",
      convergence: { converged, iterations, maximumCoefficientChangeTolerance: "1e-8", maximumWeightChangeTolerance: "1e-8", maximumIterations: maxIterations },
      robustScaleLog: robustScale,
      downweightedCrossYearPairs: informativeIndices.filter((i) => weights[i] < 1 - 1e-12).length,
      downweightedSharePct: 100 * informativeIndices.filter((i) => weights[i] < 1 - 1e-12).length / effectivePairs,
      caveat: "Property-clustered M-estimator sandwich uses Huber psi and psi-prime bread; intervals are approximate and do not propagate uncertainty in the MAD scale estimator.",
    } : undefined,
    residualDiagnostics: {
      allPairsMeanLogResidual: residuals.reduce((sum, residual) => sum + residual, 0) / residuals.length,
      allPairsRmseLog: Math.sqrt(residuals.reduce((sum, residual) => sum + residual * residual, 0) / residuals.length),
      crossYearMeanLogResidual: crossMean,
      crossYearRmseLog: Math.sqrt(crossSse / effectivePairs),
      crossYearRmseApproxPct: 100 * (Math.exp(Math.sqrt(crossSse / effectivePairs)) - 1),
      crossYearMaeLog: crossAbsResiduals.reduce((sum, value) => sum + value, 0) / crossAbsResiduals.length,
      crossYearMedianAbsoluteLogResidual: crossAbsResiduals[Math.floor(crossAbsResiduals.length * 0.5)],
      crossYearRSquared: 1 - crossSse / crossSst,
      crossYearResidualP95AbsoluteLog: crossAbsResiduals[Math.min(crossAbsResiduals.length - 1, Math.floor(crossAbsResiduals.length * 0.95))],
      crossYearGaussianVarianceDf: effectivePairs - p,
      allPairsVarianceDfIfDiagnosticPairsWereCounted: fitRows.length - p,
      crossYearGaussianResidualVariance: crossSse / (effectivePairs - p),
      allPairsGaussianResidualVarianceIfSameYearIncluded: residuals.reduce((sum, residual) => sum + residual * residual, 0) / (fitRows.length - p),
    },
    residualGroups: summarizeResidualGroups(fitRows, residuals),
    annualIndex,
    internal: { coefficientsYears, coefficients, covariance },
  };
}

export function exactSuburbDeletionSensitivity(rows: RepeatSalePair[], limit = 10) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Suburb sensitivity limit must be a positive integer");
  const latestPairByProperty = new Map<string, RepeatSalePair>();
  const contributingProperties = new Set<string>();
  for (const row of rows) {
    if (yearOf(row.earlier_sold_date) !== yearOf(row.later_sold_date)) contributingProperties.add(row.property_key);
    const latest = latestPairByProperty.get(row.property_key);
    if (!latest || row.later_sold_date > latest.later_sold_date) latestPairByProperty.set(row.property_key, row);
  }
  const propertiesBySuburb = new Map<string, Set<string>>();
  for (const propertyKey of contributingProperties) {
    const suburb = latestPairByProperty.get(propertyKey)?.suburb;
    if (!suburb) throw new Error(`Missing suburb for contributing repeat-sale property ${propertyKey}`);
    const properties = propertiesBySuburb.get(suburb) ?? new Set<string>();
    properties.add(propertyKey);
    propertiesBySuburb.set(suburb, properties);
  }
  const baseline = fitRepeatSales(rows, 0);
  const largest = [...propertiesBySuburb.entries()]
    .sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]))
    .slice(0, limit);
  return largest.map(([suburb, properties]) => {
    const excluded = rows.filter((row) => properties.has(row.property_key));
    const refit = fitRepeatSales(rows.filter((row) => !properties.has(row.property_key)), 0);
    if (refit.designRank !== baseline.designRank || refit.designColumns !== baseline.designColumns) {
      throw new Error(`Removing ${suburb} made the annual repeat-sales design rank deficient`);
    }
    const estimates = baseline.annualIndex.flatMap((estimate) => {
      if (!estimate.estimable) return [];
      const comparison = refit.annualIndex.find((row) => row.year === estimate.year);
      if (!comparison?.estimable) throw new Error(`Removing ${suburb} made ${estimate.year} non-estimable`);
      return [{
        year: estimate.year,
        baselineIndex: estimate.index!,
        refitIndex: comparison.index!,
        indexDifferencePoints: comparison.index! - estimate.index!,
        baselineAnnualChangePct: estimate.annualChangePct!,
        refitAnnualChangePct: comparison.annualChangePct!,
        annualChangeDifferencePoints: comparison.annualChangePct! - estimate.annualChangePct!,
      }];
    });
    return {
      suburb,
      excludedProperties: properties.size,
      excludedPairs: excluded.length,
      refitPairs: refit.pairCount,
      refitCrossYearPairs: refit.informativeCrossYearPairCount,
      refitContributingProperties: refit.uniqueContributingProperties,
      designRank: refit.designRank,
      designColumns: refit.designColumns,
      maxAbsoluteIndexDifferencePoints: Math.max(...estimates.map((row) => Math.abs(row.indexDifferencePoints))),
      maxAbsoluteAnnualChangeDifferencePoints: Math.max(...estimates.map((row) => Math.abs(row.annualChangeDifferencePoints))),
      estimates,
    };
  });
}

export function createAnnualRepeatSalesDataset(
  pairs: RepeatSalePair[],
  medians: AnnualMedianPoint[],
  sourceSnapshotId: string,
  sourceSnapshotAt: string,
  executedAt: string,
) {
  const returnBandPairs = pairs.filter((row) => {
    const annualizedLogReturn = Math.log(row.later_price_aud / row.earlier_price_aud) * 365.25 / row.holding_days;
    return annualizedLogReturn >= Math.log(0.5) && annualizedLogReturn <= Math.log(2);
  });
  const fits = [
    { key: "repeat_sales_ols_untrimmed", label: "Untrimmed OLS", fit: fitRepeatSales(pairs, 0), criteria: "Globally consecutive serving-scope pairs; both endpoint prices AUD 50,000–20,000,000; positive holding days; no return trimming." },
    { key: "repeat_sales_ols_return_band", label: "Return-band OLS", fit: fitRepeatSales(returnBandPairs, 0), criteria: "Untrimmed eligibility plus annualised return between −50% and +100%, inclusive." },
    { key: "repeat_sales_huber", label: "Huber IRLS", fit: fitRepeatSales(pairs, 0, { robust: true }), criteria: "Untrimmed eligibility; Huber k=1.345; fixed initial OLS residual MAD scale; coefficient and weight changes <1e-8." },
  ];
  const medianByYear = new Map(medians.map((row) => [row.year, row]));
  const referenceMedian = medianByYear.get(REFERENCE_YEAR);
  if (!referenceMedian || referenceMedian.median_price_aud <= 0) throw new Error(`Annual median reference year ${REFERENCE_YEAR} is unavailable`);
  const records: Record<string, string | number | null>[] = [];
  const metadata = {
    model_version: "annual-repeat-sales-v1",
    source_snapshot_id: sourceSnapshotId,
    source_snapshot_at: sourceSnapshotAt,
    executed_at: executedAt,
    reference_year: REFERENCE_YEAR,
    reporting_window_start: REPORT_START,
    reporting_window_end: REPORT_END,
  };
  for (const { key, label, fit, criteria } of fits) {
    for (const estimate of fit.annualIndex) {
      if (!estimate.estimable) throw new Error(`${label} did not estimate year ${estimate.year}`);
      records.push({
        ...metadata,
        series_key: key,
        series_label: label,
        observation_year: estimate.year,
        index_level: estimate.index!,
        index_lower_95: estimate.indexLower95!,
        index_upper_95: estimate.indexUpper95!,
        annual_change_pct: estimate.annualChangePct!,
        annual_change_lower_95_pct: estimate.annualChangeLower95Pct!,
        annual_change_upper_95_pct: estimate.annualChangeUpper95Pct!,
        pair_count: fit.pairCount,
        identifying_pair_count: fit.informativeCrossYearPairCount,
        same_year_diagnostic_pair_count: fit.sameCalendarYearDiagnosticPairCount,
        contributing_property_count: fit.uniqueContributingProperties,
        year_identifying_pair_count: estimate.annualChangeIdentifyingPairCount!,
        year_contributing_property_count: estimate.annualChangeContributingPropertyCount!,
        sale_count: null,
        eligibility_criteria: criteria,
      });
    }
  }
  for (let year = REPORT_START; year <= REPORT_END; year++) {
    const current = medianByYear.get(year), previous = medianByYear.get(year - 1);
    if (!current || !previous || current.median_price_aud <= 0 || previous.median_price_aud <= 0) {
      throw new Error(`Annual median-price series is missing a positive price for ${year - 1} or ${year}`);
    }
    records.push({
      ...metadata,
      series_key: "annual_median_price",
      series_label: "Annual median price",
      observation_year: year,
      index_level: 100 * current.median_price_aud / referenceMedian.median_price_aud,
      index_lower_95: null,
      index_upper_95: null,
      annual_change_pct: 100 * (current.median_price_aud / previous.median_price_aud - 1),
      annual_change_lower_95_pct: null,
      annual_change_upper_95_pct: null,
      pair_count: null,
      identifying_pair_count: null,
      same_year_diagnostic_pair_count: null,
      contributing_property_count: null,
      year_identifying_pair_count: null,
      year_contributing_property_count: null,
      sale_count: current.sale_count,
      eligibility_criteria: "Existing serving-scope annual median of non-null sale prices; descriptive comparator, not a composition decomposition.",
    });
  }
  return records;
}

function roundTree(value: unknown): unknown {
  if (typeof value === "number") return Number(value.toFixed(6));
  if (Array.isArray(value)) return value.map(roundTree);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, roundTree(child)]));
  return value;
}

async function main() {
  const sql = database(sourceDatabaseUrl());
  try {
    const result = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const pairs = await tx<RepeatSalePair[]>`WITH dated_events AS (
          SELECT s.sale_event_id,s.property_id,s.sold_date,s.price_aud,s.property_type,s.bedrooms,s.bathrooms,s.car_spaces,s.land_size_sqm,
            p.suburb,p.postcode,
            (s.sold_date>=DATE '1990-01-01' AND p.postcode BETWEEN '6000' AND '6200'
              AND lower(trim(s.property_type))='house' AND nullif(trim(p.suburb),'') IS NOT NULL) AS in_serving_scope
          FROM core.sale_event s JOIN core.property p USING(property_id)
          WHERE s.sold_date IS NOT NULL
        ), sequenced AS (
          SELECT *,lag(sale_event_id) OVER property_history AS earlier_sale_event_id,
            lag(sold_date) OVER property_history AS earlier_sold_date,
            lag(price_aud) OVER property_history AS earlier_price_aud,
            lag(in_serving_scope) OVER property_history AS earlier_in_serving_scope
          FROM dated_events
          WINDOW property_history AS (PARTITION BY property_id ORDER BY sold_date,sale_event_id)
        ), candidates AS (
          SELECT encode(digest('perth-house-data:property:v1:'||property_id::text,'sha256'),'hex') AS property_key,
            suburb,postcode,property_type,bedrooms,bathrooms,car_spaces,land_size_sqm,
            earlier_sold_date,sold_date AS later_sold_date,earlier_price_aud,price_aud AS later_price_aud,
            (sold_date-earlier_sold_date)::integer AS holding_days
          FROM sequenced
          WHERE earlier_sale_event_id IS NOT NULL AND earlier_in_serving_scope AND in_serving_scope
            AND earlier_sold_date<sold_date
            AND earlier_price_aud BETWEEN 50000 AND 20000000 AND price_aud BETWEEN 50000 AND 20000000
        )
        SELECT property_key,suburb,postcode,property_type,bedrooms,bathrooms,car_spaces,land_size_sqm,
          earlier_sold_date::text,later_sold_date::text,earlier_price_aud,later_price_aud,holding_days
        FROM candidates ORDER BY earlier_sold_date,later_sold_date`;
      const propertyPopulation = await tx<PropertyProfile[]>`SELECT encode(digest('perth-house-data:property:v1:'||property_id::text,'sha256'),'hex') AS property_key,
          suburb,postcode,property_type,bedrooms,bathrooms,car_spaces,land_size_sqm
        FROM (
          SELECT DISTINCT ON (s.property_id) s.property_id,p.suburb,p.postcode,s.property_type,s.bedrooms,s.bathrooms,s.car_spaces,s.land_size_sqm
          FROM core.sale_event s JOIN core.property p USING(property_id)
          WHERE s.sold_date>=DATE '1990-01-01' AND p.postcode BETWEEN '6000' AND '6200'
            AND lower(trim(s.property_type))='house' AND nullif(trim(p.suburb),'') IS NOT NULL
            AND s.price_aud > 0
          ORDER BY s.property_id,s.sold_date DESC,s.sale_event_id DESC
        ) latest`;
      const medians = await tx<MedianYear[]>`SELECT date_part('year',s.sold_date)::int AS year,
          count(*)::int AS sale_count,
          percentile_cont(.5) WITHIN GROUP(ORDER BY s.price_aud)::double precision AS median_price_aud
        FROM core.sale_event s JOIN core.property p USING(property_id)
        WHERE s.sold_date BETWEEN DATE '2008-01-01' AND DATE '2025-12-31'
          AND s.price_aud IS NOT NULL AND s.sold_date>=DATE '1990-01-01'
          AND p.postcode BETWEEN '6000' AND '6200' AND lower(trim(s.property_type))='house'
          AND nullif(trim(p.suburb),'') IS NOT NULL
        GROUP BY 1 ORDER BY 1`;
      return { pairs: [...pairs], medians: [...medians], propertyPopulation: [...propertyPopulation] };
    });
    if (result.pairs.length !== 34682) throw new Error(`Expected 34,682 valid-price positive-hold consecutive serving-scope pairs; extracted ${result.pairs.length}`);
    const plausiblePairs = result.pairs.filter((row) => {
      const annualizedLog = Math.log(row.later_price_aud / row.earlier_price_aud) * 365.25 / row.holding_days;
      return annualizedLog >= Math.log(0.5) && annualizedLog <= Math.log(2);
    });
    if (plausiblePairs.length !== 34511) throw new Error(`Expected 34,511 pairs under the return band; selected ${plausiblePairs.length}`);
    const fits = MIN_HOLD_SENSITIVITIES.map((minimum) => fitRepeatSales(result.pairs, minimum));
    const trimmedFits = MIN_HOLD_SENSITIVITIES.map((minimum) => fitRepeatSales(plausiblePairs, minimum));
    const robustFit = fitRepeatSales(result.pairs, 0, { robust: true });
    const exactGeographicSensitivity = exactSuburbDeletionSensitivity(result.pairs);
    const primary = trimmedFits[0];
    const stable = fitRepeatSales(plausiblePairs, 0, { maxEndpointYear: 2024 });
    const stability = primary.annualIndex.filter((row) => row.estimable && row.year <= 2024).map((row) => {
      const refit = stable.annualIndex.find((candidate) => candidate.year === row.year);
      if (!refit?.estimable) return { year: row.year, estimableInRefit: false };
      return {
        year: row.year,
        fullSampleIndex: row.index,
        through2024Index: refit.index,
        indexDifferencePoints: refit.index! - row.index!,
        relativeDifferencePct: 100 * (refit.index! / row.index! - 1),
      };
    });
    const medianReference = result.medians.find((row) => row.year === REFERENCE_YEAR)?.median_price_aud;
    const medianSeries = result.medians.filter((row) => row.year >= REPORT_START && row.year <= REPORT_END).map((row) => ({
      year: row.year,
      saleCount: row.sale_count,
      medianPriceAud: row.median_price_aud,
      medianIndex2020_100: medianReference ? 100 * row.median_price_aud / medianReference : null,
      repeatSalesIndex2020_100: primary.annualIndex.find((index) => index.year === row.year)?.index ?? null,
    }));
    const namedFits = [
      { name: "Untrimmed OLS", fit: fits[0] },
      { name: "Return-band OLS", fit: trimmedFits[0] },
      { name: "Untrimmed Huber IRLS", fit: robustFit },
    ];
    const annualModelComparison = Array.from({ length: REPORT_END - REPORT_START + 1 }, (_, offset) => REPORT_START + offset).map((year) => {
      const row: Record<string, unknown> = { year };
      for (const { name, fit } of namedFits) {
        const estimate = fit.annualIndex.find((item) => item.year === year);
        row[name] = estimate?.estimable ? {
          index: estimate.index, indexLower95: estimate.indexLower95, indexUpper95: estimate.indexUpper95,
          annualChangePct: estimate.annualChangePct,
          annualChangeLower95Pct: estimate.annualChangeLower95Pct,
          annualChangeUpper95Pct: estimate.annualChangeUpper95Pct,
        } : null;
      }
      return row;
    });
    const modelDiagnostics = namedFits.map(({ name, fit }) => {
      const { internal: _internal, annualIndex: _annualIndex, ...diagnostics } = fit;
      void _internal;
      void _annualIndex;
      return { name, ...diagnostics };
    });
    const sensitivitySummary = (name: string, fit: ReturnType<typeof fitRepeatSales>) => ({
      name,
      minHoldingDays: fit.minHoldingDays,
      pairCount: fit.pairCount,
      informativeCrossYearPairCount: fit.informativeCrossYearPairCount,
      sameCalendarYearDiagnosticPairCount: fit.sameCalendarYearDiagnosticPairCount,
      uniqueContributingProperties: fit.uniqueContributingProperties,
      designRank: fit.designRank,
      designColumns: fit.designColumns,
      designConditionNumber: fit.designConditionNumber,
      residualDiagnostics: fit.residualDiagnostics,
      selectedAnnualIndex: fit.annualIndex.filter((row) => row.estimable && (row.year === 2009 || row.year >= 2020)),
    });
    console.log(JSON.stringify(roundTree({
      methodology: {
        models: [
          "Unweighted OLS on all valid-price positive-holding globally consecutive serving-scope pairs",
          "Unweighted OLS on the existing -50% to +100% annualized-return-selected pairs",
          "Huber IRLS on all valid-price positive-holding pairs, Huber k=1.345",
        ],
        equation: "ln(P_later/P_earlier) = sum_y beta_y * (I(later year=y) - I(earlier year=y)) + error",
        untrimmedPopulation: "positive prices in AUD 50,000-20,000,000 and positive holding days; globally consecutive events sequenced before scope and price filters",
        returnSelectedPopulation: "untrimmed population additionally restricted to annualized return between -50% and +100%",
        referenceYear: REFERENCE_YEAR,
        headlineWindow: `${REPORT_START}-${REPORT_END}`,
        outsideWindowHandling: "2005-2008 and partial 2026 have explicit year terms as nuisance effects; 2026 is not reported in the headline index",
        sameCalendarYearHandling: "Retained in descriptive residual diagnostics, but excluded from coefficient fitting, property-cluster sandwich scores, and CR1 pair-count degrees-of-freedom corrections because their design vectors are exactly zero",
        temporalStability: "Refit with all pairs ending after 2024 removed; compare 2009-2024 annual levels",
        indexComparisonCaution: "Annual median-price index is descriptive and not a causal/composition decomposition",
      },
      pairPopulation: {
        untrimmedPairCount: result.pairs.length,
        returnBandSelectedPairCount: plausiblePairs.length,
        returnBandExcludedPairs: result.pairs.length - plausiblePairs.length,
      },
      annualModelComparison,
      modelDiagnostics,
      annualMedianComparison: medianSeries,
      untrimmedPropertyComposition: compositionComparison(result.pairs, result.propertyPopulation),
      holdingPeriodSensitivities: {
        untrimmed: fits.map((fit) => sensitivitySummary("Untrimmed OLS", fit)),
        returnBandSelected: trimmedFits.map((fit) => sensitivitySummary("Return-band OLS", fit)),
      },
      stabilityCheck: {
        excludedSampleRule: "Pairs with later endpoint in 2025 or 2026 are excluded; effects outside 2009-2024 remain explicitly modeled.",
        refitPairCount: stable.pairCount,
        refitUniqueContributingProperties: stable.uniqueContributingProperties,
        refitDesignRank: stable.designRank,
        refitDesignColumns: stable.designColumns,
        estimates: stability,
      },
      exactGeographicSensitivity: {
        propertyAssignment: "Each informative repeat-sale property is assigned to the suburb on its latest qualifying later-sale endpoint; all of that property's pairs are removed for the exact refit.",
        largestContributingSuburbs: exactGeographicSensitivity,
      },
    }), null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
