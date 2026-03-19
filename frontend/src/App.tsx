import {
  Fragment,
  Suspense,
  lazy,
  startTransition,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { createPortal } from 'react-dom'

import { fetchConfiguredInstruments, fetchSurface, searchInstruments } from './api'
import {
  buildFrontExpirySkew,
  buildHeatmap,
  buildNotableContracts,
  buildSurfaceSummary,
  buildTermStructure,
  sampleScenePoints,
} from './surface'
import type { CurvePoint, HeatmapMatrix, Instrument, SurfacePoint, SurfaceSnapshot } from './types'

const POLL_INTERVAL_MS = 30_000
const SurfaceScene = lazy(() =>
  import('./components/SurfaceScene').then((module) => ({
    default: module.SurfaceScene,
  })),
)

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value)
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatTimestamp(timestampMs: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestampMs)
}

function heatmapColor(value: number | null, min: number, max: number): string {
  if (value === null) {
    return 'rgba(138, 166, 173, 0.08)'
  }

  const span = Math.max(max - min, 0.001)
  const ratio = (value - min) / span
  const hue = 196 - ratio * 165
  const alpha = 0.22 + ratio * 0.58
  return `hsla(${hue} 82% 58% / ${alpha})`
}

function scrollToSection(sectionId: string) {
  document.getElementById(sectionId)?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  })
}

function findMatchingInstrument(query: string, instruments: Instrument[]): Instrument | null {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return null
  }

  return (
    instruments.find((instrument) => {
      const ticker = instrument.ticker.toLowerCase()
      const name = instrument.name.toLowerCase()
      return ticker === normalized || name === normalized || name.includes(normalized)
    }) ?? null
  )
}

function selectInstrument(
  instrument: Instrument,
  setSelectedTicker: (ticker: string) => void,
  setSearchQuery: (query: string) => void,
  setSearchFocused: (focused: boolean) => void,
  setHoveredPoint: (point: SurfacePoint | null) => void,
) {
  setSelectedTicker(instrument.ticker)
  setSearchQuery('')
  setSearchFocused(false)
  setHoveredPoint(null)
}

type SearchOverlayRect = {
  left: number
  top: number
  width: number
  maxHeight: number
}

function SearchOverlay({
  visible,
  rect,
  busy,
  results,
  suggestionsReady,
  onClose,
  onSelect,
}: {
  visible: boolean
  rect: SearchOverlayRect | null
  busy: boolean
  results: Instrument[]
  suggestionsReady: boolean
  onClose: () => void
  onSelect: (instrument: Instrument) => void
}) {
  if (!visible || !rect || typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div
      className="search-overlay"
      onMouseDown={onClose}
      role="presentation"
    >
      <div className="search-overlay-backdrop" />
      <div
        id="ticker-search-results"
        aria-label="Search results"
        className="search-overlay-panel search-results"
        onMouseDown={(event) => event.stopPropagation()}
        role="listbox"
        style={{
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          maxHeight: `${rect.maxHeight}px`,
        }}
      >
        {busy ? <div className="search-state">Searching live instruments...</div> : null}
        {!busy && results.length > 0
          ? results.map((instrument) => (
              <button
                key={instrument.ticker}
                className="search-result"
                onMouseDown={() => onSelect(instrument)}
                type="button"
              >
                <span>
                  <strong>{instrument.ticker}</strong>
                  <small>{instrument.name}</small>
                </span>
                <em>{instrument.exchange || instrument.instrumentType || 'Market data'}</em>
              </button>
            ))
          : null}
        {!busy && results.length === 0 && !suggestionsReady ? (
          <div className="search-state">Loading search suggestions...</div>
        ) : null}
        {!busy && suggestionsReady && results.length === 0 ? (
          <div className="search-state">No instruments found for that query.</div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="stat-card">
      <span className="eyebrow">{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  )
}

function LineChart({
  title,
  subtitle,
  points,
  valueFormatter,
  className = '',
}: {
  title: string
  subtitle: string
  points: CurvePoint[]
  valueFormatter: (value: number) => string
  className?: string
}) {
  const cardClassName = ['card', 'detail-card', className].filter(Boolean).join(' ')

  if (points.length < 2) {
    return (
      <article className={cardClassName}>
        <div className="card-header">
          <div>
            <span className="eyebrow">{title}</span>
            <h3>{subtitle}</h3>
          </div>
        </div>
        <div className="empty-panel">Need more valid option points to draw this curve.</div>
      </article>
    )
  }

  const width = 320
  const height = 180
  const padding = 18
  const xMin = Math.min(...points.map((point) => point.x))
  const xMax = Math.max(...points.map((point) => point.x))
  const yMin = Math.min(...points.map((point) => point.y))
  const yMax = Math.max(...points.map((point) => point.y))
  const scaleX = (value: number) =>
    padding + ((value - xMin) / Math.max(xMax - xMin, 0.001)) * (width - padding * 2)
  const scaleY = (value: number) =>
    height - padding - ((value - yMin) / Math.max(yMax - yMin, 0.001)) * (height - padding * 2)
  const polyline = points.map((point) => `${scaleX(point.x)},${scaleY(point.y)}`).join(' ')
  const latestPoint = points[points.length - 1]!
  const areaPoints = [
    `${scaleX(points[0].x)},${height - padding}`,
    polyline,
    `${scaleX(latestPoint.x)},${height - padding}`,
  ].join(' ')
  const gradientId = `${title}-${subtitle}`.toLowerCase().replace(/\s+/g, '-')

  return (
    <article className={cardClassName}>
      <div className="card-header">
        <div>
          <span className="eyebrow">{title}</span>
          <h3>{subtitle}</h3>
        </div>
      </div>
      <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={subtitle}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon className="line-chart-area" fill={`url(#${gradientId})`} points={areaPoints} />
        <polyline className="line-chart-path" points={polyline} />
        {points.map((point) => (
          <circle
            key={`${title}-${point.label}`}
            className="line-chart-dot"
            cx={scaleX(point.x)}
            cy={scaleY(point.y)}
            r="4"
          />
        ))}
      </svg>
      <div className="line-chart-footer">
        <span>{points[0].label}</span>
        <span>{valueFormatter(latestPoint.y)}</span>
      </div>
    </article>
  )
}

function App() {
  const [configuredInstruments, setConfiguredInstruments] = useState<Instrument[]>([])
  const [selectedTicker, setSelectedTicker] = useState('AAPL')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Instrument[]>([])
  const [searchFocused, setSearchFocused] = useState(false)
  const [searchBusy, setSearchBusy] = useState(false)
  const [surface, setSurface] = useState<SurfaceSnapshot | null>(null)
  const [surfaceError, setSurfaceError] = useState<string | null>(null)
  const [surfaceLoading, setSurfaceLoading] = useState(false)
  const [hoveredPoint, setHoveredPoint] = useState<SurfacePoint | null>(null)
  const [searchOverlayRect, setSearchOverlayRect] = useState<SearchOverlayRect | null>(null)
  const searchWrapRef = useRef<HTMLDivElement | null>(null)
  const deferredQuery = useDeferredValue(searchQuery.trim())

  useEffect(() => {
    const controller = new AbortController()

    async function loadConfiguredInstruments() {
      try {
        const instruments = await fetchConfiguredInstruments(controller.signal)
        setConfiguredInstruments(instruments)
        setSearchResults(instruments.slice(0, 6))
        setSelectedTicker((currentTicker) =>
          instruments.length > 0 && !instruments.some((instrument) => instrument.ticker === currentTicker)
            ? instruments[0].ticker
            : currentTicker,
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }
        setSurfaceError(error instanceof Error ? error.message : 'Unable to load configured instruments.')
      }
    }

    void loadConfiguredInstruments()

    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!deferredQuery) {
      setSearchBusy(false)
      setSearchResults(configuredInstruments.slice(0, 6))
      return
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(async () => {
      setSearchBusy(true)
      try {
        const results = await searchInstruments(deferredQuery, 8, controller.signal)
        setSearchResults(results)
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setSearchResults([])
        }
      } finally {
        setSearchBusy(false)
      }
    }, 180)

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [configuredInstruments, deferredQuery])

  useLayoutEffect(() => {
    if (!searchFocused) {
      setSearchOverlayRect(null)
      return
    }

    const updateOverlayRect = () => {
      const element = searchWrapRef.current
      if (!element) {
        return
      }

      const rect = element.getBoundingClientRect()
      const width = Math.min(rect.width, window.innerWidth - 32)
      const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))
      const top = Math.max(16, Math.min(rect.bottom + 12, window.innerHeight - 196))
      const maxHeight = Math.max(220, window.innerHeight - top - 16)

      setSearchOverlayRect({
        left,
        top,
        width,
        maxHeight,
      })
    }

    updateOverlayRect()
    window.addEventListener('resize', updateOverlayRect)
    window.addEventListener('scroll', updateOverlayRect, true)

    return () => {
      window.removeEventListener('resize', updateOverlayRect)
      window.removeEventListener('scroll', updateOverlayRect, true)
    }
  }, [searchFocused, searchQuery, searchResults.length, searchBusy, configuredInstruments.length])

  useEffect(() => {
    let active = true

    async function loadSurface(isInitialLoad: boolean) {
      if (isInitialLoad) {
        setSurfaceLoading(true)
      }

      try {
        const nextSurface = await fetchSurface(selectedTicker)
        if (!active) {
          return
        }
        startTransition(() => {
          setSurface(nextSurface)
          setSurfaceError(null)
          setHoveredPoint(null)
        })
      } catch (error) {
        if (!active) {
          return
        }
        setSurfaceError(error instanceof Error ? error.message : 'Unable to load the surface.')
      } finally {
        if (active && isInitialLoad) {
          setSurfaceLoading(false)
        }
      }
    }

    void loadSurface(true)
    const intervalId = window.setInterval(() => {
      void loadSurface(false)
    }, POLL_INTERVAL_MS)

    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [selectedTicker])

  const activeInstrument =
    configuredInstruments.find((instrument) => instrument.ticker === selectedTicker) ??
    searchResults.find((instrument) => instrument.ticker === selectedTicker) ??
    null

  const summary = surface ? buildSurfaceSummary(surface) : null
  const heatmap = surface ? buildHeatmap(surface) : null
  const termStructure = surface ? buildTermStructure(surface) : []
  const frontSkew = surface ? buildFrontExpirySkew(surface) : []
  const notableContracts = surface ? buildNotableContracts(surface) : []
  const scenePoints = surface ? sampleScenePoints(surface.points) : []
  const searchPanelVisible = searchFocused
  const heroStatus = surfaceError
    ? 'Live feed temporarily unavailable.'
    : surfaceLoading
      ? 'Loading the latest chain...'
      : 'Live data refreshes every 30 seconds.'

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = searchQuery.trim()

    if (!query) {
      setSearchFocused(false)
      scrollToSection('surface-lab')
      return
    }

    const candidate =
      findMatchingInstrument(query, searchResults) ??
      findMatchingInstrument(query, configuredInstruments) ??
      null

    if (candidate) {
      selectInstrument(candidate, setSelectedTicker, setSearchQuery, setSearchFocused, setHoveredPoint)
      window.requestAnimationFrame(() => {
        scrollToSection('surface-lab')
      })
      return
    }

    setSearchFocused(false)
    scrollToSection('surface-lab')
  }

  function handleSearchSelect(instrument: Instrument) {
    selectInstrument(instrument, setSelectedTicker, setSearchQuery, setSearchFocused, setHoveredPoint)
    window.requestAnimationFrame(() => {
      scrollToSection('surface-lab')
    })
  }

  return (
    <div className="app-shell">
      <aside className="primary-rail">
        <div className="rail-stack">
          <div className="brand-lockup">
            <span className="brand-mark">V</span>
            <div>
              <span className="brand-name">VolStream</span>
              <p>Live volatility desk</p>
            </div>
          </div>

          <section className="rail-status card">
            <span className="eyebrow">Selected</span>
            <strong>{selectedTicker}</strong>
            <p>{surface ? `Updated ${formatTimestamp(surface.timestampMs)}` : 'Waiting for live surface'}</p>
          </section>

          <nav className="rail-nav" aria-label="Primary">
            <a className="active" href="#overview">
              Overview
            </a>
            <a href="#surface-lab">Surface Lab</a>
            <a href="#contracts">Richest Contracts</a>
          </nav>
        </div>

        <div className="rail-footer">
          <span>Yahoo Finance source</span>
          <span>30s poll</span>
        </div>
      </aside>

      <main className="app-frame">
        <section className="hero-panel" id="overview">
          <div className="hero-copy">
            <span className="eyebrow">Live volatility desk</span>
            <h1>Read the market&apos;s volatility surface.</h1>
            <p className="hero-copy-text">
              Search a ticker, then inspect the live chain by expiry, moneyness, and the contracts carrying the
              richest implied volatility.
            </p>

            <form className={`hero-search ${searchPanelVisible ? 'hero-search-open' : ''}`} onSubmit={handleSearchSubmit}>
              <label className="search-label" htmlFor="ticker-search">
                Search ticker or company
              </label>
              <div className="search-row">
                <div ref={searchWrapRef} className={`search-wrap ${searchPanelVisible ? 'search-wrap-open' : ''}`}>
                  <input
                    id="ticker-search"
                    autoComplete="off"
                    className="search-input"
                    aria-expanded={searchPanelVisible}
                    aria-haspopup="listbox"
                    aria-controls="ticker-search-results"
                    onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onFocus={() => setSearchFocused(true)}
                    placeholder="AAPL, SPY, Tesla, Apple..."
                    value={searchQuery}
                  />
                </div>
                <button className="primary-button" type="submit">
                  Inspect surface
                </button>
              </div>
            </form>

            <p className={`hero-note ${surfaceError ? 'hero-note-error' : ''}`}>{heroStatus}</p>

            <div className="hero-pill-group">
              <span className="hero-pill">Ticker {selectedTicker}</span>
              <span className="hero-pill">{surface ? `Updated ${formatTimestamp(surface.timestampMs)}` : 'Awaiting snapshot'}</span>
              {summary?.frontExpiry ? <span className="hero-pill">Front expiry {summary.frontExpiry}</span> : null}
            </div>
          </div>

          <aside className="hero-aside card">
            <span className="eyebrow">Current snapshot</span>
            <h3>{activeInstrument ? activeInstrument.name : selectedTicker}</h3>
            <p className="selection-copy">
              {activeInstrument?.exchange ? `${activeInstrument.exchange} · ` : ''}
              {activeInstrument?.instrumentType ?? 'Yahoo Finance option chain'}
            </p>

            <div className="info-stack">
              <div>
                <span>Spot</span>
                <strong>{surface ? formatCurrency(surface.spotPrice) : '—'}</strong>
              </div>
              <div>
                <span>Front ATM IV</span>
                <strong>{summary ? formatPercent(summary.frontAtmIv) : '—'}</strong>
              </div>
              <div>
                <span>Expiries</span>
                <strong>{summary ? String(summary.expiryCount) : '—'}</strong>
              </div>
              <div>
                <span>Surface points</span>
                <strong>{summary ? String(summary.pointCount) : '—'}</strong>
              </div>
            </div>

            <p className="hero-aside-note">
              {summary?.narrative ?? 'Select a ticker to generate the surface brief.'}
            </p>
          </aside>
        </section>

        <section className="stats-grid">
          <StatCard
            detail="Underlying last trade"
            label="Spot price"
            value={surface ? formatCurrency(surface.spotPrice) : '—'}
          />
          <StatCard
            detail={summary?.frontExpiry ? `Closest to ATM in ${summary.frontExpiry}` : 'Waiting for front expiry'}
            label="Front ATM IV"
            value={summary ? formatPercent(summary.frontAtmIv) : '—'}
          />
          <StatCard
            detail="Distinct expiration buckets"
            label="Expiries"
            value={summary ? String(summary.expiryCount) : '—'}
          />
          <StatCard
            detail="Filtered option contracts in view"
            label="Surface points"
            value={summary ? String(summary.pointCount) : '—'}
          />
        </section>

        {surfaceError ? <section className="error-banner">{surfaceError}</section> : null}

        <section className="content-grid">
          <div className="main-column">
            <section className="dashboard-grid">
              <article className="card card-wide surface-card" id="surface-lab">
                <div className="card-header">
                  <div>
                    <span className="eyebrow">Surface overview</span>
                    <h3>Heatmap by expiry and moneyness</h3>
                  </div>
                  <span className="hero-pill">Primary read</span>
                </div>
                {surfaceLoading || !surface || !heatmap ? (
                  <div className="empty-panel">Loading the current option surface...</div>
                ) : (
                  <Heatmap heatmap={heatmap} />
                )}
                <div className="surface-footnote">
                  <span>{summary?.narrative ?? 'The heatmap anchors the read before you inspect the 3D scene.'}</span>
                  <span>{heatmap ? `IV range ${formatPercent(heatmap.minIv)} to ${formatPercent(heatmap.maxIv)}` : 'Awaiting snapshot'}</span>
                </div>
              </article>

              <LineChart
                className="span-6"
                points={frontSkew}
                subtitle="Front-month skew"
                title="Skew"
                valueFormatter={formatPercent}
              />

              <LineChart
                className="span-6"
                points={termStructure}
                subtitle="ATM term structure"
                title="Term"
                valueFormatter={formatPercent}
              />

              <article className="card span-7 scene-card" id="surface-scene">
                <div className="card-header">
                  <div>
                    <span className="eyebrow">Surface lab</span>
                    <h3>Interactive 3D view</h3>
                  </div>
                  <span className="hero-pill">Orbit and inspect</span>
                </div>
                <div className="scene-frame">
                  {scenePoints.length === 0 ? (
                    <div className="empty-panel">No 3D points available for this surface.</div>
                  ) : (
                    <Suspense fallback={<div className="empty-panel">Loading the 3D surface lab...</div>}>
                      <SurfaceScene onHoverPoint={setHoveredPoint} points={scenePoints} />
                    </Suspense>
                  )}
                </div>
              </article>

              <article className="card span-5" id="contracts">
                <div className="card-header">
                  <div>
                    <span className="eyebrow">Richest contracts</span>
                    <h3>Highest implied vols in the current surface</h3>
                  </div>
                </div>
                {notableContracts.length === 0 ? (
                  <div className="empty-panel">No contracts available in the current surface.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Expiry</th>
                          <th>Strike</th>
                          <th>Moneyness</th>
                          <th>IV</th>
                          <th>Mid price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {notableContracts.map((point) => (
                          <tr key={`${point.expirationDate}-${point.strike}`}>
                            <td>{point.expirationDate}</td>
                            <td>{point.strike.toFixed(2)}</td>
                            <td>{(point.moneyness * 100).toFixed(1)}%</td>
                            <td>{formatPercent(point.impliedVol)}</td>
                            <td>{formatCurrency(point.optionPrice)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </article>

              <section className="card card-wide page-cta">
                <div>
                  <span className="eyebrow">Next move</span>
                  <h3>Inspect another surface and compare the shape.</h3>
                  <p>Keep the same read path: spot, skew, term structure, then the richest contracts.</p>
                </div>
                <a className="primary-button" href="#ticker-search">
                  Inspect another surface
                </a>
              </section>
            </section>
          </div>

          <aside className="secondary-panel">
            <section className="card">
              <span className="eyebrow">How to read this</span>
              <h3>Three quick rules</h3>
              <ul className="rule-list">
                <li>Higher cells or points mean the market is implying more future volatility.</li>
                <li>Moneyness near 100% is closest to at-the-money.</li>
                <li>Start with the heatmap, then use the 3D scene to isolate shape and outliers.</li>
              </ul>
            </section>

            <section className="card">
              <span className="eyebrow">Selection</span>
              <h3>{selectedTicker}</h3>
              <p className="selection-copy">{activeInstrument?.name ?? 'Yahoo Finance live option chain'}</p>
              <div className="info-stack">
                <div>
                  <span>Source</span>
                  <strong>Yahoo Finance</strong>
                </div>
                <div>
                  <span>Refresh</span>
                  <strong>30s UI poll</strong>
                </div>
                <div>
                  <span>View</span>
                  <strong>Heatmap + R3F</strong>
                </div>
              </div>
            </section>

            <section className="card">
              <span className="eyebrow">Hovered point</span>
              <h3>
                {hoveredPoint ? `${hoveredPoint.expirationDate} @ ${hoveredPoint.strike.toFixed(2)}` : 'Move over the 3D scene'}
              </h3>
              {hoveredPoint ? (
                <div className="info-stack">
                  <div>
                    <span>Moneyness</span>
                    <strong>{(hoveredPoint.moneyness * 100).toFixed(1)}%</strong>
                  </div>
                  <div>
                    <span>Implied vol</span>
                    <strong>{formatPercent(hoveredPoint.impliedVol)}</strong>
                  </div>
                  <div>
                    <span>Time to expiry</span>
                    <strong>{hoveredPoint.timeToExpiry.toFixed(3)}y</strong>
                  </div>
                </div>
              ) : (
                <p className="selection-copy">
                  The 3D panel is intentionally secondary. Use it to inspect shape and isolate contracts after the 2D read.
                </p>
              )}
            </section>
          </aside>
        </section>
        <SearchOverlay
          busy={searchBusy}
          onClose={() => setSearchFocused(false)}
          onSelect={handleSearchSelect}
          rect={searchOverlayRect}
          results={searchResults}
          suggestionsReady={configuredInstruments.length > 0}
          visible={searchPanelVisible}
        />
      </main>
    </div>
  )
}

function Heatmap({ heatmap }: { heatmap: HeatmapMatrix }) {
  if (heatmap.expiries.length === 0) {
    return <div className="empty-panel">No heatmap data available for this surface.</div>
  }

  return (
    <div className="heatmap-wrap">
      <div
        className="heatmap-grid"
        style={{ gridTemplateColumns: `88px repeat(${heatmap.expiries.length}, minmax(0, 1fr))` }}
      >
        <div className="heatmap-corner">Moneyness</div>
        {heatmap.expiries.map((expiry) => (
          <div key={expiry} className="heatmap-expiry">
            {expiry.slice(5)}
          </div>
        ))}

        {heatmap.moneynessLabels.map((label, rowIndex) => (
          <Fragment key={label}>
            <div className="heatmap-label">{label}</div>
            {heatmap.cells[rowIndex].map((value, columnIndex) => (
              <div
                key={`${label}-${heatmap.expiries[columnIndex]}`}
                className="heatmap-cell"
                style={{ background: heatmapColor(value, heatmap.minIv, heatmap.maxIv) }}
                title={
                  value === null
                    ? `${heatmap.expiries[columnIndex]} ${label}: no valid contracts`
                    : `${heatmap.expiries[columnIndex]} ${label}: ${formatPercent(value)}`
                }
              >
                {value === null ? '—' : formatPercent(value)}
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

export default App
