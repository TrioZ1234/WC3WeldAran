/**
 * Orbit camera and the small amount of 4x4 matrix maths the viewer needs.
 *
 * The world stays in Warcraft III's coordinate space: X east, Y north, Z up,
 * one unit = one WC3 unit. Keeping the engine in the source space means map
 * coordinates from the data files can be used directly, with no conversion
 * factor to get wrong.
 */

export type Mat4 = Float32Array;

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

export function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
  const z = normalise([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalise(cross(up, z));
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[1] = y[0]; m[2] = z[0]; m[3] = 0;
  m[4] = x[1]; m[5] = y[1]; m[6] = z[1]; m[7] = 0;
  m[8] = x[2]; m[9] = y[2]; m[10] = z[2]; m[11] = 0;
  m[12] = -dot(x, eye); m[13] = -dot(y, eye); m[14] = -dot(z, eye); m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * General 4x4 inverse.
 *
 * Needed to turn a mouse position back into a world point: giving an order means
 * answering "where on the ground is this pixel", and that is the only way to ask.
 * A shortcut inverse for rigid transforms will not do, because the matrix being
 * inverted includes the perspective projection.
 */
export function invert(m: Mat4): Mat4 | null {
  const a = m;
  const b = new Float32Array(16);

  const s0 = a[0] * a[5] - a[4] * a[1];
  const s1 = a[0] * a[6] - a[4] * a[2];
  const s2 = a[0] * a[7] - a[4] * a[3];
  const s3 = a[1] * a[6] - a[5] * a[2];
  const s4 = a[1] * a[7] - a[5] * a[3];
  const s5 = a[2] * a[7] - a[6] * a[3];

  const c5 = a[10] * a[15] - a[14] * a[11];
  const c4 = a[9] * a[15] - a[13] * a[11];
  const c3 = a[9] * a[14] - a[13] * a[10];
  const c2 = a[8] * a[15] - a[12] * a[11];
  const c1 = a[8] * a[14] - a[12] * a[10];
  const c0 = a[8] * a[13] - a[12] * a[9];

  const determinant = s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
  if (determinant === 0) return null;
  const d = 1 / determinant;

  b[0] = (a[5] * c5 - a[6] * c4 + a[7] * c3) * d;
  b[1] = (-a[1] * c5 + a[2] * c4 - a[3] * c3) * d;
  b[2] = (a[13] * s5 - a[14] * s4 + a[15] * s3) * d;
  b[3] = (-a[9] * s5 + a[10] * s4 - a[11] * s3) * d;
  b[4] = (-a[4] * c5 + a[6] * c2 - a[7] * c1) * d;
  b[5] = (a[0] * c5 - a[2] * c2 + a[3] * c1) * d;
  b[6] = (-a[12] * s5 + a[14] * s2 - a[15] * s1) * d;
  b[7] = (a[8] * s5 - a[10] * s2 + a[11] * s1) * d;
  b[8] = (a[4] * c4 - a[5] * c2 + a[7] * c0) * d;
  b[9] = (-a[0] * c4 + a[1] * c2 - a[3] * c0) * d;
  b[10] = (a[12] * s4 - a[13] * s2 + a[15] * s0) * d;
  b[11] = (-a[8] * s4 + a[9] * s2 - a[11] * s0) * d;
  b[12] = (-a[4] * c3 + a[5] * c1 - a[6] * c0) * d;
  b[13] = (a[0] * c3 - a[1] * c1 + a[2] * c0) * d;
  b[14] = (-a[12] * s3 + a[13] * s1 - a[14] * s0) * d;
  b[15] = (a[8] * s3 - a[9] * s1 + a[10] * s0) * d;
  return b;
}

/** Project a world point to normalised device coordinates plus depth. */
export function project(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (w === 0) return [0, 0, -1];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    w,
  ];
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalise(v: number[]): number[] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

export class OrbitCamera {
  target: [number, number, number] = [0, 0, 0];
  distance = 12000;
  /** Rotation around Z (world up). */
  azimuth = -Math.PI / 2;
  /** Angle above the horizon. */
  elevation = 0.85;
  fov = (55 * Math.PI) / 180;
  near = 32;
  far = 200000;

  minDistance = 400;
  maxDistance = 90000;

  get eye(): [number, number, number] {
    const horizontal = Math.cos(this.elevation) * this.distance;
    return [
      this.target[0] + Math.cos(this.azimuth) * horizontal,
      this.target[1] + Math.sin(this.azimuth) * horizontal,
      this.target[2] + Math.sin(this.elevation) * this.distance,
    ];
  }

  viewProjection(aspect: number): Mat4 {
    const view = lookAt(this.eye, this.target, [0, 0, 1]);
    return multiply(perspective(this.fov, aspect, this.near, this.far), view);
  }

  /**
   * Where a screen point meets a horizontal plane, in world coordinates.
   *
   * `ndc` is the pointer in normalised device coordinates: -1..1 with Y up. The
   * plane is horizontal at `groundZ` rather than the true terrain surface, which
   * costs a little accuracy on steep slopes and buys a closed-form answer instead
   * of a ray march through 231 361 tilepoints on every click.
   */
  groundPoint(
    ndcX: number,
    ndcY: number,
    aspect: number,
    groundZ = 0,
  ): [number, number] | null {
    const inverse = invert(this.viewProjection(aspect));
    if (!inverse) return null;

    const unproject = (z: number): [number, number, number] | null => {
      const w = inverse[3] * ndcX + inverse[7] * ndcY + inverse[11] * z + inverse[15];
      if (w === 0) return null;
      return [
        (inverse[0] * ndcX + inverse[4] * ndcY + inverse[8] * z + inverse[12]) / w,
        (inverse[1] * ndcX + inverse[5] * ndcY + inverse[9] * z + inverse[13]) / w,
        (inverse[2] * ndcX + inverse[6] * ndcY + inverse[10] * z + inverse[14]) / w,
      ];
    };

    const near = unproject(0);
    const far = unproject(1);
    if (!near || !far) return null;

    const dz = far[2] - near[2];
    if (Math.abs(dz) < 1e-6) return null;
    const t = (groundZ - near[2]) / dz;
    if (!Number.isFinite(t)) return null;
    return [near[0] + (far[0] - near[0]) * t, near[1] + (far[1] - near[1]) * t];
  }

  orbit(dx: number, dy: number): void {
    this.azimuth -= dx * 0.005;
    const limit = Math.PI / 2 - 0.05;
    this.elevation = Math.min(limit, Math.max(0.08, this.elevation + dy * 0.005));
  }

  /** Pan across the ground plane, scaled so it feels the same at any zoom. */
  pan(dx: number, dy: number): void {
    const speed = this.distance * 0.0014;
    const sin = Math.sin(this.azimuth);
    const cos = Math.cos(this.azimuth);
    this.target[0] += (sin * dx + cos * dy) * speed;
    this.target[1] += (-cos * dx + sin * dy) * speed;
  }

  zoom(delta: number): void {
    this.distance = Math.min(
      this.maxDistance,
      Math.max(this.minDistance, this.distance * Math.exp(delta * 0.0012)),
    );
  }

  attach(canvas: HTMLCanvasElement): void {
    let dragging: "orbit" | "pan" | null = null;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      dragging = event.button === 2 || event.shiftKey ? "pan" : "orbit";
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointerup", (event) => {
      dragging = null;
      canvas.releasePointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      if (dragging === "orbit") this.orbit(dx, dy);
      else this.pan(-dx, dy);
    });
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.zoom(event.deltaY);
      },
      { passive: false },
    );
  }
}
