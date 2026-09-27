// Shared voxel collision for the player and mobs: an upright box (feet
// center `pos`, half-width `r`, height `h`) moved one axis at a time.

const EPS = 1e-4;

// Returns how far the box may move along `axis` ("x" | "y" | "z") toward
// `delta` (same sign, magnitude <= |delta|) before it would overlap a solid
// block, given its current position on the other two axes.
export function sweepAxis(world, pos, r, h, axis, delta) {
  if (delta === 0) return 0;
  let minX = pos.x - r;
  let maxX = pos.x + r;
  let minY = pos.y;
  let maxY = pos.y + h;
  let minZ = pos.z - r;
  let maxZ = pos.z + r;

  if (axis === "x") {
    if (delta > 0) maxX += delta;
    else minX += delta;
  } else if (axis === "y") {
    if (delta > 0) maxY += delta;
    else minY += delta;
  } else {
    if (delta > 0) maxZ += delta;
    else minZ += delta;
  }

  const bx0 = Math.floor(minX);
  const bx1 = Math.floor(maxX - EPS);
  const by0 = Math.floor(minY);
  const by1 = Math.floor(maxY - EPS);
  const bz0 = Math.floor(minZ);
  const bz1 = Math.floor(maxZ - EPS);

  let allowed = delta;
  for (let bx = bx0; bx <= bx1; bx++) {
    for (let by = by0; by <= by1; by++) {
      for (let bz = bz0; bz <= bz1; bz++) {
        if (!world.isSolidAt(bx, by, bz)) continue;
        if (axis === "x") {
          if (delta > 0) allowed = Math.min(allowed, bx - (pos.x + r) - EPS);
          else allowed = Math.max(allowed, bx + 1 - (pos.x - r) + EPS);
        } else if (axis === "y") {
          if (delta > 0) allowed = Math.min(allowed, by - (pos.y + h) - EPS);
          else allowed = Math.max(allowed, by + 1 - pos.y + EPS);
        } else {
          if (delta > 0) allowed = Math.min(allowed, bz - (pos.z + r) - EPS);
          else allowed = Math.max(allowed, bz + 1 - (pos.z - r) + EPS);
        }
      }
    }
  }
  return allowed;
}

// Whether the box at `pos` overlaps any solid block.
export function boxInSolid(world, pos, r, h) {
  for (let bx = Math.floor(pos.x - r); bx <= Math.floor(pos.x + r - EPS); bx++) {
    for (let by = Math.floor(pos.y); by <= Math.floor(pos.y + h - EPS); by++) {
      for (let bz = Math.floor(pos.z - r); bz <= Math.floor(pos.z + r - EPS); bz++) {
        if (world.isSolidAt(bx, by, bz)) return true;
      }
    }
  }
  return false;
}

// Ray vs. axis-aligned box; returns the entry distance along the (unit)
// direction, or null if the ray misses within maxDist.
export function rayAabb(origin, dir, min, max, maxDist) {
  let tmin = 0;
  let tmax = maxDist;
  for (const a of ["x", "y", "z"]) {
    const o = origin[a];
    const d = dir[a];
    if (Math.abs(d) < 1e-9) {
      if (o < min[a] || o > max[a]) return null;
      continue;
    }
    let t1 = (min[a] - o) / d;
    let t2 = (max[a] - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
