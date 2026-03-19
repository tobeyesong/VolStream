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
}

type ApiSurfaceSnapshot = {
  ticker: string
  spot_price: number
  timestamp_ms: number
  expirations: string[]
  points: ApiSurfacePoint[]
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
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
