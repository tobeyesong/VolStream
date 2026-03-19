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
  return snapshot.points
    .filter((point) => point.expirationDate === frontExpiry)
    .sort((left, right) => left.moneyness - right.moneyness)
    .map((point) => ({
      label: `${(point.moneyness * 100).toFixed(0)}%`,
      x: point.moneyness,
      y: point.impliedVol,
    }))
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
