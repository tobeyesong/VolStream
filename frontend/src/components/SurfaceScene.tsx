import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'

import type { SurfacePoint } from '../types'

type SurfaceSceneProps = {
  points: SurfacePoint[]
  onHoverPoint: (point: SurfacePoint | null) => void
}

function pointColor(impliedVol: number): string {
  const hue = 195 - Math.min(140, impliedVol * 160)
  return `hsl(${hue} 80% 58%)`
}

function scalePoint(point: SurfacePoint): [number, number, number] {
  const x = point.timeToExpiry * 7 - 0.6
  const y = point.impliedVol * 7 - 0.8
  const z = (point.moneyness - 1) * 12
  return [x, y, z]
}

export function SurfaceScene({ points, onHoverPoint }: SurfaceSceneProps) {
  return (
    <Canvas camera={{ position: [4.2, 3.4, 4.7], fov: 39 }} dpr={[1, 1.5]}>
      <color attach="background" args={['#081115']} />
      <fog attach="fog" args={['#081115', 7, 15]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 6, 4]} intensity={1.35} color="#dff6f7" />
      <directionalLight position={[-3, 2, -2]} intensity={0.7} color="#f5bf6d" />
      <gridHelper args={[8, 12, '#28434c', '#16272c']} position={[2.2, -0.85, 0]} />
      <mesh rotation-x={-Math.PI / 2} position={[2.2, -0.92, 0]}>
        <planeGeometry args={[8, 8]} />
        <meshStandardMaterial color="#071114" roughness={1} metalness={0} transparent opacity={0.2} />
      </mesh>
      <group position={[-1.8, 0.18, 0]}>
        {points.map((point) => {
          const key = `${point.expirationDate}-${point.strike}`
          const position = scalePoint(point)
          const color = pointColor(point.impliedVol)
          const radius = 0.045 + Math.min(0.05, point.impliedVol * 0.03)

          return (
            <mesh
              key={key}
              position={position}
              onPointerEnter={(event) => {
                event.stopPropagation()
                onHoverPoint(point)
              }}
              onPointerLeave={() => onHoverPoint(null)}
            >
              <sphereGeometry args={[radius, 14, 14]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={0.28}
                roughness={0.28}
                metalness={0.08}
              />
            </mesh>
          )
        })}
      </group>
      <OrbitControls enablePan={false} minDistance={3.2} maxDistance={9} enableDamping dampingFactor={0.08} />
    </Canvas>
  )
}
