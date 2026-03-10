import { Canvas, useFrame } from '@react-three/fiber'
import { ScrollControls, useScroll, useGLTF } from '@react-three/drei'
import { useMemo, useRef, useLayoutEffect, useState, useCallback } from 'react'
import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Curve
// ---------------------------------------------------------------------------
const SPINE = new THREE.CatmullRomCurve3([
  new THREE.Vector3( 0.0,  0.0,   0),
  new THREE.Vector3( 1.8,  0.4,  -7),
  new THREE.Vector3(-1.2,  0.9, -14),
  new THREE.Vector3( 2.2,  0.5, -21),
  new THREE.Vector3( 0.4,  1.2, -28),
  new THREE.Vector3(-2.0,  0.7, -35),
  new THREE.Vector3( 1.0,  0.3, -42),
  new THREE.Vector3(-0.5,  0.8, -49),
  new THREE.Vector3( 0.0,  0.4, -56),
])

const SEGMENTS    = 240
const TIGHT_AHEAD = 0.015
const FAR_AHEAD   = 0.25
const FOCUS_RATIO = 0.10
const EYE_HEIGHT  = 1.6

// ---------------------------------------------------------------------------
// Shared textures
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Sky — grainy orange sunset gradient on a large inside-facing sphere
// ---------------------------------------------------------------------------
function makeSkyTexture(): THREE.Texture {
  const w = 1024, h = 512
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')!

  // V=0 is the top of the sphere (as seen from inside), V=1 is the bottom
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0.00, '#a8c8e8')  // zenith — deeper sky blue
  grad.addColorStop(0.20, '#c0daf0')  // upper — soft sky blue
  grad.addColorStop(0.42, '#d8e8f5')  // mid — pale blue-white
  grad.addColorStop(0.62, '#e5eef6')  // lower mid — cool white with blue
  grad.addColorStop(0.80, '#eef4f8')  // lower — soft blue-white
  grad.addColorStop(1.00, '#f0f5fa')  // horizon — misty pale blue
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  // Film grain via LCG PRNG — slightly stronger so it reads over pastels
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  let s = 0xf0e1d2c3
  for (let i = 0; i < d.length; i += 4) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0
    const n = ((s >>> 0) / 0xffffffff - 0.5) * 38
    d[i]     = Math.max(0, Math.min(255, d[i]     + n))
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n * 0.75))
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n * 0.85))
  }
  ctx.putImageData(img, 0, 0)

  return new THREE.CanvasTexture(canvas)
}

function SkyBackground() {
  const texture = useMemo(() => makeSkyTexture(), [])
  return (
    <mesh>
      <sphereGeometry args={[190, 32, 16]} />
      <meshBasicMaterial map={texture} side={THREE.BackSide} />
    </mesh>
  )
}

function makeOrbTexture(): THREE.Texture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0,    'rgba(255, 210, 140, 1.0)')
  g.addColorStop(0.25, 'rgba(255, 190, 110, 0.6)')
  g.addColorStop(0.6,  'rgba(240, 160,  80, 0.15)')
  g.addColorStop(1,    'rgba(220, 130,  60, 0.0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

// Cloud blob templates — clean cartoon shapes (unit-scale).
// Group scale = cloudScale; mesh scale = blob.r → world radius = cloudScale * blob.r.
type CloudBlob = { pos: [number, number, number]; r: number }
const CLOUD_TEMPLATES: CloudBlob[][] = [
  // A — classic puffy (round bumpy top)
  [
    { pos: [ 0.00,  0.00,  0.00], r: 1.00 },
    { pos: [-0.75,  0.20,  0.00], r: 0.72 },
    { pos: [ 0.75,  0.22,  0.00], r: 0.68 },
    { pos: [ 0.00,  0.72,  0.00], r: 0.64 },
    { pos: [-0.38,  0.95,  0.00], r: 0.50 },
    { pos: [ 0.38,  0.95,  0.00], r: 0.48 },
  ],
  // B — tall tower
  [
    { pos: [ 0.00,  0.00,  0.00], r: 1.00 },
    { pos: [-0.65,  0.10,  0.00], r: 0.80 },
    { pos: [ 0.65,  0.12,  0.00], r: 0.76 },
    { pos: [ 0.00,  0.88,  0.00], r: 0.70 },
    { pos: [ 0.00,  1.58,  0.00], r: 0.54 },
    { pos: [-0.28,  1.50,  0.00], r: 0.38 },
  ],
  // C — wide low bank
  [
    { pos: [ 0.00,  0.00,  0.00], r: 1.00 },
    { pos: [-1.10,  0.00,  0.00], r: 0.78 },
    { pos: [ 1.10,  0.00,  0.00], r: 0.76 },
    { pos: [-1.88, -0.05,  0.00], r: 0.54 },
    { pos: [ 1.88, -0.05,  0.00], r: 0.52 },
    { pos: [ 0.00,  0.58,  0.00], r: 0.52 },
  ],
]

// [tFrac, lateralWorldOffset, vertOffset, scale, templateIndex, color]
// Smaller scales (2.5-4.5), pushed further sideways (±8-14), warm sunset palette.
const CLOUD_SEED: [number, number, number, number, number, string][] = [
  // ── FAR LEFT (outer layer) ── massive cloud wall
  [0.01, -18.0,  1.0, 5.0, 0, '#d8eaf8'],
  [0.04, -20.0, -0.5, 5.5, 1, '#e0f0fa'],
  [0.07, -17.0,  2.0, 4.8, 2, '#e8f4fc'],
  [0.10, -22.0,  0.0, 6.0, 0, '#d5e8f5'],
  [0.13, -19.0,  1.5, 5.2, 1, '#f0f8ff'],
  [0.16, -21.0, -1.0, 5.8, 2, '#e5f2fa'],
  [0.19, -18.0,  0.5, 5.0, 0, '#ecf6fc'],
  [0.22, -20.0,  2.0, 5.5, 1, '#e8f4fc'],
  [0.25, -17.0, -0.5, 4.8, 2, '#f0f8ff'],
  [0.28, -22.0,  1.0, 6.0, 0, '#d8eaf8'],
  [0.31, -19.0,  0.0, 5.2, 1, '#e0f0fa'],
  [0.34, -21.0,  1.5, 5.8, 2, '#e5f2fa'],
  [0.37, -18.0, -1.0, 5.0, 0, '#ecf6fc'],
  [0.40, -20.0,  0.5, 5.5, 1, '#f0f8ff'],
  [0.43, -17.0,  2.0, 4.8, 2, '#e8f4fc'],
  [0.46, -22.0, -0.5, 6.0, 0, '#d5e8f5'],
  [0.49, -19.0,  1.0, 5.2, 1, '#e0f0fa'],
  [0.52, -21.0,  0.0, 5.8, 2, '#e5f2fa'],
  [0.55, -18.0,  1.5, 5.0, 0, '#f0f8ff'],
  [0.58, -20.0, -1.0, 5.5, 1, '#ecf6fc'],
  [0.61, -17.0,  0.5, 4.8, 2, '#e8f4fc'],
  [0.64, -22.0,  2.0, 6.0, 0, '#d8eaf8'],
  [0.67, -19.0, -0.5, 5.2, 1, '#e0f0fa'],
  [0.70, -21.0,  1.0, 5.8, 2, '#e5f2fa'],
  [0.73, -18.0,  0.0, 5.0, 0, '#f0f8ff'],
  [0.76, -20.0,  1.5, 5.5, 1, '#ecf6fc'],
  [0.79, -17.0, -1.0, 4.8, 2, '#e8f4fc'],
  [0.82, -22.0,  0.5, 6.0, 0, '#d5e8f5'],
  [0.85, -19.0,  2.0, 5.2, 1, '#e0f0fa'],
  [0.88, -21.0, -0.5, 5.8, 2, '#e5f2fa'],
  [0.91, -18.0,  1.0, 5.0, 0, '#f0f8ff'],
  [0.94, -20.0,  0.0, 5.5, 1, '#ecf6fc'],
  [0.97, -17.0,  1.5, 4.8, 2, '#e8f4fc'],
  // ── MID LEFT ──
  [0.02, -14.0,  0.5, 4.2, 0, '#e8f4fc'],
  [0.05, -12.0, -1.0, 3.8, 2, '#f0f8ff'],
  [0.08, -15.0,  1.5, 4.5, 1, '#e0f0fa'],
  [0.11, -13.0,  0.0, 4.0, 0, '#ffffff'],
  [0.14, -16.0, -0.5, 4.8, 2, '#e5f2fa'],
  [0.17, -14.0,  2.0, 4.2, 1, '#ecf6fc'],
  [0.20, -12.0,  0.5, 3.8, 0, '#f0f8ff'],
  [0.23, -15.0, -1.0, 4.5, 2, '#e8f4fc'],
  [0.26, -13.0,  1.0, 4.0, 1, '#ffffff'],
  [0.29, -16.0,  0.0, 4.8, 0, '#e0f0fa'],
  [0.32, -14.0,  1.5, 4.2, 2, '#e5f2fa'],
  [0.35, -12.0, -0.5, 3.8, 1, '#f0f8ff'],
  [0.38, -15.0,  0.5, 4.5, 0, '#ecf6fc'],
  [0.41, -13.0,  2.0, 4.0, 2, '#e8f4fc'],
  [0.44, -16.0, -1.0, 4.8, 1, '#ffffff'],
  [0.47, -14.0,  0.0, 4.2, 0, '#e0f0fa'],
  [0.50, -12.0,  1.0, 3.8, 2, '#e5f2fa'],
  [0.53, -15.0,  1.5, 4.5, 1, '#f0f8ff'],
  [0.56, -13.0, -0.5, 4.0, 0, '#ecf6fc'],
  [0.59, -16.0,  0.5, 4.8, 2, '#e8f4fc'],
  [0.62, -14.0, -1.0, 4.2, 1, '#ffffff'],
  [0.65, -12.0,  2.0, 3.8, 0, '#e0f0fa'],
  [0.68, -15.0,  0.0, 4.5, 2, '#e5f2fa'],
  [0.71, -13.0,  1.0, 4.0, 1, '#f0f8ff'],
  [0.74, -16.0,  1.5, 4.8, 0, '#ecf6fc'],
  [0.77, -14.0, -0.5, 4.2, 2, '#e8f4fc'],
  [0.80, -12.0,  0.5, 3.8, 1, '#ffffff'],
  [0.83, -15.0, -1.0, 4.5, 0, '#e0f0fa'],
  [0.86, -13.0,  2.0, 4.0, 2, '#e5f2fa'],
  [0.89, -16.0,  0.0, 4.8, 1, '#f0f8ff'],
  [0.92, -14.0,  1.0, 4.2, 0, '#ecf6fc'],
  [0.95, -12.0,  1.5, 3.8, 2, '#e8f4fc'],
  [0.98, -15.0, -0.5, 4.5, 1, '#ffffff'],
  // ── INNER LEFT (closer to path) ──
  [0.03, -10.0,  0.5, 3.2, 0, '#f5faff'],
  [0.06,  -9.0,  1.0, 2.8, 1, '#ffffff'],
  [0.09, -11.0, -0.5, 3.5, 2, '#ecf6fc'],
  [0.12, -10.0,  1.5, 3.2, 0, '#f0f8ff'],
  [0.15,  -9.0,  0.0, 2.8, 1, '#e8f4fc'],
  [0.18, -11.0,  0.5, 3.5, 2, '#ffffff'],
  [0.21, -10.0, -1.0, 3.2, 0, '#f5faff'],
  [0.24,  -9.0,  2.0, 2.8, 1, '#ecf6fc'],
  [0.27, -11.0,  1.0, 3.5, 2, '#f0f8ff'],
  [0.30, -10.0,  0.0, 3.2, 0, '#e8f4fc'],
  [0.33,  -9.0,  1.5, 2.8, 1, '#ffffff'],
  [0.36, -11.0, -0.5, 3.5, 2, '#f5faff'],
  [0.39, -10.0,  0.5, 3.2, 0, '#ecf6fc'],
  [0.42,  -9.0, -1.0, 2.8, 1, '#f0f8ff'],
  [0.45, -11.0,  2.0, 3.5, 2, '#e8f4fc'],
  [0.48, -10.0,  1.0, 3.2, 0, '#ffffff'],
  [0.51,  -9.0,  0.0, 2.8, 1, '#f5faff'],
  [0.54, -11.0,  1.5, 3.5, 2, '#ecf6fc'],
  [0.57, -10.0, -0.5, 3.2, 0, '#f0f8ff'],
  [0.60,  -9.0,  0.5, 2.8, 1, '#e8f4fc'],
  [0.63, -11.0, -1.0, 3.5, 2, '#ffffff'],
  [0.66, -10.0,  2.0, 3.2, 0, '#f5faff'],
  [0.69,  -9.0,  1.0, 2.8, 1, '#ecf6fc'],
  [0.72, -11.0,  0.0, 3.5, 2, '#f0f8ff'],
  [0.75, -10.0,  1.5, 3.2, 0, '#e8f4fc'],
  [0.78,  -9.0, -0.5, 2.8, 1, '#ffffff'],
  [0.81, -11.0,  0.5, 3.5, 2, '#f5faff'],
  [0.84, -10.0, -1.0, 3.2, 0, '#ecf6fc'],
  [0.87,  -9.0,  2.0, 2.8, 1, '#f0f8ff'],
  [0.90, -11.0,  1.0, 3.5, 2, '#e8f4fc'],
  [0.93, -10.0,  0.0, 3.2, 0, '#ffffff'],
  [0.96,  -9.0,  1.5, 2.8, 1, '#f5faff'],
  [0.99, -11.0, -0.5, 3.5, 2, '#ecf6fc'],
  // ── FAR RIGHT (outer layer) ── massive cloud wall
  [0.02,  18.0,  0.5, 5.0, 0, '#d8eaf8'],
  [0.05,  20.0,  1.5, 5.5, 1, '#e0f0fa'],
  [0.08,  17.0, -0.5, 4.8, 2, '#e8f4fc'],
  [0.11,  22.0,  1.0, 6.0, 0, '#d5e8f5'],
  [0.14,  19.0,  0.0, 5.2, 1, '#f0f8ff'],
  [0.17,  21.0,  2.0, 5.8, 2, '#e5f2fa'],
  [0.20,  18.0, -1.0, 5.0, 0, '#ecf6fc'],
  [0.23,  20.0,  0.5, 5.5, 1, '#e8f4fc'],
  [0.26,  17.0,  1.5, 4.8, 2, '#f0f8ff'],
  [0.29,  22.0, -0.5, 6.0, 0, '#d8eaf8'],
  [0.32,  19.0,  1.0, 5.2, 1, '#e0f0fa'],
  [0.35,  21.0,  0.0, 5.8, 2, '#e5f2fa'],
  [0.38,  18.0,  2.0, 5.0, 0, '#ecf6fc'],
  [0.41,  20.0, -1.0, 5.5, 1, '#f0f8ff'],
  [0.44,  17.0,  0.5, 4.8, 2, '#e8f4fc'],
  [0.47,  22.0,  1.5, 6.0, 0, '#d5e8f5'],
  [0.50,  19.0, -0.5, 5.2, 1, '#e0f0fa'],
  [0.53,  21.0,  1.0, 5.8, 2, '#e5f2fa'],
  [0.56,  18.0,  0.0, 5.0, 0, '#f0f8ff'],
  [0.59,  20.0,  2.0, 5.5, 1, '#ecf6fc'],
  [0.62,  17.0, -1.0, 4.8, 2, '#e8f4fc'],
  [0.65,  22.0,  0.5, 6.0, 0, '#d8eaf8'],
  [0.68,  19.0,  1.5, 5.2, 1, '#e0f0fa'],
  [0.71,  21.0, -0.5, 5.8, 2, '#e5f2fa'],
  [0.74,  18.0,  1.0, 5.0, 0, '#f0f8ff'],
  [0.77,  20.0,  0.0, 5.5, 1, '#ecf6fc'],
  [0.80,  17.0,  2.0, 4.8, 2, '#e8f4fc'],
  [0.83,  22.0, -1.0, 6.0, 0, '#d5e8f5'],
  [0.86,  19.0,  0.5, 5.2, 1, '#e0f0fa'],
  [0.89,  21.0,  1.5, 5.8, 2, '#e5f2fa'],
  [0.92,  18.0, -0.5, 5.0, 0, '#f0f8ff'],
  [0.95,  20.0,  1.0, 5.5, 1, '#ecf6fc'],
  [0.98,  17.0,  0.0, 4.8, 2, '#e8f4fc'],
  // ── MID RIGHT ──
  [0.01,  14.0,  0.0, 4.2, 0, '#e8f4fc'],
  [0.04,  12.0,  1.5, 3.8, 2, '#f0f8ff'],
  [0.07,  15.0, -0.5, 4.5, 1, '#e0f0fa'],
  [0.10,  13.0,  1.0, 4.0, 0, '#ffffff'],
  [0.13,  16.0,  0.5, 4.8, 2, '#e5f2fa'],
  [0.16,  14.0, -1.0, 4.2, 1, '#ecf6fc'],
  [0.19,  12.0,  2.0, 3.8, 0, '#f0f8ff'],
  [0.22,  15.0,  0.0, 4.5, 2, '#e8f4fc'],
  [0.25,  13.0,  1.5, 4.0, 1, '#ffffff'],
  [0.28,  16.0, -0.5, 4.8, 0, '#e0f0fa'],
  [0.31,  14.0,  1.0, 4.2, 2, '#e5f2fa'],
  [0.34,  12.0,  0.5, 3.8, 1, '#f0f8ff'],
  [0.37,  15.0, -1.0, 4.5, 0, '#ecf6fc'],
  [0.40,  13.0,  2.0, 4.0, 2, '#e8f4fc'],
  [0.43,  16.0,  0.0, 4.8, 1, '#ffffff'],
  [0.46,  14.0,  1.5, 4.2, 0, '#e0f0fa'],
  [0.49,  12.0, -0.5, 3.8, 2, '#e5f2fa'],
  [0.52,  15.0,  1.0, 4.5, 1, '#f0f8ff'],
  [0.55,  13.0,  0.5, 4.0, 0, '#ecf6fc'],
  [0.58,  16.0, -1.0, 4.8, 2, '#e8f4fc'],
  [0.61,  14.0,  2.0, 4.2, 1, '#ffffff'],
  [0.64,  12.0,  0.0, 3.8, 0, '#e0f0fa'],
  [0.67,  15.0,  1.5, 4.5, 2, '#e5f2fa'],
  [0.70,  13.0, -0.5, 4.0, 1, '#f0f8ff'],
  [0.73,  16.0,  1.0, 4.8, 0, '#ecf6fc'],
  [0.76,  14.0,  0.5, 4.2, 2, '#e8f4fc'],
  [0.79,  12.0, -1.0, 3.8, 1, '#ffffff'],
  [0.82,  15.0,  2.0, 4.5, 0, '#e0f0fa'],
  [0.85,  13.0,  0.0, 4.0, 2, '#e5f2fa'],
  [0.88,  16.0,  1.5, 4.8, 1, '#f0f8ff'],
  [0.91,  14.0, -0.5, 4.2, 0, '#ecf6fc'],
  [0.94,  12.0,  1.0, 3.8, 2, '#e8f4fc'],
  [0.97,  15.0,  0.5, 4.5, 1, '#ffffff'],
  // ── INNER RIGHT (closer to path) ──
  [0.03,  10.0,  0.0, 3.2, 0, '#f5faff'],
  [0.06,   9.0,  1.5, 2.8, 1, '#ffffff'],
  [0.09,  11.0, -0.5, 3.5, 2, '#ecf6fc'],
  [0.12,  10.0,  1.0, 3.2, 0, '#f0f8ff'],
  [0.15,   9.0,  0.5, 2.8, 1, '#e8f4fc'],
  [0.18,  11.0, -1.0, 3.5, 2, '#ffffff'],
  [0.21,  10.0,  2.0, 3.2, 0, '#f5faff'],
  [0.24,   9.0,  0.0, 2.8, 1, '#ecf6fc'],
  [0.27,  11.0,  1.5, 3.5, 2, '#f0f8ff'],
  [0.30,  10.0, -0.5, 3.2, 0, '#e8f4fc'],
  [0.33,   9.0,  1.0, 2.8, 1, '#ffffff'],
  [0.36,  11.0,  0.5, 3.5, 2, '#f5faff'],
  [0.39,  10.0, -1.0, 3.2, 0, '#ecf6fc'],
  [0.42,   9.0,  2.0, 2.8, 1, '#f0f8ff'],
  [0.45,  11.0,  0.0, 3.5, 2, '#e8f4fc'],
  [0.48,  10.0,  1.5, 3.2, 0, '#ffffff'],
  [0.51,   9.0, -0.5, 2.8, 1, '#f5faff'],
  [0.54,  11.0,  1.0, 3.5, 2, '#ecf6fc'],
  [0.57,  10.0,  0.5, 3.2, 0, '#f0f8ff'],
  [0.60,   9.0, -1.0, 2.8, 1, '#e8f4fc'],
  [0.63,  11.0,  2.0, 3.5, 2, '#ffffff'],
  [0.66,  10.0,  0.0, 3.2, 0, '#f5faff'],
  [0.69,   9.0,  1.5, 2.8, 1, '#ecf6fc'],
  [0.72,  11.0, -0.5, 3.5, 2, '#f0f8ff'],
  [0.75,  10.0,  1.0, 3.2, 0, '#e8f4fc'],
  [0.78,   9.0,  0.5, 2.8, 1, '#ffffff'],
  [0.81,  11.0, -1.0, 3.5, 2, '#f5faff'],
  [0.84,  10.0,  2.0, 3.2, 0, '#ecf6fc'],
  [0.87,   9.0,  0.0, 2.8, 1, '#f0f8ff'],
  [0.90,  11.0,  1.5, 3.5, 2, '#e8f4fc'],
  [0.93,  10.0, -0.5, 3.2, 0, '#ffffff'],
  [0.96,   9.0,  1.0, 2.8, 1, '#f5faff'],
  [0.99,  11.0,  0.5, 3.5, 2, '#ecf6fc'],
  // ── BELOW PATH (underneath mist layer) ──
  [0.02,  -4.0, -4.5, 4.0, 2, '#e8f2fa'],
  [0.06,   4.0, -5.0, 4.2, 0, '#f0f8ff'],
  [0.10,  -5.0, -4.0, 3.8, 1, '#dceef8'],
  [0.14,   5.0, -4.5, 4.0, 2, '#e5f2fa'],
  [0.18,  -4.5, -5.0, 4.2, 0, '#f0f8ff'],
  [0.22,   4.5, -4.0, 3.8, 1, '#e8f4fc'],
  [0.26,  -5.0, -4.5, 4.0, 2, '#ecf6fc'],
  [0.30,   5.0, -5.0, 4.2, 0, '#f0f8ff'],
  [0.34,  -4.0, -4.0, 3.8, 1, '#dceef8'],
  [0.38,   4.0, -4.5, 4.0, 2, '#e5f2fa'],
  [0.42,  -5.0, -5.0, 4.2, 0, '#f0f8ff'],
  [0.46,   5.0, -4.0, 3.8, 1, '#e8f4fc'],
  [0.50,  -4.5, -4.5, 4.0, 2, '#ecf6fc'],
  [0.54,   4.5, -5.0, 4.2, 0, '#f0f8ff'],
  [0.58,  -5.0, -4.0, 3.8, 1, '#dceef8'],
  [0.62,   5.0, -4.5, 4.0, 2, '#e5f2fa'],
  [0.66,  -4.0, -5.0, 4.2, 0, '#f0f8ff'],
  [0.70,   4.0, -4.0, 3.8, 1, '#e8f4fc'],
  [0.74,  -5.0, -4.5, 4.0, 2, '#ecf6fc'],
  [0.78,   5.0, -5.0, 4.2, 0, '#f0f8ff'],
  [0.82,  -4.5, -4.0, 3.8, 1, '#dceef8'],
  [0.86,   4.5, -4.5, 4.0, 2, '#e5f2fa'],
  [0.90,  -5.0, -5.0, 4.2, 0, '#f0f8ff'],
  [0.94,   5.0, -4.0, 3.8, 1, '#e8f4fc'],
  [0.98,  -4.0, -4.5, 4.0, 2, '#ecf6fc'],
]

// ---------------------------------------------------------------------------
// Golden path — swept ribbon with warm canvas texture, kerbs, and underglow
// ---------------------------------------------------------------------------
// Path dimensions — outer kerb edge sits at PATH_HALF_W + 2*CURB_HALF_W = 2.56 units from center.
// Clouds must stay beyond ~6 units laterally from any path point to avoid intersection.
const PATH_HALF_W = 1.7
const CURB_HALF_W = 0.28
const CURB_LIFT   = 0.32
const CURB_OFF    = PATH_HALF_W + CURB_HALF_W  // kerb centre; inner edge flush with deck edge

const seededRand = (s: number) => ((s * 16807 + 7) % 2147483647) / 2147483647

// Shared tangent helpers — returns XZ-projected right vector at parameter t
function getRightAt(t: number, tan = new THREE.Vector3()) {
  SPINE.getTangentAt(t, tan).normalize()
  const rx = -tan.z, rz = tan.x
  const rl = Math.hypot(rx, rz) || 1
  return { rnx: rx / rl, rnz: rz / rl }
}

// Flat horizontal ribbon swept along SPINE
function buildRibbon(halfW: number, lateralOff: number, heightOff: number): THREE.BufferGeometry {
  const positions: number[] = []
  const normals:   number[] = []
  const uvs:       number[] = []
  const indices:   number[] = []

  const pt  = new THREE.Vector3()
  const tan = new THREE.Vector3()

  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS
    SPINE.getPoint(t, pt)
    const { rnx, rnz } = getRightAt(t, tan)

    const cx = pt.x + rnx * lateralOff
    const cy = pt.y + heightOff
    const cz = pt.z + rnz * lateralOff

    positions.push(
      cx - rnx * halfW, cy, cz - rnz * halfW,
      cx + rnx * halfW, cy, cz + rnz * halfW
    )
    normals.push(0, 1, 0, 0, 1, 0)
    uvs.push(0, t, 1, t)
  }

  for (let i = 0; i < SEGMENTS; i++) {
    const b = i * 2
    indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(new Float32Array(normals),   3))
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(new Float32Array(uvs),       2))
  geo.setIndex(indices)
  return geo
}

// Vertical wall swept along SPINE at a given lateral distance.
// side: +1 = right, -1 = left. facingOut: normal points away from path centre.
//
// Winding derivation (right-hand rule, path travels in -Z):
//   Right-inward  (side=1, out=false): (b,b+1,b+2) → normal -X ✓
//   Left-inward   (side=-1,out=false): (b,b+2,b+1) → normal +X ✓
//   Flip both for outward-facing.
//   Condition: (side===1) !== facingOut selects the two winding families.
function buildVerticalWall(
  lateralDist: number,
  side: 1 | -1,
  facingOut: boolean
): THREE.BufferGeometry {
  const positions: number[] = []
  const normals:   number[] = []
  const uvs:       number[] = []
  const indices:   number[] = []

  const pt  = new THREE.Vector3()
  const tan = new THREE.Vector3()

  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS
    SPINE.getPoint(t, pt)
    const { rnx, rnz } = getRightAt(t, tan)

    const sx = rnx * side
    const sz = rnz * side
    const ex = pt.x + sx * lateralDist
    const ez = pt.z + sz * lateralDist
    const nx = facingOut ? sx : -sx
    const nz = facingOut ? sz : -sz

    positions.push(ex, pt.y,             ez)   // bottom
    positions.push(ex, pt.y + CURB_LIFT, ez)   // top
    normals.push(nx, 0, nz,  nx, 0, nz)
    uvs.push(0, t,  1, t)
  }

  for (let i = 0; i < SEGMENTS; i++) {
    const b = i * 2
    if ((side === 1) !== facingOut) {
      indices.push(b, b + 1, b + 2,  b + 1, b + 3, b + 2)
    } else {
      indices.push(b, b + 2, b + 1,  b + 1, b + 2, b + 3)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(new Float32Array(normals),   3))
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(new Float32Array(uvs),       2))
  geo.setIndex(indices)
  return geo
}

function makeCobblestoneMap(): THREE.CanvasTexture {
  const W = 1024, H = 512
  const COLS = 4, ROWS_T = 8
  const SW = W / COLS
  const SH = H / ROWS_T
  const GROUT = 5

  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#847260'
  ctx.fillRect(0, 0, W, H)

  for (let row = 0; row < ROWS_T; row++) {
    const xOff = (row % 2 === 0) ? 0 : SW * 0.5
    for (let col = -1; col <= COLS; col++) {
      const x = col * SW + xOff + GROUT
      const y = row * SH + GROUT
      const w = SW - GROUT * 2
      const h = SH - GROUT * 2

      const v = 0.78 + (seededRand(row * 17 + (col + 2) * 7) - 0.5) * 0.10
      const r = Math.round(222 * v)
      const g = Math.round(207 * v)
      const b = Math.round(181 * v)

      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(x, y, w, h)

      const hlH = Math.round(h * 0.22)
      const hl  = ctx.createLinearGradient(x, y, x, y + hlH)
      hl.addColorStop(0, 'rgba(255,255,255,0.09)')
      hl.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = hl
      ctx.fillRect(x, y, w, hlH)

      const shH = Math.round(h * 0.18)
      const sh  = ctx.createLinearGradient(x, y + h - shH, x, y + h)
      sh.addColorStop(0, 'rgba(0,0,0,0)')
      sh.addColorStop(1, 'rgba(0,0,0,0.06)')
      ctx.fillStyle = sh
      ctx.fillRect(x, y + h - shH, w, shH)
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(1, 20)
  return tex
}

function GoldenPath() {
  const { mainGeo, leftKerbGeo, rightKerbGeo, leftWallGeo, rightWallGeo,
          leftOuterWallGeo, rightOuterWallGeo, underGeo,
          mainMat, kerbMat, underMat } = useMemo(() => {
    const cobbleMap = makeCobblestoneMap()

    const mainGeo      = buildRibbon(PATH_HALF_W, 0,         0)
    const leftKerbGeo  = buildRibbon(CURB_HALF_W, -CURB_OFF, CURB_LIFT)
    const rightKerbGeo = buildRibbon(CURB_HALF_W,  CURB_OFF, CURB_LIFT)
    // Inner walls: inward-facing, visible from the path deck
    const leftWallGeo  = buildVerticalWall(PATH_HALF_W, -1, false)
    const rightWallGeo = buildVerticalWall(PATH_HALF_W,  1, false)
    // Outer kerb walls: outward-facing, complete the raised curb profile
    const leftOuterWallGeo  = buildVerticalWall(CURB_OFF + CURB_HALF_W, -1, true)
    const rightOuterWallGeo = buildVerticalWall(CURB_OFF + CURB_HALF_W,  1, true)
    const underGeo     = buildRibbon(PATH_HALF_W + 0.8, 0,   -0.32)

    const mainMat = new THREE.MeshStandardMaterial({
      map:               cobbleMap,
      emissive:          new THREE.Color('#c8a060'),
      emissiveIntensity: 0.06,
      roughness:         0.78,
      metalness:         0.02,
    })

    const kerbMat = new THREE.MeshStandardMaterial({
      color:             new THREE.Color('#e6dcc6'),
      emissive:          new THREE.Color('#d4a850'),
      emissiveIntensity: 0.14,
      roughness:         0.65,
      metalness:         0.04,
    })

    const underMat = new THREE.MeshStandardMaterial({
      color:             new THREE.Color('#ffc050'),
      emissive:          new THREE.Color('#ffc050'),
      emissiveIntensity: 1.0,
      transparent:       true,
      opacity:           0.06,
      depthWrite:        false,
      blending:          THREE.AdditiveBlending,
      side:              THREE.DoubleSide,
    })

    return { mainGeo, leftKerbGeo, rightKerbGeo, leftWallGeo, rightWallGeo, leftOuterWallGeo, rightOuterWallGeo, underGeo, mainMat, kerbMat, underMat }
  }, [])

  return (
    <group>
      <mesh geometry={mainGeo}       material={mainMat} />
      <mesh geometry={leftKerbGeo}   material={kerbMat} />
      <mesh geometry={rightKerbGeo}  material={kerbMat} />
      <mesh geometry={leftWallGeo}        material={kerbMat} />
      <mesh geometry={rightWallGeo}       material={kerbMat} />
      <mesh geometry={leftOuterWallGeo}   material={kerbMat} />
      <mesh geometry={rightOuterWallGeo}  material={kerbMat} />
      <mesh geometry={underGeo}           material={underMat} renderOrder={-1} />
    </group>
  )
}

// ---------------------------------------------------------------------------
// Orb particles
// ---------------------------------------------------------------------------
const ORB_COUNT = 500

function OrbParticles() {
  const ref = useRef<THREE.Points>(null)
  const texture = useMemo(() => makeOrbTexture(), [])

  const { basePositions, speeds, offsets } = useMemo(() => {
    const basePositions = new Float32Array(ORB_COUNT * 3)
    const speeds        = new Float32Array(ORB_COUNT)
    const offsets       = new Float32Array(ORB_COUNT)
    for (let i = 0; i < ORB_COUNT; i++) {
      const base   = SPINE.getPointAt(Math.random())
      const spread = Math.random() < 0.7 ? 20 : 40
      basePositions[i * 3 + 0] = base.x + (Math.random() - 0.5) * spread
      basePositions[i * 3 + 1] = base.y + Math.random() * 5
      basePositions[i * 3 + 2] = base.z + (Math.random() - 0.5) * 10
      speeds[i]  = 0.04 + Math.random() * 0.07
      offsets[i] = Math.random() * Math.PI * 2
    }
    return { basePositions, speeds, offsets }
  }, [])

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(basePositions.slice(), 3))
    return geo
  }, [basePositions])

  useFrame(({ clock }) => {
    if (!ref.current) return
    const pos = ref.current.geometry.attributes.position
    const t   = clock.getElapsedTime()
    for (let i = 0; i < ORB_COUNT; i++) {
      const drift = (t * speeds[i] + offsets[i]) % 4.0
      const sway  = Math.sin(t * speeds[i] * 1.3 + offsets[i]) * 0.3
      pos.setX(i, basePositions[i * 3 + 0] + sway)
      pos.setY(i, basePositions[i * 3 + 1] + drift)
    }
    pos.needsUpdate = true
  })

  return (
    <points ref={ref} geometry={geometry}>
      <pointsMaterial
        map={texture} size={0.38} transparent opacity={0.13}
        sizeAttenuation depthWrite={false}
        blending={THREE.AdditiveBlending} alphaTest={0.005}
      />
    </points>
  )
}

// ---------------------------------------------------------------------------
// Cartoon clouds — one InstancedMesh per color group (~8 draw calls vs ~400)
// Fixed material color per group → toon shading + lighting work correctly.
// ---------------------------------------------------------------------------
const CLOUD_TOON_GRADIENT = (() => {
  const data = new Uint8Array([180, 245])
  const tex = new THREE.DataTexture(data, 2, 1, THREE.RedFormat)
  tex.minFilter = tex.magFilter = THREE.NearestFilter
  tex.needsUpdate = true
  return tex
})()

function CloudGroup({ color, matrices }: { color: string; matrices: THREE.Matrix4[] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  
  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.count = matrices.length
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
    mesh.instanceMatrix.needsUpdate = true
  }, [matrices])
  
  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, matrices.length]}>
      <sphereGeometry args={[1, 8, 6]} />
      <meshToonMaterial color={color} gradientMap={CLOUD_TOON_GRADIENT} />
    </instancedMesh>
  )
}

// Island hitbox radius - individual cloud blobs are cut off if they intersect this sphere
// Islands have scale 6.0, so radius ~4-5 gives a clean buffer around the model
const ISLAND_HITBOX_RADIUS = 4.5

function CartoonClouds() {
  const groups = useMemo(() => {
    const map = new Map<string, THREE.Matrix4[]>()
    const dummy   = new THREE.Object3D()
    const blobVec = new THREE.Vector3()

    for (const [tFrac, latWorld, vertOff, scale, tmplIdx, colorHex] of CLOUD_SEED) {
      const t       = Math.min(0.999, Math.max(0.001, tFrac))
      const pt      = SPINE.getPointAt(t)
      const tangent = SPINE.getTangentAt(t)
      const right   = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize()
      const cloudPos = pt.clone().addScaledVector(right, latWorld)
      cloudPos.y += vertOff

      if (!map.has(colorHex)) map.set(colorHex, [])
      const bucket = map.get(colorHex)!

      for (const blob of CLOUD_TEMPLATES[tmplIdx]) {
        blobVec.set(blob.pos[0], blob.pos[1], blob.pos[2])
        dummy.position.copy(cloudPos).addScaledVector(blobVec, scale)
        const blobRadius = scale * blob.r
        
        // Boolean cutoff: skip this blob if it intersects any island hitbox sphere
        // Uses extended hitbox positions (main + front sphere for each island)
        let intersectsHitbox = false
        for (const hitboxPos of ISLAND_HITBOX_POSITIONS) {
          const dist = dummy.position.distanceTo(hitboxPos)
          // If blob center + blob radius overlaps with hitbox, skip it
          if (dist < ISLAND_HITBOX_RADIUS + blobRadius) {
            intersectsHitbox = true
            break
          }
        }
        if (intersectsHitbox) continue
        
        dummy.rotation.set(0, 0, 0)
        dummy.scale.setScalar(blobRadius)
        dummy.updateMatrix()
        bucket.push(dummy.matrix.clone())
      }
    }

    return map
  }, [])

  return (
    <>
      {Array.from(groups.entries()).map(([color, matrices]) => (
        <CloudGroup key={color} color={color} matrices={matrices} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Islands — placeholder objects positioned between path pivots
// ---------------------------------------------------------------------------
// Island seed: [tFrac, lateralWorldOffset, vertOffset, scale]
// tFrac positions along path, lateralWorldOffset (±5-7) keeps islands INSIDE the cloud band
// Clouds are at ±8-14.5, so islands at ±5-7 will be visible between path and clouds
// Island project data for UI overlays
const ISLAND_PROJECTS = [
  { title: 'Project Alpha', description: 'A creative web experience', link: 'https://example.com/alpha' },
  { title: 'Project Beta', description: 'Interactive 3D visualization', link: 'https://example.com/beta' },
  { title: 'Project Gamma', description: 'Design system showcase', link: 'https://example.com/gamma' },
  { title: 'Project Delta', description: 'Full-stack application', link: 'https://example.com/delta' },
]

// Global mutable ref for focused island index — written by CameraRig, read by IslandProjectCard
// This avoids React context bridging issues with R3F's separate reconciler
const focusedIslandRef = { current: null as number | null }

const ISLAND_SEED: [number, number, number, number][] = [
  // 4 islands alternating left/right, evenly spaced along path
  // Lowered by ~1.5 units (quarter of scale 6.0), spread out slightly more (±7.5)
  [0.22, -7.5, -1.0, 6.0],   // Left - moved up from 0.18 to be in focusable range
  [0.42,  7.5, -1.1, 6.0],   // Right
  [0.62, -7.5, -1.1, 6.0],   // Left
  [0.85,  7.5, -1.2, 6.0],   // Right
]

// Pre-compute island world positions for camera targeting
const ISLAND_WORLD_POSITIONS = ISLAND_SEED.map(([tFrac, latWorld, vertOff, scale]) => {
  const t = Math.min(0.999, Math.max(0.001, tFrac))
  const pt = SPINE.getPointAt(t)
  const tangent = SPINE.getTangentAt(t)
  const right = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize()
  const pos = pt.clone().addScaledVector(right, latWorld)
  pos.y += vertOff
  return { position: pos, tFrac, scale }
})

// Extended hitbox positions - includes main island position + a "front" sphere
// positioned closer to the viewer (lower tFrac) to extend the hitbox toward approaching camera
const HITBOX_OFFSET_T = 0.04 // How far ahead (toward viewer start) to place the front sphere
const ISLAND_HITBOX_POSITIONS: THREE.Vector3[] = []

for (const [tFrac, latWorld, vertOff] of ISLAND_SEED) {
  // Main island hitbox sphere
  const t = Math.min(0.999, Math.max(0.001, tFrac))
  const pt = SPINE.getPointAt(t)
  const tangent = SPINE.getTangentAt(t)
  const right = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize()
  const mainPos = pt.clone().addScaledVector(right, latWorld)
  mainPos.y += vertOff
  ISLAND_HITBOX_POSITIONS.push(mainPos)
  
  // Front hitbox sphere (closer to camera start position)
  const tFront = Math.max(0.001, tFrac - HITBOX_OFFSET_T)
  const ptFront = SPINE.getPointAt(tFront)
  const tangentFront = SPINE.getTangentAt(tFront)
  const rightFront = new THREE.Vector3().crossVectors(tangentFront, new THREE.Vector3(0, 1, 0)).normalize()
  const frontPos = ptFront.clone().addScaledVector(rightFront, latWorld)
  frontPos.y += vertOff
  ISLAND_HITBOX_POSITIONS.push(frontPos)
}

// Clickable image billboard embedded in the 3D scene above each island.
// Visible only when the island is focused; opens the project link on click.
function IslandProjectImage({ index, project }: { index: number; project: typeof ISLAND_PROJECTS[number] }) {
  const [visible, setVisible] = useState(false)
  const meshRef = useRef<THREE.Mesh>(null)
  const matRef = useRef<THREE.MeshBasicMaterial>(null)

  // Placeholder texture — white plane with project title baked via canvas
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 320
    const ctx = canvas.getContext('2d')!
    // Background
    ctx.fillStyle = '#f1f5f9'
    ctx.fillRect(0, 0, 512, 320)
    // Accent bar
    ctx.fillStyle = '#1d4ed8'
    ctx.fillRect(0, 280, 512, 40)
    // Title
    ctx.fillStyle = '#1a1a2e'
    ctx.font = 'bold 32px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(project.title, 256, 120)
    // Description
    ctx.fillStyle = '#64748b'
    ctx.font = '20px system-ui, sans-serif'
    ctx.fillText(project.description, 256, 170)
    // CTA
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 20px system-ui, sans-serif'
    ctx.fillText('Click to View Project', 256, 306)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }, [project.title, project.description])

  useFrame(({ camera }) => {
    const isFocused = focusedIslandRef.current === index
    if (isFocused !== visible) setVisible(isFocused)

    // Animate opacity
    if (matRef.current) {
      const target = isFocused ? 1 : 0
      matRef.current.opacity += (target - matRef.current.opacity) * 0.12
    }

    // Billboard: always face the camera
    if (meshRef.current) {
      meshRef.current.lookAt(camera.position)
    }
  })

  const handleClick = useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    window.open(project.link, '_blank', 'noopener,noreferrer')
  }, [project.link])

  const handlePointerOver = useCallback(() => {
    document.body.style.cursor = 'pointer'
  }, [])

  const handlePointerOut = useCallback(() => {
    document.body.style.cursor = 'auto'
  }, [])

  return (
    <mesh
      ref={meshRef}
      position={[0, 3.5, 0]}
      onClick={handleClick}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
      raycast={visible ? undefined : () => {}}
    >
      <planeGeometry args={[4, 2.5]} />
      <meshBasicMaterial
        ref={matRef}
        map={texture}
        transparent
        opacity={0}
        depthWrite={false}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  )
}

function IslandPlaceholder() {
  const { scene } = useGLTF('/islandone.glb')

  const islands = useMemo(() => {
    return ISLAND_SEED.map(([tFrac, latWorld, vertOff, scale]) => {
      const t = Math.min(0.999, Math.max(0.001, tFrac))
      const pt = SPINE.getPointAt(t)
      const tangent = SPINE.getTangentAt(t)
      const right = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize()

      const islandPos = pt.clone().addScaledVector(right, latWorld)
      islandPos.y += vertOff

      return { position: islandPos, scale }
    })
  }, [])

  return (
    <>
      {islands.map((island, i) => (
        <group
          key={`island-${i}`}
          position={[island.position.x, island.position.y, island.position.z]}
        >
          <group scale={island.scale}>
            <primitive object={scene.clone()} />
          </group>
          <IslandProjectImage index={i} project={ISLAND_PROJECTS[i]} />
        </group>
      ))}
    </>
  )
}

// Preload the GLB
useGLTF.preload('/islandone.glb')

// ---------------------------------------------------------------------------
// Camera rig — double-interpolated with island focus
// ---------------------------------------------------------------------------
const LERP_A = 0.12
const LERP_B = 0.08

// Island focus parameters
const ISLAND_FOCUS_DISTANCE = 30      // Max distance to consider an island
const ISLAND_FOCUS_CONE_ANGLE = 0.3   // Cosine of max angle (~72 deg) for wider cone
const ISLAND_FOCUS_BLEND = 0.6        // How much to blend toward island (0-1)
const ISLAND_T_AHEAD_MIN = -0.02      // Allow slightly behind to prevent flicker on pass
const ISLAND_T_AHEAD_MAX = 0.22       // Island must be at most this far ahead on path

function CameraRig() {
  const scroll    = useScroll()
  const midPos    = useRef(new THREE.Vector3(0, EYE_HEIGHT, 0))
  const midLook   = useRef(new THREE.Vector3(0, EYE_HEIGHT, -1))
  const finalPos  = useRef(new THREE.Vector3(0, EYE_HEIGHT, 0))
  const finalLook = useRef(new THREE.Vector3(0, EYE_HEIGHT, -1))
  const tempVec   = useRef(new THREE.Vector3())

  useFrame(({ camera }) => {
    const t = scroll.offset

    const targetPos  = SPINE.getPointAt(t)
    const tightLook  = SPINE.getPointAt(Math.min(t + TIGHT_AHEAD, 1))
    const farLook    = SPINE.getPointAt(Math.min(t + FAR_AHEAD,   1))
    let targetLook = tightLook.clone().lerp(farLook, FOCUS_RATIO)

    targetPos.y  += EYE_HEIGHT
    targetLook.y += EYE_HEIGHT

    // Find the best island to focus on
    const camPos = targetPos.clone()
    const camForward = targetLook.clone().sub(camPos).normalize()
    
    let bestIsland: { position: THREE.Vector3; tFrac: number; scale: number; index: number } | null = null
    let bestScore = -Infinity

    for (let i = 0; i < ISLAND_WORLD_POSITIONS.length; i++) {
      const island = ISLAND_WORLD_POSITIONS[i]
      // Check if island is ahead on the path (within range)
      const tDiff = island.tFrac - t
      if (tDiff < ISLAND_T_AHEAD_MIN || tDiff > ISLAND_T_AHEAD_MAX) continue

      // Vector from camera to island
      tempVec.current.copy(island.position).sub(camPos)
      const distance = tempVec.current.length()
      
      // Skip if too far
      if (distance > ISLAND_FOCUS_DISTANCE) continue
      
      // Normalize for dot product (cone check)
      tempVec.current.normalize()
      const dot = camForward.dot(tempVec.current)
      
      // Must be within the forward cone
      if (dot < ISLAND_FOCUS_CONE_ANGLE) continue
      
      // Score: prefer closer islands that are more directly ahead
      // Higher dot = more ahead, lower distance = closer
      const score = dot * 10 - distance * 0.5 + (1 - tDiff / ISLAND_T_AHEAD_MAX) * 5
      
      if (score > bestScore) {
        bestScore = score
        bestIsland = { ...island, index: i }
      }
    }

    // Write to global ref (read by IslandProjectCard via useFrame)
    focusedIslandRef.current = bestIsland ? bestIsland.index : null

    // Blend toward island if found
    if (bestIsland) {
      const islandLookTarget = bestIsland.position.clone()
      targetLook.lerp(islandLookTarget, ISLAND_FOCUS_BLEND)
    }

    midPos.current.lerp(targetPos,   LERP_A)
    midLook.current.lerp(targetLook, LERP_A)
    finalPos.current.lerp(midPos.current,   LERP_B)
    finalLook.current.lerp(midLook.current, LERP_B)

    camera.position.copy(finalPos.current)
    camera.lookAt(finalLook.current)
  })

  return null
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
function Scene() {
  return (
    <>
      <SkyBackground />

      <fog attach="fog" args={['#d8e8f5', 20, 70]} />

      <hemisphereLight args={['#b8d8f0', '#c8d8e8', 1.4]} />
      <directionalLight
        position={[5, 14, -20]} intensity={2.0} color="#fff4e8" castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={0.5} shadow-camera-far={120}
        shadow-camera-left={-20} shadow-camera-right={20}
        shadow-camera-top={10}  shadow-camera-bottom={-10}
      />

      <GoldenPath />

      <CartoonClouds />
      <IslandPlaceholder />
      <OrbParticles />
      <CameraRig />
    </>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  return (
    <Canvas shadows camera={{ position: [0, 1.6, 0], fov: 72, near: 0.1, far: 200 }}>
      <ScrollControls pages={6} damping={0.25}>
        <Scene />
      </ScrollControls>
    </Canvas>
  )
}
