export type Instrument = {
  ticker: string
  name: string
  exchange: string
  instrumentType: string
}

export type SurfacePoint = {
  strike: number
  moneyness: number
  timeToExpiry: number
  impliedVol: number
  optionPrice: number
  expirationDate: string
  contractSymbol: string | null
  bid: number | null
  ask: number | null
  lastPrice: number | null
  volume: number | null
  openInterest: number | null
  lastTradeTime: string | null
  delta: number | null
  gamma: number | null
}

export type SurfaceHoverPoint = SurfacePoint & {
  ivChange: number | null
}

export type SurfaceSnapshot = {
  ticker: string
  spotPrice: number
  timestampMs: number
  expirations: string[]
  points: SurfacePoint[]
}

export type SurfaceSummary = {
  frontExpiry: string
  frontAtmIv: number
  pointCount: number
  expiryCount: number
  narrative: string
}

export type HeatmapMatrix = {
  expiries: string[]
  moneynessLabels: string[]
  cells: Array<Array<number | null>>
  minIv: number
  maxIv: number
}

export type CurvePoint = {
  label: string
  x: number
  y: number
}
