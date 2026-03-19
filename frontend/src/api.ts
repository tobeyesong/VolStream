import type { Instrument, SurfacePoint, SurfaceSnapshot } from './types'

type ApiInstrument = {
  ticker: string
  name: string
  exchange: string
  instrument_type: string
}

type ApiSurfacePoint = {
  strike: number
  moneyness: number
  time_to_expiry: number
  implied_vol: number
  option_price: number
  expiration_date: string
  contract_symbol: string | null
  bid: number | null
  ask: number | null
  last_price: number | null
  volume: number | null
  open_interest: number | null
  last_trade_time: string | null
  delta: number | null
  gamma: number | null
}

type ApiSurfaceSnapshot = {
  ticker: string
  spot_price: number
  timestamp_ms: number
  expirations: string[]
  points: ApiSurfacePoint[]
}

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL)

function normalizeApiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (!trimmed || trimmed === '/') {
    return ''
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function buildApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return API_BASE_URL ? `${API_BASE_URL}${normalizedPath}` : normalizedPath
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    headers: {
      Accept: 'application/json',
    },
    signal,
  })

  if (!response.ok) {
    let message = `Request failed with ${response.status}`
    try {
      const payload = (await response.json()) as { detail?: string }
      if (payload.detail) {
        message = payload.detail
      }
    } catch {
      // Fall back to the generic message if the payload is not JSON.
    }
    throw new Error(message)
  }

  return (await response.json()) as T
}

function mapInstrument(instrument: ApiInstrument): Instrument {
  return {
    ticker: instrument.ticker,
    name: instrument.name,
    exchange: instrument.exchange,
    instrumentType: instrument.instrument_type,
  }
}

function mapPoint(point: ApiSurfacePoint): SurfacePoint {
  return {
    strike: point.strike,
    moneyness: point.moneyness,
    timeToExpiry: point.time_to_expiry,
    impliedVol: point.implied_vol,
    optionPrice: point.option_price,
    expirationDate: point.expiration_date,
    contractSymbol: point.contract_symbol,
    bid: point.bid,
    ask: point.ask,
    lastPrice: point.last_price,
    volume: point.volume,
    openInterest: point.open_interest,
    lastTradeTime: point.last_trade_time,
    delta: point.delta,
    gamma: point.gamma,
  }
}

function mapSnapshot(snapshot: ApiSurfaceSnapshot): SurfaceSnapshot {
  return {
    ticker: snapshot.ticker,
    spotPrice: snapshot.spot_price,
    timestampMs: snapshot.timestamp_ms,
    expirations: snapshot.expirations,
    points: snapshot.points.map(mapPoint),
  }
}

export async function fetchConfiguredInstruments(signal?: AbortSignal): Promise<Instrument[]> {
  const instruments = await getJson<ApiInstrument[]>('/api/instruments', signal)
  return instruments.map(mapInstrument)
}

export async function fetchSurface(ticker: string, signal?: AbortSignal): Promise<SurfaceSnapshot> {
  const snapshot = await getJson<ApiSurfaceSnapshot>(`/api/surface/${ticker}`, signal)
  return mapSnapshot(snapshot)
}

export async function searchInstruments(
  query: string,
  limit = 8,
  signal?: AbortSignal,
): Promise<Instrument[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  })
  const instruments = await getJson<ApiInstrument[]>(`/api/instruments/search?${params.toString()}`, signal)
  return instruments.map(mapInstrument)
}
