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
