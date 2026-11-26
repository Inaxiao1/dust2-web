export interface RadarPoint {
  x: number;
  y: number;
}

export function worldToRadar(
  worldX: number,
  worldZ: number,
  centerX: number,
  centerZ: number,
  yaw: number,
  rotateWithCamera: boolean,
  size: number,
  scale = 2.6,
): RadarPoint {
  const dx = worldX - centerX;
  const dz = worldZ - centerZ;
  let rx = dx;
  let rz = dz;
  if (rotateWithCamera) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    rx = dx * c - dz * s;
    rz = dx * s + dz * c;
  }
  const half = size / 2;
  const clampedX = Math.max(-half + 6, Math.min(half - 6, rx * scale));
  const clampedY = Math.max(-half + 6, Math.min(half - 6, rz * scale));
  return { x: half + clampedX, y: half + clampedY };
}
