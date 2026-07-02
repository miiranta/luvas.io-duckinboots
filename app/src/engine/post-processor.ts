/**
 * WebGPU post-processing shader system.
 *
 * The world keeps rendering through Canvas 2D; each frame that canvas is
 * uploaded as a GPU texture and drawn through a WGSL "uber" effect pass onto
 * a WebGPU output canvas: bloom-lite, chromatic aberration, colour grading,
 * vignette and film grain. Where WebGPU is unavailable the factory returns
 * `null` and the game simply shows the unprocessed 2D canvas.
 */

/// <reference types="@webgpu/types" />

const SHADER = /* wgsl */ `
struct Uniforms {
    resolution: vec2f,
    time: f32,
    strength: f32,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var frame: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: Uniforms;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

// Fullscreen triangle: 3 vertices, no vertex buffer.
@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    var out: VsOut;
    let x = f32(i32(i / 2u) * 4 - 1);
    let y = f32(i32(i % 2u) * 4 - 1);
    out.pos = vec4f(x, y, 0.0, 1.0);
    out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

fn hash(p: vec2f) -> f32 {
    return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let uv = in.uv;
    let px = 1.0 / u.resolution;
    let centered = uv - vec2f(0.5);
    let d2 = dot(centered, centered);

    // Chromatic aberration: a couple of *pixels* at the far corners, zero at
    // the centre. (Offsets are computed in texels — a UV-unit factor here
    // reads as a full-screen anaglyph ghost.)
    let ca = normalize(centered + vec2f(1e-6)) * d2 * 4.0 * px * u.strength;
    var col = vec3f(
        textureSample(frame, samp, uv - ca).r,
        textureSample(frame, samp, uv).g,
        textureSample(frame, samp, uv + ca).b,
    );

    // Bloom-lite: bright neighbours bleed a soft glow (portals, rope shine).
    let t = vec3f(0.62);
    var glow = max(textureSample(frame, samp, uv + vec2f(2.0, 0.0) * px).rgb - t, vec3f(0.0));
    glow += max(textureSample(frame, samp, uv - vec2f(2.0, 0.0) * px).rgb - t, vec3f(0.0));
    glow += max(textureSample(frame, samp, uv + vec2f(0.0, 2.0) * px).rgb - t, vec3f(0.0));
    glow += max(textureSample(frame, samp, uv - vec2f(0.0, 2.0) * px).rgb - t, vec3f(0.0));
    glow += max(textureSample(frame, samp, uv + vec2f(3.0, 3.0) * px).rgb - t, vec3f(0.0));
    glow += max(textureSample(frame, samp, uv - vec2f(3.0, 3.0) * px).rgb - t, vec3f(0.0));
    col += glow * 0.22 * u.strength;

    // Colour grade: gentle saturation, contrast and warmth.
    let luma = dot(col, vec3f(0.299, 0.587, 0.114));
    col = mix(vec3f(luma), col, 1.0 + 0.12 * u.strength);
    col = (col - 0.5) * (1.0 + 0.06 * u.strength) + 0.5;
    col *= mix(vec3f(1.0), vec3f(1.03, 1.0, 0.97), u.strength);

    // Vignette.
    let vig = smoothstep(0.85, 0.30, sqrt(d2) * 1.15);
    col *= mix(1.0, mix(0.72, 1.0, vig), u.strength);

    // Film grain, animated.
    let grain = hash(uv * u.resolution + fract(u.time) * 61.7) - 0.5;
    col += grain * 0.028 * u.strength;

    return vec4f(col, 1.0);
}
`;

export class PostProcessor {
    private frameTexture: GPUTexture | null = null;
    private bindGroup: GPUBindGroup | null = null;

    private constructor(
        private readonly device: GPUDevice,
        private readonly context: GPUCanvasContext,
        private readonly format: GPUTextureFormat,
        private readonly pipeline: GPURenderPipeline,
        private readonly sampler: GPUSampler,
        private readonly uniforms: GPUBuffer,
        private readonly output: HTMLCanvasElement,
    ) {}

    /** Create a processor rendering into `output`, or `null` if unsupported. */
    static async create(output: HTMLCanvasElement): Promise<PostProcessor | null> {
        try {
            if (!('gpu' in navigator)) return null;
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) return null;
            const device = await adapter.requestDevice();
            const context = output.getContext('webgpu');
            if (!context) return null;
            const format = navigator.gpu.getPreferredCanvasFormat();
            context.configure({ device, format, alphaMode: 'opaque' });

            const module = device.createShaderModule({ code: SHADER });
            const pipeline = device.createRenderPipeline({
                layout: 'auto',
                vertex: { module, entryPoint: 'vs' },
                fragment: { module, entryPoint: 'fs', targets: [{ format }] },
                primitive: { topology: 'triangle-list' },
            });
            const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
            const uniforms = device.createBuffer({
                size: 16, // vec2f + f32 + f32
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            return new PostProcessor(device, context, format, pipeline, sampler, uniforms, output);
        } catch (e) {
            console.warn('WebGPU post-processing unavailable:', e);
            return null;
        }
    }

    /**
     * Upload the 2D `source` canvas and draw it through the effect pass.
     * `strength` scales every effect (0 = passthrough, 1 = full).
     */
    render(source: HTMLCanvasElement, timeSec: number, strength = 1): void {
        const w = source.width;
        const h = source.height;
        if (w === 0 || h === 0) return;

        if (this.output.width !== w || this.output.height !== h) {
            this.output.width = w;
            this.output.height = h;
        }
        if (!this.frameTexture || this.frameTexture.width !== w || this.frameTexture.height !== h) {
            this.frameTexture?.destroy();
            this.frameTexture = this.device.createTexture({
                size: [w, h],
                format: 'rgba8unorm',
                usage:
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_DST |
                    GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.bindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: this.frameTexture.createView() },
                    { binding: 2, resource: { buffer: this.uniforms } },
                ],
            });
        }

        this.device.queue.copyExternalImageToTexture(
            { source },
            { texture: this.frameTexture },
            [w, h],
        );
        this.device.queue.writeBuffer(
            this.uniforms,
            0,
            new Float32Array([w, h, timeSec, strength]),
        );

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.context.getCurrentTexture().createView(),
                    loadOp: 'clear',
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    storeOp: 'store',
                },
            ],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.draw(3);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    destroy(): void {
        this.frameTexture?.destroy();
        this.uniforms.destroy();
    }
}
