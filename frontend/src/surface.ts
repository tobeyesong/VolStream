import type { CurvePoint, HeatmapMatrix, SurfacePoint, SurfaceSnapshot, SurfaceSummary } from './types'

const DEFAULT_BUCKET_COUNT = 10
const MAX_SCENE_POINTS = 240

function getFrontExpiry(points: SurfacePoint[]): string {
  return [...new Set(points.map((point) => point.expirationDate))].sort()[0] ?? ''
}

function getClosestAtmPoint(points: SurfacePoint[]): SurfacePoint | null {
  if (points.length === 0) {
    return null
  }

  return [...points].sort(
    (left, right) => Math.abs(left.moneyness - 1) - Math.abs(right.moneyness - 1),
  )[0]
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
    : sorted[midpoint]!
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function bucketCurvePoints(points: CurvePoint[], minBuckets = 10, maxBuckets = 18): CurvePoint[] {
  if (points.length <= maxBuckets) {
    return points
  }

  const xMin = Math.min(...points.map((point) => point.x))
  const xMax = Math.max(...points.map((point) => point.x))
  const span = Math.max(xMax - xMin, 0.0001)
  const bucketCount = clamp(Math.round(Math.sqrt(points.length) * 1.5), minBuckets, maxBuckets)
  const buckets: CurvePoint[][] = Array.from({ length: bucketCount }, () => [])

  for (const point of points) {
    const ratio = (point.x - xMin) / span
    const bucketIndex = clamp(Math.floor(ratio * bucketCount), 0, bucketCount - 1)
    buckets[bucketIndex]!.push(point)
  }

  return buckets
    .filter((bucket) => bucket.length > 0)
    .map((bucket) => {
      const x = median(bucket.map((point) => point.x))
      const y = median(bucket.map((point) => point.y))
      return {
        label: bucket[Math.floor(bucket.length / 2)]!.label,
        x,
        y,
      }
    })
}

function buildSkewCurve(points: SurfacePoint[]): CurvePoint[] {
  const rawCurve = [...points]
    .sort((left, right) => left.moneyness - right.moneyness)
    .map((point) => ({
      label: `${(point.moneyness * 100).toFixed(0)}%`,
      x: point.moneyness,
      y: point.impliedVol,
    }))

  return bucketCurvePoints(rawCurve)
}

function getNearestByMoneyness(points: SurfacePoint[], targetMoneyness: number, tolerance = 0.045): SurfacePoint | null {
  if (points.length === 0) {
    return null
  }

  const nearest = [...points].sort(
    (left, right) => Math.abs(left.moneyness - targetMoneyness) - Math.abs(right.moneyness - targetMoneyness),
  )[0]

  if (!nearest || Math.abs(nearest.moneyness - targetMoneyness) > tolerance) {
    return null
  }

  return nearest
}

export function buildSurfaceSummary(snapshot: SurfaceSnapshot): SurfaceSummary {
  const frontExpiry = getFrontExpiry(snapshot.points)
  const frontPoints = snapshot.points.filter((point) => point.expirationDate === frontExpiry)
  const frontAtmPoint = getClosestAtmPoint(frontPoints)
  const termStructure = buildTermStructure(snapshot)
  const termSlope = termStructure.length > 1 ? termStructure.at(-1)!.y - termStructure[0].y : 0

  let narrative = 'Short-dated and longer-dated volatility are priced in a fairly balanced way.'
  if (termSlope > 0.04) {
    narrative = 'Longer-dated implied volatility is priced above the front month, suggesting a firmer back end.'
  } else if (termSlope < -0.04) {
    narrative = 'Front-month implied volatility is elevated versus later expiries, which usually points to near-term event risk.'
  }

  return {
    frontExpiry,
    frontAtmIv: frontAtmPoint?.impliedVol ?? 0,
    pointCount: snapshot.points.length,
    expiryCount: snapshot.expirations.length,
    narrative,
  }
}

export function buildHeatmap(snapshot: SurfaceSnapshot, bucketCount = DEFAULT_BUCKET_COUNT): HeatmapMatrix {
  if (snapshot.points.length === 0) {
    return {
      expiries: [],
      moneynessLabels: [],
      cells: [],
      minIv: 0,
      maxIv: 0,
    }
  }

  const expiries = [...snapshot.expirations].sort().slice(0, 6)
  const selectedPoints = snapshot.points.filter((point) => expiries.includes(point.expirationDate))
  const moneynessValues = selectedPoints.map((point) => point.moneyness)
  const ivValues = selectedPoints.map((point) => point.impliedVol)
  const minMoneyness = Math.min(...moneynessValues)
  const maxMoneyness = Math.max(...moneynessValues)
  const minIv = Math.min(...ivValues)
  const maxIv = Math.max(...ivValues)
  const step = bucketCount > 1 ? (maxMoneyness - minMoneyness) / (bucketCount - 1) : 0
  const bucketLabels = Array.from({ length: bucketCount }, (_, index) => {
    const value = minMoneyness + step * index
    return `${(value * 100).toFixed(0)}%`
  })

  const buckets: number[][][] = Array.from({ length: bucketCount }, () =>
    Array.from({ length: expiries.length }, () => [] as number[]),
  )

  for (const point of selectedPoints) {
    const expiryIndex = expiries.indexOf(point.expirationDate)
    if (expiryIndex === -1) {
      continue
    }
    const bucketIndex =
      step <= 0
        ? 0
        : Math.max(0, Math.min(bucketCount - 1, Math.round((point.moneyness - minMoneyness) / step)))
    buckets[bucketIndex][expiryIndex].push(point.impliedVol)
  }

  return {
    expiries,
    moneynessLabels: bucketLabels,
    cells: buckets.map((row) => row.map((cell) => (cell.length ? average(cell) : null))),
    minIv,
    maxIv,
  }
}

export function buildTermStructure(snapshot: SurfaceSnapshot): CurvePoint[] {
  return [...snapshot.expirations]
    .sort()
    .map((expirationDate) => {
      const points = snapshot.points.filter((point) => point.expirationDate === expirationDate)
      const atmPoint = getClosestAtmPoint(points)
      return atmPoint
        ? {
            label: expirationDate.slice(5),
            x: atmPoint.timeToExpiry,
            y: atmPoint.impliedVol,
          }
        : null
    })
    .filter((point): point is CurvePoint => point !== null)
}

export function buildFrontExpirySkew(snapshot: SurfaceSnapshot): CurvePoint[] {
  const frontExpiry = getFrontExpiry(snapshot.points)
  return buildSkewForExpiry(snapshot, frontExpiry)
}

export function buildSkewForExpiry(snapshot: SurfaceSnapshot, expirationDate: string): CurvePoint[] {
  return buildSkewCurve(snapshot.points.filter((point) => point.expirationDate === expirationDate))
}

export function buildTermStructureForMoneyness(
  snapshot: SurfaceSnapshot,
  targetMoneyness: number,
  tolerance = 0.045,
): CurvePoint[] {
  return [...snapshot.expirations]
    .sort()
    .map((expirationDate) => {
      const points = snapshot.points.filter((point) => point.expirationDate === expirationDate)
      const nearestPoint = getNearestByMoneyness(points, targetMoneyness, tolerance)
      return nearestPoint
        ? {
            label: expirationDate.slice(5),
            x: nearestPoint.timeToExpiry,
            y: nearestPoint.impliedVol,
          }
        : null
    })
    .filter((point): point is CurvePoint => point !== null)
}

export function buildNotableContracts(snapshot: SurfaceSnapshot): SurfacePoint[] {
  return [...snapshot.points]
    .sort((left, right) => right.impliedVol - left.impliedVol)
    .slice(0, 6)
}

export function sampleScenePoints(points: SurfacePoint[]): SurfacePoint[] {
  if (points.length <= MAX_SCENE_POINTS) {
    return points
  }

  const step = points.length / MAX_SCENE_POINTS
  return Array.from({ length: MAX_SCENE_POINTS }, (_, index) => points[Math.floor(index * step)])
}
