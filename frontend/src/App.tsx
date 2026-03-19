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
  buildSkewForExpiry,
  buildSurfaceSummary,
  buildTermStructure,
  buildTermStructureForMoneyness,
  sampleScenePoints,
} from './surface'
import type { CurvePoint, HeatmapMatrix, Instrument, SurfaceHoverPoint, SurfacePoint, SurfaceSnapshot } from './types'

const POLL_INTERVAL_MS = 30_000
const NAV_LINKS = [
  { id: 'overview', label: 'Overview' },
  { id: 'surface-lab', label: 'Surface Lab' },
  { id: 'contracts', label: 'Richest Contracts' },
] as const

type NavSectionId = (typeof NAV_LINKS)[number]['id']

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

function formatNullableCurrency(value: number | null): string {
  return value === null ? '—' : formatCurrency(value)
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatIvChange(value: number | null): string {
  if (value === null) {
    return '—'
  }

  return `${value > 0 ? '+' : ''}${value.toFixed(2)} pts`
}

function formatTimestamp(timestampMs: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestampMs)
}

function formatLastTradeTime(value: string | null): string {
  if (!value) {
    return '—'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed)
}

function formatInteger(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('en-US').format(value)
}

function formatDecimal(value: number | null, digits: number): string {
  return value === null ? '—' : value.toFixed(digits)
}

function formatExpiryHeadline(expirationDate: string): string {
  const parsed = new Date(`${expirationDate}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return expirationDate
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed)
}

function formatCompactStrike(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/\.?0+$/, '')
}

function formatContractLabel(
  point: Pick<SurfacePoint, 'contractSymbol' | 'expirationDate' | 'strike'>,
  selectedTicker: string,
): string {
  const optionTypeMatch = point.contractSymbol?.match(/^(.*?)(\d{6})([CP])(\d{8})$/)
  const optionType = optionTypeMatch?.[3]
  const optionSuffix = optionType === 'C' || optionType === 'P' ? optionType : ''
  return `${selectedTicker} ${formatCompactStrike(point.strike)}${optionSuffix} · ${formatExpiryHeadline(point.expirationDate)}`
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

function getNavSectionId(hash: string): NavSectionId | null {
  const sectionId = hash.replace(/^#/, '')
  return NAV_LINKS.some((link) => link.id === sectionId) ? (sectionId as NavSectionId) : null
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

function pointIdentity(point: Pick<SurfacePoint, 'expirationDate' | 'strike'>): string {
  return `${point.expirationDate}:${point.strike.toFixed(2)}`
}

function buildHoverPoint(point: SurfacePoint, previousPointMap: Map<string, SurfacePoint>): SurfaceHoverPoint {
  const previousPoint = previousPointMap.get(pointIdentity(point))

  return {
    ...point,
    ivChange: previousPoint ? (point.impliedVol - previousPoint.impliedVol) * 100 : null,
  }
}

function selectInstrument(
  instrument: Instrument,
  setSelectedTicker: (ticker: string) => void,
  setSearchQuery: (query: string) => void,
  setSearchFocused: (focused: boolean) => void,
  setHoveredPoint: (point: SurfaceHoverPoint | null) => void,
  setSelectedPoint: (point: SurfaceHoverPoint | null) => void,
) {
  setSelectedTicker(instrument.ticker)
  setSearchQuery('')
  setSearchFocused(false)
  setHoveredPoint(null)
  setSelectedPoint(null)
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

function EmptyPanel({
  children,
  loading = false,
}: {
  children: string
  loading?: boolean
}) {
  return (
    <div
      aria-live={loading ? 'polite' : undefined}
      className={`empty-panel ${loading ? 'empty-panel-loading' : ''}`}
      role={loading ? 'status' : undefined}
    >
      {loading ? <div aria-hidden="true" className="empty-panel-loader" /> : null}
      <span>{children}</span>
    </div>
  )
}

function LineChart({
  title,
  subtitle,
  points,
  loading = false,
  valueFormatter,
  className = '',
}: {
  title: string
  subtitle: string
  points: CurvePoint[]
  loading?: boolean
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
        <EmptyPanel loading={loading}>
          {loading ? 'Fetching the latest curve points...' : 'Need more valid option points to draw this curve.'}
        </EmptyPanel>
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

function ContractDetailPanel({
  hoveredPoint,
  selectedPoint,
  selectedTicker,
}: {
  hoveredPoint: SurfaceHoverPoint | null
  selectedPoint: SurfaceHoverPoint | null
  selectedTicker: string
}) {
  const previewPoint =
    hoveredPoint && (!selectedPoint || pointIdentity(hoveredPoint) !== pointIdentity(selectedPoint)) ? hoveredPoint : null
  const activePoint = selectedPoint ?? previewPoint
  const panelState = selectedPoint ? 'pinned' : previewPoint ? 'preview' : 'empty'

  return (
    <section className={`scene-inspector scene-inspector-${panelState}`} aria-live="polite">
      <div className="scene-inspector-head">
        <span className="eyebrow">Focus contract</span>
        <h3 title={activePoint?.contractSymbol ?? undefined}>
          {activePoint ? formatContractLabel(activePoint, selectedTicker) : 'Hover or pin a contract'}
        </h3>
        <p className="selection-copy">
          {selectedPoint
            ? `Pinned contract · ${selectedTicker}`
            : previewPoint
              ? `Hover preview · click to pin ${selectedTicker}`
              : 'Hover the lab or a contract card'}
        </p>
      </div>

      <div className="scene-inspector-body">
        <div className={`scene-inspector-stage ${panelState === 'empty' ? 'is-active' : ''}`}>
          <p className="scene-inspector-empty">
            Hover the 3D lab or a contract card to preview a point. Click a point to pin it and keep the full details
            in view.
          </p>
        </div>

        <div className={`scene-inspector-stage ${panelState === 'preview' ? 'is-active' : ''}`}>
          {previewPoint ? (
            <div className="scene-preview-card">
              <div className="scene-preview-grid">
                <div>
                  <span>Expiry</span>
                  <strong>{previewPoint.expirationDate}</strong>
                </div>
                <div>
                  <span>Strike</span>
                  <strong>{formatCurrency(previewPoint.strike)}</strong>
                </div>
                <div>
                  <span>Implied vol</span>
                  <strong>{formatPercent(previewPoint.impliedVol)}</strong>
                </div>
                <div>
                  <span>Moneyness</span>
                  <strong>{(previewPoint.moneyness * 100).toFixed(1)}%</strong>
                </div>
                <div>
                  <span>Delta</span>
                  <strong>{formatDecimal(previewPoint.delta, 3)}</strong>
                </div>
                <div>
                  <span>Mark</span>
                  <strong>{formatCurrency(previewPoint.optionPrice)}</strong>
                </div>
              </div>
              <p className="scene-preview-copy">Click this point to pin the full contract row and drive the 2D slices.</p>
            </div>
          ) : null}
        </div>

        <div className={`scene-inspector-stage scene-inspector-stage-detail ${panelState === 'pinned' ? 'is-active' : ''}`}>
          {selectedPoint ? (
            <div className="focus-grid">
              <div>
                <span>Contract</span>
                <strong title={selectedPoint.contractSymbol ?? undefined}>
                  {selectedPoint.contractSymbol ?? formatContractLabel(selectedPoint, selectedTicker)}
                </strong>
              </div>
              <div>
                <span>Ticker</span>
                <strong>{selectedTicker}</strong>
              </div>
              <div>
                <span>Expiry</span>
                <strong>{selectedPoint.expirationDate}</strong>
              </div>
              <div>
                <span>Strike</span>
                <strong>{formatCurrency(selectedPoint.strike)}</strong>
              </div>
              <div>
                <span>Moneyness</span>
                <strong>{(selectedPoint.moneyness * 100).toFixed(1)}%</strong>
              </div>
              <div>
                <span>Implied vol</span>
                <strong>{formatPercent(selectedPoint.impliedVol)}</strong>
              </div>
              <div>
                <span>IV change</span>
                <strong>{formatIvChange(selectedPoint.ivChange)}</strong>
              </div>
              <div>
                <span>Delta</span>
                <strong>{formatDecimal(selectedPoint.delta, 3)}</strong>
              </div>
              <div>
                <span>Gamma</span>
                <strong>{formatDecimal(selectedPoint.gamma, 4)}</strong>
              </div>
              <div>
                <span>Bid</span>
                <strong>{formatNullableCurrency(selectedPoint.bid)}</strong>
              </div>
              <div>
                <span>Ask</span>
                <strong>{formatNullableCurrency(selectedPoint.ask)}</strong>
              </div>
              <div>
                <span>Mark</span>
                <strong>{formatCurrency(selectedPoint.optionPrice)}</strong>
              </div>
              <div>
                <span>Last</span>
                <strong>{formatNullableCurrency(selectedPoint.lastPrice)}</strong>
              </div>
              <div>
                <span>Volume</span>
                <strong>{formatInteger(selectedPoint.volume)}</strong>
              </div>
              <div>
                <span>Open interest</span>
                <strong>{formatInteger(selectedPoint.openInterest)}</strong>
              </div>
              <div>
                <span>Last trade</span>
                <strong>{formatLastTradeTime(selectedPoint.lastTradeTime)}</strong>
              </div>
              <div>
                <span>Time to expiry</span>
                <strong>{selectedPoint.timeToExpiry.toFixed(3)}y</strong>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function App() {
  const [configuredInstruments, setConfiguredInstruments] = useState<Instrument[]>([])
  const [selectedTicker, setSelectedTicker] = useState('AAPL')
  const [surfaceRefreshNonce, setSurfaceRefreshNonce] = useState(0)
  const [activeSection, setActiveSection] = useState<NavSectionId>(() => {
    if (typeof window === 'undefined') {
      return 'overview'
    }
    return getNavSectionId(window.location.hash) ?? 'overview'
  })
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Instrument[]>([])
  const [searchFocused, setSearchFocused] = useState(false)
  const [searchBusy, setSearchBusy] = useState(false)
  const [surface, setSurface] = useState<SurfaceSnapshot | null>(null)
  const [previousSurface, setPreviousSurface] = useState<SurfaceSnapshot | null>(null)
  const [surfaceError, setSurfaceError] = useState<string | null>(null)
  const [surfaceLoading, setSurfaceLoading] = useState(false)
  const [hoveredPoint, setHoveredPoint] = useState<SurfaceHoverPoint | null>(null)
  const [selectedPoint, setSelectedPoint] = useState<SurfaceHoverPoint | null>(null)
  const [searchOverlayRect, setSearchOverlayRect] = useState<SearchOverlayRect | null>(null)
  const searchWrapRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<SurfaceSnapshot | null>(null)
  const deferredQuery = useDeferredValue(searchQuery.trim())

  useEffect(() => {
    surfaceRef.current = surface
  }, [surface])

  useEffect(() => {
    const syncActiveSection = () => {
      setActiveSection(getNavSectionId(window.location.hash) ?? 'overview')
    }

    syncActiveSection()
    window.addEventListener('hashchange', syncActiveSection)

    return () => window.removeEventListener('hashchange', syncActiveSection)
  }, [])

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
        const priorSurface = surfaceRef.current
        startTransition(() => {
          setPreviousSurface(priorSurface && priorSurface.ticker === nextSurface.ticker ? priorSurface : null)
          setSurface(nextSurface)
          setSurfaceError(null)
          setHoveredPoint(null)
          setSelectedPoint(null)
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
  }, [selectedTicker, surfaceRefreshNonce])

  const activeInstrument =
    configuredInstruments.find((instrument) => instrument.ticker === selectedTicker) ??
    searchResults.find((instrument) => instrument.ticker === selectedTicker) ??
    null

  const summary = surface ? buildSurfaceSummary(surface) : null
  const heatmap = surface ? buildHeatmap(surface) : null
  const crossSectionAnchor = selectedPoint
  const termStructure = surface
    ? (crossSectionAnchor ? buildTermStructureForMoneyness(surface, crossSectionAnchor.moneyness) : buildTermStructure(surface))
    : []
  const frontSkew = surface
    ? (crossSectionAnchor ? buildSkewForExpiry(surface, crossSectionAnchor.expirationDate) : buildFrontExpirySkew(surface))
    : []
  const notableContracts = surface ? buildNotableContracts(surface) : []
  const scenePoints = surface ? sampleScenePoints(surface.points) : []
  const previousScenePoints = previousSurface ? sampleScenePoints(previousSurface.points) : []
  const previousPointMap = new Map((previousSurface?.points ?? []).map((point) => [pointIdentity(point), point]))
  const searchPanelVisible = searchFocused
  const surfacePending = surfaceLoading && !surface
  const selectedPointKey = selectedPoint ? pointIdentity(selectedPoint) : null
  const hoveredPointKey = hoveredPoint ? pointIdentity(hoveredPoint) : null
  const previewPointKey = hoveredPointKey && hoveredPointKey !== selectedPointKey ? hoveredPointKey : null
  const focusPoint = selectedPoint ?? hoveredPoint
  const focusPointKey = focusPoint ? pointIdentity(focusPoint) : null
  const focusPointStatus = selectedPoint
    ? 'Pinned contract'
    : hoveredPoint
      ? 'Hover preview'
      : 'Hover the lab or a contract card'
  const skewSubtitle = crossSectionAnchor ? `${crossSectionAnchor.expirationDate} skew` : 'Front-month skew'
  const termSubtitle = crossSectionAnchor
    ? `${(crossSectionAnchor.moneyness * 100).toFixed(0)}% moneyness term structure`
    : 'ATM term structure'
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
      setHoveredPoint(null)
      setSelectedPoint(null)
      setSurfaceRefreshNonce((current) => current + 1)
      setActiveSection('surface-lab')
      scrollToSection('surface-lab')
      return
    }

    const candidate =
      findMatchingInstrument(query, searchResults) ??
      findMatchingInstrument(query, configuredInstruments) ??
      null

    if (candidate) {
      selectInstrument(candidate, setSelectedTicker, setSearchQuery, setSearchFocused, setHoveredPoint, setSelectedPoint)
      setSurfaceRefreshNonce((current) => current + 1)
      setActiveSection('surface-lab')
      window.requestAnimationFrame(() => {
        scrollToSection('surface-lab')
      })
      return
    }

    setSearchFocused(false)
    setActiveSection('surface-lab')
    scrollToSection('surface-lab')
  }

  function handleSearchSelect(instrument: Instrument) {
    selectInstrument(instrument, setSelectedTicker, setSearchQuery, setSearchFocused, setHoveredPoint, setSelectedPoint)
    setSurfaceRefreshNonce((current) => current + 1)
    setActiveSection('surface-lab')
    window.requestAnimationFrame(() => {
      scrollToSection('surface-lab')
    })
  }

  function previewContract(point: SurfacePoint | null) {
    setHoveredPoint(point ? buildHoverPoint(point, previousPointMap) : null)
  }

  function pinContract(point: SurfacePoint | null) {
    if (!point) {
      setSelectedPoint(null)
      return
    }

    const nextPointKey = pointIdentity(point)
    setSelectedPoint((current) =>
      current && pointIdentity(current) === nextPointKey ? null : buildHoverPoint(point, previousPointMap),
    )
  }

  return (
    <div className="app-shell">
      <header className="app-chrome">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <img src="/logo-mark.svg" alt="" />
          </div>
          <div>
            <span className="brand-name">VolStream</span>
            <p>Live volatility desk</p>
          </div>
        </div>

        <nav className="section-nav" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <a
              key={link.id}
              aria-current={activeSection === link.id ? 'location' : undefined}
              className={`section-link ${activeSection === link.id ? 'active' : ''}`}
              href={`#${link.id}`}
              onClick={() => setActiveSection(link.id)}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <section className="chrome-status">
          <div className="chrome-status-copy">
            <span className="eyebrow">Live selection</span>
            <strong>{selectedTicker}</strong>
            <p>{surface ? `Updated ${formatTimestamp(surface.timestampMs)}` : 'Waiting for live surface'}</p>
          </div>
          <div className="chrome-pill-group">
            <span className="hero-pill">Yahoo Finance source</span>
            <span className="hero-pill">30s poll</span>
          </div>
        </section>
      </header>

      <main className="app-frame">
        <section className="hero-panel" id="overview">
          <div className="hero-copy">
            <span className="eyebrow">Live volatility desk</span>
            <h1>Read the surface without fighting the layout.</h1>
            <p className="hero-copy-text">
              Search a ticker, scan the surface map, then move into a wider shape lab and pin the contracts that
              deserve a second look.
            </p>

            <form
              className={`mt-[1.35rem] grid max-w-[43rem] gap-2.5 ${searchPanelVisible ? 'relative z-[1705]' : ''}`}
              onSubmit={handleSearchSubmit}
            >
              <label className="mb-1 block text-[0.72rem] uppercase tracking-[0.12em] text-white/64" htmlFor="ticker-search">
                Search ticker or company
              </label>
              <div
                ref={searchWrapRef}
                className={`flex items-stretch gap-0 ${searchPanelVisible ? 'relative z-[1706]' : ''}`}
              >
                <div className="relative min-w-0 flex-1 basis-[30rem]">
                  <input
                    id="ticker-search"
                    autoComplete="off"
                    className="search-input min-h-[3.35rem] w-full min-w-0 rounded-l-[1.1rem] rounded-r-none border border-r-0 border-white/18 bg-[#2b3138] px-[1.15rem] py-[0.95rem] text-white caret-[#dff8f8] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_24px_rgba(1,8,10,0.18)] outline-none placeholder:text-white/95 focus:border-cyan-300/45 focus:ring-4 focus:ring-cyan-300/10"
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
                <button
                  className="min-h-[3.35rem] shrink-0 whitespace-nowrap rounded-l-none rounded-r-[1.1rem] border border-white/18 bg-[linear-gradient(180deg,rgba(20,52,58,0.98),rgba(9,21,25,0.98))] px-5 text-sm font-semibold tracking-[0.01em] text-white shadow-[0_20px_34px_rgba(1,8,10,0.3),inset_0_1px_0_rgba(255,255,255,0.05)] transition hover:-translate-y-px hover:border-cyan-300/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300/80 sm:px-6 sm:text-base"
                  type="submit"
                >
                  Inspect Surface
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

        <section className="brief-grid">
          <section className="card brief-card">
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
                <span>Front read</span>
                <strong>{summary?.frontExpiry ?? 'Awaiting snapshot'}</strong>
              </div>
            </div>
          </section>

          <section className="card brief-card">
            <span className="eyebrow">How to read this</span>
            <h3>Start wide, then drill in.</h3>
            <ol className="read-path">
              <li>
                <span>1</span>
                <div>
                  <strong>Scan the surface map</strong>
                  <p>Look for higher-IV pockets across expiry and moneyness before inspecting individual contracts.</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Use the shape lab</strong>
                  <p>Rotate the widened 3D surface to confirm curvature, skew, and whether outliers are persistent.</p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Pin the richest contracts</strong>
                  <p>Use the contract cards to preview or pin standout points without hunting in a separate side rail.</p>
                </div>
              </li>
            </ol>
          </section>
        </section>

        <section className="dashboard-grid">
          <article className="card card-wide surface-card" id="surface-lab">
            <div className="card-header">
              <div>
                <span className="eyebrow">Surface overview</span>
                <h3>Surface map by expiry and moneyness</h3>
              </div>
              <span className="hero-pill">Start here</span>
            </div>
            {surfacePending ? (
              <EmptyPanel loading>Loading the current option surface...</EmptyPanel>
            ) : !surface || !heatmap ? (
              <EmptyPanel>No heatmap data available for this surface.</EmptyPanel>
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
            loading={surfacePending}
            points={frontSkew}
            subtitle={skewSubtitle}
            title="Skew"
            valueFormatter={formatPercent}
          />

          <LineChart
            className="span-6"
            loading={surfacePending}
            points={termStructure}
            subtitle={termSubtitle}
            title="Term"
            valueFormatter={formatPercent}
          />

          <article className="card card-wide scene-card" id="surface-scene">
            <div className="card-header">
              <div>
                <span className="eyebrow">Surface lab</span>
                <h3>Surface shape lab</h3>
              </div>
              <div className="scene-status">
                <span className="scene-status-label">{focusPointStatus}</span>
                <strong title={focusPoint?.contractSymbol ?? undefined}>
                  {focusPoint ? formatContractLabel(focusPoint, selectedTicker) : 'Hover or click a point to inspect it'}
                </strong>
              </div>
            </div>
            <div className="scene-layout">
              <div className="scene-frame">
                {surfacePending ? (
                  <EmptyPanel loading>Loading the surface shape lab...</EmptyPanel>
                ) : scenePoints.length === 0 ? (
                  <EmptyPanel>No surface points available for this view.</EmptyPanel>
                ) : (
                  <Suspense fallback={<EmptyPanel loading>Loading the surface shape lab...</EmptyPanel>}>
                    <SurfaceScene
                      onHoverPoint={setHoveredPoint}
                      onSelectPoint={pinContract}
                      points={scenePoints}
                      previousPoints={previousScenePoints}
                      referenceIv={summary?.frontAtmIv ?? null}
                      selectedPoint={selectedPoint}
                    />
                  </Suspense>
                )}
              </div>
              <ContractDetailPanel
                hoveredPoint={hoveredPoint}
                selectedPoint={selectedPoint}
                selectedTicker={selectedTicker}
              />
            </div>
            <div className="scene-footnote">
              <span>Click any point or contract card to pin it. The pinned contract now drives the skew and term slices.</span>
              <span>
                {previousScenePoints.length > 0
                  ? 'Current points are compared against the prior snapshot.'
                  : 'Point color is driven by option premium until a prior snapshot is available.'}
              </span>
            </div>
          </article>

          <article className="card card-wide contracts-card" id="contracts">
            <div className="card-header">
              <div>
                <span className="eyebrow">Richest contracts</span>
                <h3>Highest implied vols, laid out for scanning</h3>
              </div>
              <span className="hero-pill">Preview or pin in the lab</span>
            </div>
            {surfacePending ? (
              <EmptyPanel loading>Loading the contract list...</EmptyPanel>
            ) : notableContracts.length === 0 ? (
              <EmptyPanel>No contracts available in the current surface.</EmptyPanel>
            ) : (
              <div className="contracts-grid">
                {notableContracts.map((point, index) => {
                  const contractKey = pointIdentity(point)
                  const enrichedPoint = buildHoverPoint(point, previousPointMap)
                  const isFocus = contractKey === (previewPointKey ?? selectedPointKey ?? focusPointKey)
                  const isPinned = contractKey === selectedPointKey

                  return (
                    <button
                      key={contractKey}
                      aria-pressed={isPinned}
                      className={`contract-card${isFocus ? ' is-focus' : ''}${isPinned ? ' is-pinned' : ''}`}
                      onBlur={() => previewContract(null)}
                      onClick={() => pinContract(point)}
                      onFocus={() => previewContract(point)}
                      onMouseEnter={() => previewContract(point)}
                      onMouseLeave={() => previewContract(null)}
                      type="button"
                    >
                      <div className="contract-card-top">
                        <span className="contract-rank">#{index + 1}</span>
                        <span className="contract-flag">{isPinned ? 'Pinned' : isFocus ? 'Previewing' : 'Pin in lab'}</span>
                      </div>

                      <div className="contract-card-headline">
                        <strong>{formatPercent(point.impliedVol)}</strong>
                        <p>
                          {point.expirationDate} · Strike {formatCurrency(point.strike)}
                        </p>
                      </div>

                      <div className="contract-metrics">
                        <div>
                          <span>Moneyness</span>
                          <strong>{(point.moneyness * 100).toFixed(1)}%</strong>
                        </div>
                        <div>
                          <span>Mark</span>
                          <strong>{formatCurrency(point.optionPrice)}</strong>
                        </div>
                        <div>
                          <span>Tenor</span>
                          <strong>{point.timeToExpiry.toFixed(3)}y</strong>
                        </div>
                        <div>
                          <span>IV change</span>
                          <strong>{formatIvChange(enrichedPoint.ivChange)}</strong>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </article>

          <section className="card card-wide page-cta">
            <div>
              <span className="eyebrow">Next move</span>
              <h3>Inspect another surface and compare the shape.</h3>
              <p>Keep the same read path: surface map, shape lab, then the richest contracts worth pinning.</p>
            </div>
            <a className="primary-button" href="#ticker-search">
              Inspect another surface
            </a>
          </section>
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
    return <EmptyPanel>No heatmap data available for this surface.</EmptyPanel>
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
