import { Html, OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Line, LineBasicMaterial, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'

import type { SurfaceHoverPoint, SurfacePoint } from '../types'

type SurfaceSceneProps = {
  onSelectPoint?: (point: SurfacePoint | null) => void
  points: SurfacePoint[]
  previousPoints?: SurfacePoint[]
  referenceIv?: number | null
  onHoverPoint: (point: SurfaceHoverPoint | null) => void
  selectedPoint?: SurfaceHoverPoint | null
}

type CameraPreset = 'canonical' | 'skew' | 'term'

type ExpiryMeta = {
  expirationDate: string
  index: number
  label: string
  z: number
}

type ScenePoint = {
  color: string
  hoverPoint: SurfaceHoverPoint
  key: string
  position: [number, number, number]
  radius: number
}

type SurfaceBounds = {
  centerY: number
  maxHeight: number
  maxX: number
  maxZ: number
  minX: number
}

const EXPIRY_STEP = 0.9
const FLOOR_PADDING = 0.9
const MAX_BRIDGE_GAP = 0.09
const MONEYNESS_GRID_LEVELS = [80, 90, 100, 110, 120]
const SURFACE_HEIGHT = 5.2
const TICK_MARK_HEIGHT = 0.025

function pointKey(point: SurfacePoint): string {
  return `${point.expirationDate}:${point.strike.toFixed(2)}`
}

function formatExpiryLabel(expirationDate: string): string {
  const parsedDate = new Date(`${expirationDate}T00:00:00`)
  if (Number.isNaN(parsedDate.getTime())) {
    return expirationDate
  }

  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
  }).format(parsedDate)
}

function buildExpiryMeta(points: SurfacePoint[], previousPoints: SurfacePoint[]): ExpiryMeta[] {
  const expiryMap = new Map<string, number>()

  for (const point of [...points, ...previousPoints]) {
    const current = expiryMap.get(point.expirationDate)
    if (current === undefined || point.timeToExpiry < current) {
      expiryMap.set(point.expirationDate, point.timeToExpiry)
    }
  }

  return [...expiryMap.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([expirationDate], index) => ({
      expirationDate,
      index,
      label: formatExpiryLabel(expirationDate),
      z: index * EXPIRY_STEP,
    }))
}

function buildHeightScale(points: SurfacePoint[], previousPoints: SurfacePoint[]): number {
  const maxIv = Math.max(...[...points, ...previousPoints].map((point) => point.impliedVol), 1)
  return SURFACE_HEIGHT / maxIv
}

function scalePoint(
  point: SurfacePoint,
  expiryIndexByDate: Map<string, number>,
  heightScale: number,
): [number, number, number] {
  const x = (point.moneyness - 1) * 18
  const y = point.impliedVol * heightScale
  const z = (expiryIndexByDate.get(point.expirationDate) ?? 0) * EXPIRY_STEP
  return [x, y, z]
}

function colorByIvChange(change: number | null, maxAbs: number): string {
  if (change === null) {
    return '#c8d6da'
  }

  const ratio = Math.min(Math.abs(change) / Math.max(maxAbs, 0.01), 1)
  if (change > 0) {
    return `hsl(${10 - ratio * 8} 78% ${62 - ratio * 18}%)`
  }
  if (change < 0) {
    return `hsl(${154 - ratio * 12} 46% ${54 - ratio * 14}%)`
  }
  return '#dbe7ea'
}

function colorByMidPrice(optionPrice: number, minPrice: number, maxPrice: number): string {
  const span = Math.max(maxPrice - minPrice, 0.001)
  const ratio = (optionPrice - minPrice) / span
  const hue = 198 - ratio * 152
  return `hsl(${hue} 70% ${58 - ratio * 12}%)`
}

function buildRows(points: SurfacePoint[], expiryMeta: ExpiryMeta[]) {
  const grouped = new Map<string, SurfacePoint[]>()

  for (const point of points) {
    const row = grouped.get(point.expirationDate)
    if (row) {
      row.push(point)
    } else {
      grouped.set(point.expirationDate, [point])
    }
  }

  return expiryMeta
    .map(({ expirationDate }) =>
      [...(grouped.get(expirationDate) ?? [])].sort((left, right) => left.moneyness - right.moneyness),
    )
    .filter((row) => row.length >= 2)
}

function buildExpiryCurves(
  rows: SurfacePoint[][],
  expiryIndexByDate: Map<string, number>,
  heightScale: number,
) {
  return rows
    .map((row) => row.map((point) => scalePoint(point, expiryIndexByDate, heightScale)))
    .filter((curve) => curve.length >= 2)
}

function buildTermCurves(
  rows: SurfacePoint[][],
  expiryMeta: ExpiryMeta[],
  expiryIndexByDate: Map<string, number>,
  heightScale: number,
) {
  return MONEYNESS_GRID_LEVELS.map((targetLevel) => {
    const curve = expiryMeta
      .map(({ expirationDate }) => {
        const row = rows.find((candidate) => candidate[0]?.expirationDate === expirationDate)
        if (!row || row.length === 0) {
          return null
        }

        const nearest = [...row].sort(
          (left, right) =>
            Math.abs(left.moneyness * 100 - targetLevel) - Math.abs(right.moneyness * 100 - targetLevel),
        )[0]

        if (!nearest || Math.abs(nearest.moneyness * 100 - targetLevel) > 4.5) {
          return null
        }

        return scalePoint(nearest, expiryIndexByDate, heightScale)
      })
      .filter((point): point is [number, number, number] => point !== null)

    return curve.length >= 2 ? curve : null
  }).filter((curve): curve is [number, number, number][] => curve !== null)
}

function buildSurfaceGeometry(
  rows: SurfacePoint[][],
  expiryIndexByDate: Map<string, number>,
  heightScale: number,
  colorForPoint: (point: SurfacePoint) => string,
): BufferGeometry | null {
  const geometry = new BufferGeometry()
  const positions: number[] = []
  const colors: number[] = []
  const triangleIndices: number[] = []
  const vertexIndexRows: number[][] = []
  let nextVertexIndex = 0

  for (const row of rows) {
    const vertexIndices: number[] = []

    for (const point of row) {
      const [x, y, z] = scalePoint(point, expiryIndexByDate, heightScale)
      positions.push(x, y, z)

      const color = new Color(colorForPoint(point))
      colors.push(color.r, color.g, color.b)

      vertexIndices.push(nextVertexIndex)
      nextVertexIndex += 1
    }

    vertexIndexRows.push(vertexIndices)
  }

  for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex += 1) {
    const currentRow = rows[rowIndex]
    const nextRow = rows[rowIndex + 1]
    const currentRowIndices = vertexIndexRows[rowIndex] ?? []
    const nextRowIndices = vertexIndexRows[rowIndex + 1] ?? []
    const segmentCount = Math.min(currentRow.length, nextRow.length) - 1

    for (let pointIndex = 0; pointIndex < segmentCount; pointIndex += 1) {
      const a0 = currentRow[pointIndex]
      const a1 = currentRow[pointIndex + 1]
      const b0 = nextRow[pointIndex]
      const b1 = nextRow[pointIndex + 1]

      if (
        Math.abs(a0.moneyness - b0.moneyness) > MAX_BRIDGE_GAP ||
        Math.abs(a1.moneyness - b1.moneyness) > MAX_BRIDGE_GAP
      ) {
        continue
      }

      triangleIndices.push(
        currentRowIndices[pointIndex]!,
        nextRowIndices[pointIndex]!,
        nextRowIndices[pointIndex + 1]!,
        currentRowIndices[pointIndex]!,
        nextRowIndices[pointIndex + 1]!,
        currentRowIndices[pointIndex + 1]!,
      )
    }
  }

  if (triangleIndices.length === 0) {
    geometry.dispose()
    return null
  }

  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  geometry.setIndex(triangleIndices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

function buildSurfaceBounds(points: ScenePoint[]): SurfaceBounds {
  const xValues = points.map((point) => point.position[0])
  const yValues = points.map((point) => point.position[1])

  return {
    centerY: yValues.length > 0 ? (Math.min(...yValues) + Math.max(...yValues)) / 2 : 1.6,
    maxHeight: yValues.length > 0 ? Math.max(...yValues) : 3,
    maxX: xValues.length > 0 ? Math.max(...xValues) + FLOOR_PADDING : 4,
    maxZ: Math.max(2.4, points.length > 0 ? Math.max(...points.map((point) => point.position[2])) + 0.6 : 2.4),
    minX: xValues.length > 0 ? Math.min(...xValues) - FLOOR_PADDING : -4,
  }
}

function buildCameraView(preset: CameraPreset, bounds: SurfaceBounds) {
  const centerZ = bounds.maxZ * 0.44
  const centerY = Math.max(1.2, Math.min(bounds.centerY, bounds.maxHeight))

  if (preset === 'skew') {
    return {
      position: [0, Math.max(3.9, centerY + 1.4), -7.4] as [number, number, number],
      target: [0, centerY, centerZ] as [number, number, number],
    }
  }

  if (preset === 'term') {
    return {
      position: [-7.6, Math.max(4.1, centerY + 1.2), centerZ] as [number, number, number],
      target: [0, centerY, centerZ] as [number, number, number],
    }
  }

  return {
    position: [-6.2, Math.max(4.5, centerY + 1.6), Math.max(4.8, bounds.maxZ * 0.96)] as [number, number, number],
    target: [0, centerY, centerZ] as [number, number, number],
  }
}

function CameraRig({
  bounds,
  controlsRef,
  preset,
  presetNonce,
}: {
  bounds: SurfaceBounds
  controlsRef: { current: OrbitControlsImpl | null }
  preset: CameraPreset
  presetNonce: number
}) {
  const { camera } = useThree()
  const currentTargetRef = useRef(new Vector3())
  const desiredPositionRef = useRef(new Vector3())
  const desiredTargetRef = useRef(new Vector3())
  const initializedRef = useRef(false)
  const appliedPresetNonceRef = useRef<number | null>(null)

  useEffect(() => {
    const view = buildCameraView(preset, bounds)

    if (!initializedRef.current) {
      camera.position.set(...view.position)
      currentTargetRef.current.set(...view.target)
      desiredPositionRef.current.set(...view.position)
      desiredTargetRef.current.set(...view.target)
      controlsRef.current?.target.copy(currentTargetRef.current)
      camera.lookAt(currentTargetRef.current)
      controlsRef.current?.update()
      initializedRef.current = true
      appliedPresetNonceRef.current = presetNonce
      return
    }

    if (appliedPresetNonceRef.current !== presetNonce) {
      desiredPositionRef.current.set(...view.position)
      desiredTargetRef.current.set(...view.target)
      appliedPresetNonceRef.current = presetNonce
    }
  }, [bounds, camera, controlsRef, preset, presetNonce])

  useFrame((_state, delta) => {
    if (!initializedRef.current) {
      return
    }

    const easing = 1 - Math.exp(-delta * 8)
    camera.position.lerp(desiredPositionRef.current, easing)
    currentTargetRef.current.lerp(desiredTargetRef.current, easing)
    controlsRef.current?.target.copy(currentTargetRef.current)
    controlsRef.current?.update()
    camera.lookAt(currentTargetRef.current)
  })

  return null
}

function toolbarButtonClass(active: boolean) {
  return [
    'rounded-full border px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.12em] transition',
    active
      ? 'border-slate-700 bg-slate-900 text-white shadow-sm'
      : 'border-slate-300 bg-white/92 text-slate-700 hover:border-slate-500 hover:bg-white',
  ].join(' ')
}

function toggleButtonClass(active: boolean) {
  return [
    'rounded-full border px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.12em] transition',
    active
      ? 'border-[#2b6e59] bg-[#2b6e59] text-white shadow-sm'
      : 'border-slate-300 bg-white/92 text-slate-700 hover:border-slate-500 hover:bg-white',
  ].join(' ')
}

function SceneFallback({ message }: { message: string }) {
  return (
    <div className="grid h-full place-items-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.98),rgba(231,237,239,0.96))] px-6 text-center">
      <div className="max-w-[30rem] rounded-[1.8rem] border border-slate-300/80 bg-white/92 p-6 shadow-[0_24px_60px_rgba(15,23,42,0.12)]">
        <span className="block text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Surface Lab Unavailable
        </span>
        <strong className="mt-2 block text-base text-slate-900">Three.js could not start in this browser session.</strong>
        <p className="mt-2 mb-0 text-sm leading-6 text-slate-600">{message}</p>
      </div>
    </div>
  )
}

function supportsWebGL() {
  if (typeof document === 'undefined') {
    return true
  }

  const canvas = document.createElement('canvas')
  return Boolean(
    canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'),
  )
}

function Polyline({
  color,
  opacity = 1,
  points,
}: {
  color: string
  opacity?: number
  points: [number, number, number][]
}) {
  const line = useMemo(() => {
    const nextGeometry = new BufferGeometry()
    nextGeometry.setAttribute('position', new BufferAttribute(new Float32Array(points.flat()), 3))
    const material = new LineBasicMaterial({
      color,
      opacity,
      transparent: opacity < 1,
    })
    return new Line(nextGeometry, material)
  }, [color, opacity, points])

  useEffect(
    () => () => {
      line.geometry.dispose()
      line.material.dispose()
    },
    [line],
  )

  return <primitive frustumCulled={false} object={line} />
}

function FloorGrid({ bounds }: { bounds: SurfaceBounds }) {
  const gridLines: Array<{
    color: string
    key: string
    opacity: number
    points: [number, number, number][]
  }> = []

  for (const level of MONEYNESS_GRID_LEVELS) {
    const x = ((level / 100) - 1) * 18
    if (x < bounds.minX - 0.1 || x > bounds.maxX + 0.1) {
      continue
    }

    gridLines.push({
      color: '#9fb4ba',
      key: `m-${level}`,
      opacity: level === 100 ? 0.76 : 0.42,
      points: [
        [x, TICK_MARK_HEIGHT, 0],
        [x, TICK_MARK_HEIGHT, bounds.maxZ],
      ],
    })
  }

  const expiryCount = Math.max(2, Math.round(bounds.maxZ / EXPIRY_STEP) + 1)
  for (let index = 0; index < expiryCount; index += 1) {
    const z = index * EXPIRY_STEP
    if (z > bounds.maxZ + 0.05) {
      continue
    }

    gridLines.push({
      color: '#b7c8cc',
      key: `e-${index}`,
      opacity: 0.38,
      points: [
        [bounds.minX, TICK_MARK_HEIGHT, z],
        [bounds.maxX, TICK_MARK_HEIGHT, z],
      ],
    })
  }

  return (
    <>
      {gridLines.map((line) => (
        <Polyline color={line.color} key={line.key} opacity={line.opacity} points={line.points} />
      ))}
    </>
  )
}

function AxisLabels({ bounds, expiryMeta }: { bounds: SurfaceBounds; expiryMeta: ExpiryMeta[] }) {
  const labeledExpiries = expiryMeta.filter((_, index) => {
    const lastIndex = expiryMeta.length - 1
    return index === 0 || index === lastIndex || index === Math.round(lastIndex / 2)
  })

  return (
    <>
      {MONEYNESS_GRID_LEVELS.map((level) => {
        const x = ((level / 100) - 1) * 18
        if (x < bounds.minX - 0.1 || x > bounds.maxX + 0.1) {
          return null
        }

        return (
          <Html center key={`moneyness-label-${level}`} position={[x, 0.08, -0.18]}>
            <div className="pointer-events-none rounded-full bg-white/92 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-700 shadow-sm ring-1 ring-slate-300/80">
              {level === 100 ? 'ATM' : `${level}%`}
            </div>
          </Html>
        )
      })}

      {labeledExpiries.map((expiry) => (
        <Html center key={`expiry-label-${expiry.expirationDate}`} position={[bounds.minX - 0.72, 0.08, expiry.z]}>
          <div className="pointer-events-none rounded-full bg-white/92 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-700 shadow-sm ring-1 ring-slate-300/80">
            {expiry.label}
          </div>
        </Html>
      ))}

      <Html center position={[bounds.maxX + 0.85, Math.max(bounds.maxHeight * 0.54, 1.35), 0]}>
        <div className="pointer-events-none rounded-full bg-slate-900/84 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-white shadow-sm">
          IV
        </div>
      </Html>
    </>
  )
}

function SurfaceMesh({ geometry }: { geometry: BufferGeometry }) {
  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <>
      <mesh geometry={geometry}>
        <meshStandardMaterial metalness={0.08} roughness={0.34} side={DoubleSide} vertexColors />
      </mesh>
      <mesh geometry={geometry}>
        <meshBasicMaterial color="#23363c" opacity={0.16} transparent wireframe />
      </mesh>
    </>
  )
}

function GhostWireframe({ geometry }: { geometry: BufferGeometry }) {
  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <mesh geometry={geometry}>
      <meshBasicMaterial color="#d59669" opacity={0.38} transparent wireframe />
    </mesh>
  )
}

export function SurfaceScene({
  onSelectPoint,
  points,
  previousPoints = [],
  referenceIv = null,
  onHoverPoint,
  selectedPoint = null,
}: SurfaceSceneProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null)
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('canonical')
  const [cameraPresetNonce, setCameraPresetNonce] = useState(0)
  const [previousSurfaceEnabled, setPreviousSurfaceEnabled] = useState(true)
  const [showReferencePlane, setShowReferencePlane] = useState(true)

  const expiryMeta = useMemo(() => buildExpiryMeta(points, previousPoints), [points, previousPoints])
  const expiryIndexByDate = useMemo(
    () => new Map(expiryMeta.map((expiry) => [expiry.expirationDate, expiry.index])),
    [expiryMeta],
  )
  const heightScale = useMemo(() => buildHeightScale(points, previousPoints), [points, previousPoints])
  const previousPointMap = useMemo(
    () => new Map(previousPoints.map((point) => [pointKey(point), point])),
    [previousPoints],
  )
  const hasPreviousSurface = previousPoints.length > 0
  const ivChanges = points
    .map((point) => {
      const previousPoint = previousPointMap.get(pointKey(point))
      return previousPoint ? (point.impliedVol - previousPoint.impliedVol) * 100 : null
    })
    .filter((value): value is number => value !== null)
  const maxIvChange = ivChanges.length > 0 ? Math.max(...ivChanges.map((value) => Math.abs(value))) : 0.25
  const prices = points.map((point) => point.optionPrice)
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 1

  const colorForPoint = useCallback(
    (point: SurfacePoint) => {
      const previousPoint = previousPointMap.get(pointKey(point))
      const ivChange = previousPoint ? (point.impliedVol - previousPoint.impliedVol) * 100 : null
      return hasPreviousSurface
        ? colorByIvChange(ivChange, maxIvChange)
        : colorByMidPrice(point.optionPrice, minPrice, maxPrice)
    },
    [hasPreviousSurface, maxIvChange, maxPrice, minPrice, previousPointMap],
  )

  const scenePoints = useMemo(
    () =>
      points.map((point) => {
        const previousPoint = previousPointMap.get(pointKey(point))
        const ivChange = previousPoint ? (point.impliedVol - previousPoint.impliedVol) * 100 : null
        const key = pointKey(point)
        return {
          color: colorForPoint(point),
          hoverPoint: {
            ...point,
            ivChange,
          },
          key,
          position: scalePoint(point, expiryIndexByDate, heightScale),
          radius:
            (hasPreviousSurface
              ? 0.085 + Math.min(0.04, Math.abs(ivChange ?? 0) * 0.014)
              : 0.08 + Math.min(0.04, point.optionPrice * 0.012)) *
            (selectedPoint && key === pointKey(selectedPoint) ? 1.2 : 1),
        }
      }),
    [colorForPoint, expiryIndexByDate, hasPreviousSurface, heightScale, points, previousPointMap, selectedPoint],
  )

  const bounds = useMemo(() => buildSurfaceBounds(scenePoints), [scenePoints])
  const currentRows = useMemo(() => buildRows(points, expiryMeta), [expiryMeta, points])
  const previousRows = useMemo(() => buildRows(previousPoints, expiryMeta), [expiryMeta, previousPoints])
  const currentExpiryCurves = useMemo(
    () => buildExpiryCurves(currentRows, expiryIndexByDate, heightScale),
    [currentRows, expiryIndexByDate, heightScale],
  )
  const currentTermCurves = useMemo(
    () => buildTermCurves(currentRows, expiryMeta, expiryIndexByDate, heightScale),
    [currentRows, expiryMeta, expiryIndexByDate, heightScale],
  )
  const currentSurfaceGeometry = useMemo(
    () => buildSurfaceGeometry(currentRows, expiryIndexByDate, heightScale, colorForPoint),
    [colorForPoint, currentRows, expiryIndexByDate, heightScale],
  )
  const previousSurfaceGeometry = useMemo(
    () => buildSurfaceGeometry(previousRows, expiryIndexByDate, heightScale, () => '#d59669'),
    [previousRows, expiryIndexByDate, heightScale],
  )
  const showPreviousSurface = Boolean(previousSurfaceGeometry) && previousSurfaceEnabled
  const referenceHeight = referenceIv !== null ? referenceIv * heightScale : null
  const initialView = buildCameraView('canonical', bounds)
  const colorLegendLabel = hasPreviousSurface ? 'Color: IV change vs prior snapshot' : 'Color: option premium'
  const webglReady = supportsWebGL()

  function requestCameraPreset(preset: CameraPreset) {
    setCameraPreset(preset)
    setCameraPresetNonce((current) => current + 1)
  }

  return (
    <div className="relative h-full w-full">
      {!webglReady ? (
        <SceneFallback message="WebGL is unavailable in this browser session. Enable hardware acceleration or open the app in a browser with WebGL support, then reload the page." />
      ) : (
        <Canvas
          camera={{ far: 42, fov: 38, near: 0.1, position: initialView.position }}
          dpr={[1, 2]}
          frameloop="always"
          gl={{
            alpha: false,
            antialias: true,
            failIfMajorPerformanceCaveat: false,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: false,
            stencil: false,
          }}
          onCreated={({ gl, scene, camera, invalidate }) => {
            gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
            gl.render(scene, camera)
            invalidate()
          }}
          onPointerMissed={() => {
            onHoverPoint(null)
            onSelectPoint?.(null)
          }}
        >
          <color attach="background" args={['#f4f7f7']} />
          <ambientLight intensity={1.14} />
          <directionalLight color="#ffffff" intensity={1.2} position={[-4, 8.5, 6]} />
          <directionalLight color="#d8e3e5" intensity={0.55} position={[5, 4, -3]} />
          <CameraRig bounds={bounds} controlsRef={controlsRef} preset={cameraPreset} presetNonce={cameraPresetNonce} />

          <mesh position={[0, -0.03, bounds.maxZ / 2]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[bounds.maxX - bounds.minX, bounds.maxZ + 0.9]} />
            <meshBasicMaterial color="#eef2f3" />
          </mesh>

          {showReferencePlane && referenceHeight !== null ? (
            <mesh position={[0, referenceHeight, bounds.maxZ / 2]} rotation-x={-Math.PI / 2}>
              <planeGeometry args={[bounds.maxX - bounds.minX, bounds.maxZ + 0.9]} />
              <meshBasicMaterial color="#99b9c3" opacity={0.18} transparent />
            </mesh>
          ) : null}

          <FloorGrid bounds={bounds} />
          <AxisLabels bounds={bounds} expiryMeta={expiryMeta} />

          {currentSurfaceGeometry ? <SurfaceMesh geometry={currentSurfaceGeometry} /> : null}
          {showPreviousSurface && previousSurfaceGeometry ? <GhostWireframe geometry={previousSurfaceGeometry} /> : null}

          {currentExpiryCurves.map((curve, index) => (
            <Polyline color="#2d464d" key={`expiry-curve-${index}`} opacity={0.88} points={curve} />
          ))}
          {currentTermCurves.map((curve, index) => (
            <Polyline color="#72878d" key={`term-curve-${index}`} opacity={0.58} points={curve} />
          ))}

          {scenePoints.map((point) => (
            <mesh
              key={point.key}
              position={point.position}
              onPointerEnter={(event) => {
                event.stopPropagation()
                onHoverPoint(point.hoverPoint)
                document.body.style.cursor = 'pointer'
              }}
              onPointerLeave={() => {
                if (!selectedPoint || point.key !== pointKey(selectedPoint)) {
                  onHoverPoint(null)
                }
                document.body.style.cursor = 'default'
              }}
              onClick={(event) => {
                event.stopPropagation()
                onSelectPoint?.(point.hoverPoint)
              }}
            >
              <sphereGeometry args={[point.radius, 16, 16]} />
              <meshStandardMaterial
                color={point.color}
                emissive={point.color}
                emissiveIntensity={0.12}
                metalness={0.05}
                roughness={0.28}
              />
            </mesh>
          ))}

          <Polyline
            color="#4b6066"
            points={[
              [bounds.minX, 0.03, 0],
              [bounds.maxX + 0.55, 0.03, 0],
            ]}
          />
          <Polyline
            color="#4b6066"
            points={[
              [bounds.minX, 0.03, 0],
              [bounds.minX, 0.03, bounds.maxZ + 0.45],
            ]}
          />
          <Polyline
            color="#4b6066"
            points={[
              [bounds.maxX + 0.4, 0.03, 0],
              [bounds.maxX + 0.4, bounds.maxHeight + 0.8, 0],
            ]}
          />

          <OrbitControls
            ref={controlsRef}
            dampingFactor={0.08}
            enableDamping
            enablePan={false}
            maxDistance={13}
            maxPolarAngle={Math.PI / 2.02}
            minDistance={4.6}
            minPolarAngle={0.34}
            rotateSpeed={0.88}
            zoomSpeed={0.82}
          />
        </Canvas>
      )}

      {webglReady ? (
        <>
          <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2">
            <div className="pointer-events-auto flex flex-wrap gap-2 rounded-2xl bg-white/88 p-1.5 shadow-sm ring-1 ring-slate-300/80 backdrop-blur">
              <button
                className={toolbarButtonClass(cameraPreset === 'canonical')}
                onClick={() => requestCameraPreset('canonical')}
                type="button"
              >
                Surface
              </button>
              <button
                className={toolbarButtonClass(cameraPreset === 'skew')}
                onClick={() => requestCameraPreset('skew')}
                type="button"
              >
                Skew
              </button>
              <button
                className={toolbarButtonClass(cameraPreset === 'term')}
                onClick={() => requestCameraPreset('term')}
                type="button"
              >
                Term
              </button>
              <button
                className={toolbarButtonClass(false)}
                onClick={() => requestCameraPreset('canonical')}
                type="button"
              >
                Reset View
              </button>
            </div>

            <div className="pointer-events-auto flex flex-wrap gap-2 rounded-2xl bg-white/88 p-1.5 shadow-sm ring-1 ring-slate-300/80 backdrop-blur">
              <button
                className={toggleButtonClass(showPreviousSurface)}
                disabled={previousSurfaceGeometry === null}
                onClick={() => setPreviousSurfaceEnabled((current) => !current)}
                type="button"
              >
                Prior surface
              </button>
              <button
                className={toggleButtonClass(showReferencePlane)}
                onClick={() => setShowReferencePlane((current) => !current)}
                type="button"
              >
                ATM plane
              </button>
            </div>

            <div className="pointer-events-auto rounded-full bg-slate-900/82 px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-slate-100 shadow-sm">
              {colorLegendLabel}
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-4 bottom-3 z-10 flex items-end justify-between gap-4 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-slate-600">
            <span>Moneyness</span>
            <span>Expiry Depth</span>
            <span>IV %</span>
          </div>
        </>
      ) : null}
    </div>
  )
}
