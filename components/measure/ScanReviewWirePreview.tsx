"use client";

/**
 * components/measure/ScanReviewWirePreview.tsx
 *
 * Fills its parent absolutely. Used by ScanReviewScreen's hero panel.
 * Reuses the same wireframe + gold look as RoomScanWirePreview but
 * without the fixed height / border, so it drops into an aspect-[4/3] box.
 */

import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";

function WireRoom({
  width,
  length,
  height,
}: {
  width: number;
  length: number;
  height: number;
}) {
  const max = Math.max(width, length, height, 0.01);
  const scale = 1.6 / max;
  const sx = width * scale;
  const sy = height * scale;
  const sz = length * scale;
  return (
    <mesh rotation={[0.32, 0.58, 0]}>
      <boxGeometry args={[sx, sy, sz]} />
      <meshStandardMaterial
        color="#b89650"
        metalness={0.15}
        roughness={0.55}
        wireframe
      />
    </mesh>
  );
}

export default function ScanReviewWirePreview({
  widthM,
  lengthM,
  heightM,
}: {
  widthM: number;
  lengthM: number;
  heightM: number;
}) {
  return (
    <div className="absolute inset-0">
      <Canvas
        camera={{ position: [2.2, 1.6, 2.4], fov: 40 }}
        gl={{ antialias: true, alpha: false }}
      >
        {/* Warm editorial background — darker than surface but not pitch black */}
        <color attach="background" args={["#141311"]} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 6, 4]} intensity={1.15} />
        <directionalLight position={[-3, 2, -4]} intensity={0.35} color="#b89650" />
        <Suspense fallback={null}>
          <WireRoom width={widthM} length={lengthM} height={heightM} />
        </Suspense>
      </Canvas>
    </div>
  );
}
