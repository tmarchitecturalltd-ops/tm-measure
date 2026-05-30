"use client";

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
    <mesh rotation={[0.35, 0.55, 0]}>
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

export default function RoomScanWirePreview({
  widthM,
  lengthM,
  heightM,
}: {
  widthM: number;
  lengthM: number;
  heightM: number;
}) {
  return (
    <div className="h-36 w-full overflow-hidden rounded-lg border border-[#b89650]/40 bg-[#0d0d0c] md:h-44">
      <Canvas camera={{ position: [2.2, 1.6, 2.2], fov: 42 }}>
        <color attach="background" args={["#0d0d0c"]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[5, 6, 4]} intensity={1.1} />
        <Suspense fallback={null}>
          <WireRoom width={widthM} length={lengthM} height={heightM} />
        </Suspense>
      </Canvas>
    </div>
  );
}
