/**
 * WebGPU renderer for the world viewer.
 *
 * Two pipelines share one depth buffer:
 *   terrain   - the heightmap grid, tinted per ground tileset
 *   instances - placed objects, drawn as one instanced draw call per batch
 *
 * The instanced path is the point of the exercise: the map has 25,222
 * doodads, and issuing a draw call each would stall long before the GPU did.
 */

import { FLOATS_PER_VERTEX, WATER_NONE, type TerrainMesh } from "./terrain-mesh";

export interface InstanceBatch {
  label: string;
  /** x, y, z, rotation, scaleX, scaleY, scaleZ, colour index - 8 floats. */
  data: Float32Array;
  count: number;
}

const TERRAIN_SHADER = /* wgsl */ `
struct Uniforms {
  viewProjection : mat4x4<f32>,
  palette        : array<vec4<f32>, 16>,
  sunDirection   : vec4<f32>,
  waterColour    : vec4<f32>,
  unitPalette    : array<vec4<f32>, 16>,
};
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) normal  : vec3<f32>,
  @location(1) tint    : vec3<f32>,
  @location(2) wetness : f32,
};

@vertex
fn vs(
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) tileset  : f32,
  @location(3) water    : f32,
) -> VSOut {
  var out : VSOut;
  var world = position;
  var wet = 0.0;
  if (water > ${WATER_NONE.toExponential()} + 1.0) {
    // Draw the surface at the water table so lakes read as flat.
    wet = clamp((water - position.z) / 220.0, 0.15, 0.9);
    world.z = max(position.z, water);
  }
  out.position = u.viewProjection * vec4<f32>(world, 1.0);
  out.normal = normal;
  out.tint = u.palette[u32(clamp(tileset, 0.0, 15.0))].rgb;
  out.wetness = wet;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let lambert = clamp(dot(normalize(in.normal), normalize(u.sunDirection.xyz)), 0.0, 1.0);
  let lit = in.tint * (0.42 + 0.58 * lambert);
  let colour = mix(lit, u.waterColour.rgb, in.wetness);
  return vec4<f32>(colour, 1.0);
}
`;

const INSTANCE_SHADER = /* wgsl */ `
struct Uniforms {
  viewProjection : mat4x4<f32>,
  palette        : array<vec4<f32>, 16>,
  sunDirection   : vec4<f32>,
  waterColour    : vec4<f32>,
  unitPalette    : array<vec4<f32>, 16>,
};
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) shade : f32,
  @location(1) tint  : vec3<f32>,
};

@vertex
fn vs(
  @location(0) corner    : vec3<f32>,
  @location(1) origin    : vec3<f32>,
  @location(2) transform : vec4<f32>,   // rotation, scaleX, scaleY, scaleZ
  @location(3) colour    : f32,
) -> VSOut {
  let angle = transform.x;
  let s = sin(angle);
  let c = cos(angle);
  let scaled = vec3<f32>(corner.x * transform.y, corner.y * transform.z, corner.z * transform.w);
  let rotated = vec3<f32>(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c, scaled.z);

  var out : VSOut;
  out.position = u.viewProjection * vec4<f32>(origin + rotated, 1.0);
  out.shade = 0.55 + 0.45 * corner.z;
  out.tint = u.unitPalette[u32(clamp(colour, 0.0, 15.0))].rgb;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.tint * in.shade, 1.0);
}
`;

// Unit box, origin at the base, used as the stand-in for a placed object
// until real glTF meshes are wired in.
const BOX_VERTICES = new Float32Array([
  -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  -0.5, -0.5, 1, 0.5, -0.5, 1, 0.5, 0.5, 1, -0.5, 0.5, 1,
]);
const BOX_INDICES = new Uint16Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
  1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
]);

// viewProjection, terrain palette, sun, water, unit palette.
const UNIFORM_FLOATS = 16 + 16 * 4 + 4 + 4 + 16 * 4;
const UNIT_PALETTE_OFFSET = 88;

/**
 * The byte source WebGPU accepts, taken from the API itself.
 *
 * TypeScript 5.7 made typed arrays generic over their buffer, and a bare
 * `Float32Array` now means `Float32Array<ArrayBufferLike>` - which admits
 * `SharedArrayBuffer` and therefore no longer matches what `writeBuffer` wants.
 * Nothing in this engine allocates a shared buffer, so the assertion is kept to
 * the two places bytes actually cross into the GPU. Writing the buffer type into
 * `TerrainMesh` and `InstanceBatch` instead would push a TypeScript version
 * requirement into every module that merely describes a mesh.
 */
type GpuBytes = Parameters<GPUQueue["writeBuffer"]>[2];

export class Renderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private depth!: GPUTexture;

  private terrainPipeline!: GPURenderPipeline;
  private instancePipeline!: GPURenderPipeline;
  private bindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;
  private uniformData = new Float32Array(UNIFORM_FLOATS);

  private terrainVertices!: GPUBuffer;
  private terrainIndices!: GPUBuffer;
  private terrainIndexCount = 0;

  private boxVertices!: GPUBuffer;
  private boxIndices!: GPUBuffer;
  /** `capacity` is bytes; only dynamic batches use it, static ones fit exactly. */
  private batches: { buffer: GPUBuffer; count: number; label: string; capacity: number }[] = [];

  constructor(private canvas: HTMLCanvasElement) {}

  async init(): Promise<void> {
    if (!navigator.gpu) {
      throw new Error(
        "WebGPU недоступен. Нужен Chrome/Edge 113+, Safari 18+ или Firefox с включённым WebGPU.",
      );
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("WebGPU: подходящий видеоадаптер не найден.");
    this.device = await adapter.requestDevice();

    const context = this.canvas.getContext("webgpu");
    if (!context) throw new Error("Не удалось получить контекст WebGPU у canvas.");
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: "opaque" });

    this.uniformBuffer = this.device.createBuffer({
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const layout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }],
    });
    this.bindGroup = this.device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] });

    const stride = FLOATS_PER_VERTEX * 4;
    this.terrainPipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: this.device.createShaderModule({ code: TERRAIN_SHADER }),
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: stride,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32" },
              { shaderLocation: 3, offset: 28, format: "float32" },
            ],
          },
        ],
      },
      fragment: {
        module: this.device.createShaderModule({ code: TERRAIN_SHADER }),
        entryPoint: "fs",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });

    this.instancePipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: this.device.createShaderModule({ code: INSTANCE_SHADER }),
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
          },
          {
            arrayStride: 32,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 1, offset: 0, format: "float32x3" },
              { shaderLocation: 2, offset: 12, format: "float32x4" },
              { shaderLocation: 3, offset: 28, format: "float32" },
            ],
          },
        ],
      },
      fragment: {
        module: this.device.createShaderModule({ code: INSTANCE_SHADER }),
        entryPoint: "fs",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });

    this.boxVertices = this.upload(BOX_VERTICES, GPUBufferUsage.VERTEX);
    this.boxIndices = this.upload(BOX_INDICES, GPUBufferUsage.INDEX);
    this.resize();
  }

  private upload(data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: Math.ceil(data.byteLength / 4) * 4,
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data as GpuBytes);
    return buffer;
  }

  setTerrain(mesh: TerrainMesh): void {
    this.terrainVertices = this.upload(mesh.vertices, GPUBufferUsage.VERTEX);
    this.terrainIndices = this.upload(mesh.indices, GPUBufferUsage.INDEX);
    this.terrainIndexCount = mesh.indexCount;
  }

  setInstanceBatches(batches: InstanceBatch[]): void {
    this.batches = batches
      .filter((batch) => batch.count > 0)
      .map((batch) => ({
        buffer: this.upload(batch.data, GPUBufferUsage.VERTEX),
        count: batch.count,
        label: batch.label,
        capacity: batch.data.byteLength,
      }));
  }

  setPalette(colours: [number, number, number][]): void {
    for (let i = 0; i < 16; i++) {
      const c = colours[i] ?? [0.5, 0.5, 0.5];
      this.uniformData.set([c[0], c[1], c[2], 1], 16 + i * 4);
    }
  }

  /**
   * Colours for instanced objects, indexed by the batch's colour column.
   *
   * Separate from the terrain palette because the terrain already claims all
   * sixteen of its slots for tilesets. Sharing them forced a placed object to
   * borrow whatever hue a tileset happened to have - acceptable in a viewer, wrong
   * in a game, where the colour of a unit is its owner's identity and may not
   * shift because the map gained a ground texture.
   */
  setUnitPalette(colours: [number, number, number][]): void {
    for (let i = 0; i < 16; i++) {
      const c = colours[i] ?? [0.6, 0.6, 0.6];
      this.uniformData.set([c[0], c[1], c[2], 1], UNIT_PALETTE_OFFSET + i * 4);
    }
  }

  /**
   * Create or refill a batch whose contents change every frame.
   *
   * `setInstanceBatches` allocates a buffer per call, which is right for placed
   * doodads - uploaded once, never touched again - and a leak for live units,
   * where it would allocate sixty buffers a second. This reuses one buffer and
   * grows it only when the army does, with headroom so that a spawn wave does not
   * force a reallocation.
   */
  writeDynamicBatch(label: string, data: Float32Array, count: number): void {
    const floatsPerInstance = 8;
    const needed = Math.max(1, count) * floatsPerInstance * 4;
    let batch = this.batches.find((entry) => entry.label === label);

    if (!batch || batch.capacity < needed) {
      const capacity = Math.max(needed * 2, 256 * floatsPerInstance * 4);
      const buffer = this.device.createBuffer({
        size: capacity,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      if (batch) {
        batch.buffer.destroy();
        batch.buffer = buffer;
        batch.capacity = capacity;
      } else {
        batch = { buffer, count, label, capacity };
        this.batches.push(batch);
      }
    }

    batch.count = count;
    if (count > 0) {
      this.device.queue.writeBuffer(batch.buffer, 0, data as GpuBytes, 0, count * floatsPerInstance);
    }
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width === width && this.canvas.height === height && this.depth) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.depth?.destroy();
    this.depth = this.device.createTexture({
      size: [width, height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  get aspect(): number {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }

  render(viewProjection: Float32Array): void {
    this.uniformData.set(viewProjection, 0);
    this.uniformData.set([0.35, -0.55, 0.76, 0], 80);   // sun direction
    this.uniformData.set([0.13, 0.28, 0.45, 1], 84);    // water colour
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.05, g: 0.06, b: 0.08, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this.depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    pass.setBindGroup(0, this.bindGroup);

    if (this.terrainIndexCount) {
      pass.setPipeline(this.terrainPipeline);
      pass.setVertexBuffer(0, this.terrainVertices);
      pass.setIndexBuffer(this.terrainIndices, "uint32");
      pass.drawIndexed(this.terrainIndexCount);
    }

    if (this.batches.length) {
      pass.setPipeline(this.instancePipeline);
      pass.setVertexBuffer(0, this.boxVertices);
      pass.setIndexBuffer(this.boxIndices, "uint16");
      for (const batch of this.batches) {
        pass.setVertexBuffer(1, batch.buffer);
        pass.drawIndexed(BOX_INDICES.length, batch.count);
      }
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  get drawCallCount(): number {
    return (this.terrainIndexCount ? 1 : 0) + this.batches.length;
  }
}
