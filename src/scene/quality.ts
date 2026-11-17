/**
 * Renderer quality tiers and the pure policies that pick them.
 *
 * `high` is the desktop diorama (full DPR up to 2, 2048² shadows, trees);
 * `low` trades fill rate and a little detail for mobile/iGPU headroom
 * (DPR capped at 1.25, 1024² shadows, no trees). The tier only affects
 * renderer/presentation state — geometry and model data stay identical — so
 * switching is cheap and deterministic.
 *
 * The module is pure (no DOM / Three.js) so the policy can be unit tested;
 * `scene.ts` owns the actual renderer, listeners and adaptive stepping.
 */

export type SceneQuality = 'high' | 'low';

export interface QualitySettings {
  /** Upper bound for `window.devicePixelRatio` when sizing the drawing buffer. */
  dprCap: number;
  /** Square shadow-map resolution, in texels. */
  shadowMapSize: number;
  /** Whether the merged tree canopy mesh is drawn. */
  showTrees: boolean;
}

export const QUALITY: Readonly<Record<SceneQuality, QualitySettings>> = {
  high: { dprCap: 2, shadowMapSize: 2048, showTrees: true },
  low: { dprCap: 1.25, shadowMapSize: 1024, showTrees: false }
};

export interface QualityEnvironment {
  /** True when the primary pointer is coarse (phone/tablet touch). */
  coarsePointer: boolean;
  /** CSS viewport width, in pixels. */
  viewportWidth: number;
  /** CSS viewport height, in pixels. */
  viewportHeight: number;
}

/** CSS width at/below which the compact layout runs — mirrors the UI breakpoint. */
export const SMALL_SCREEN_MAX_CSS_PX = 480;

/**
 * Starting tier for a device: phones and small screens begin at `low` so a
 * first visit to a low-end device does not spend its first seconds recompiling
 * shaders at full DPR before the adaptive policy has any data.
 */
export function qualityForEnvironment(environment: QualityEnvironment): SceneQuality {
  const width = Number.isFinite(environment.viewportWidth) ? environment.viewportWidth : 0;
  if (environment.coarsePointer) return 'low';
  if (width > 0 && width <= SMALL_SCREEN_MAX_CSS_PX) return 'low';
  return 'high';
}

/**
 * Median rendered-frame interval above which the scene steps down a tier.
 * ~30 ms ≈ below 33 fps: a clearly missed frame budget on a 60 Hz display.
 */
export const SLOW_FRAME_INTERVAL_MS = 30;
/** Consecutive rendered frames needed before the adaptive policy may step down. */
export const ADAPTIVE_SAMPLE_FRAMES = 90;

/**
 * The next quality tier after looking at the rolling rendered-frame cadence, or
 * null to stay put. Stepping is one-way (never automatically upgrades) to avoid
 * oscillating between tiers and reallocating the drawing buffer/shadow maps.
 *
 * Callers only pass samples from a continuous rendering run, so interaction
 * gaps cannot masquerade as slow frames.
 */
export function degradeQualityForFrameTime(
  current: SceneQuality,
  medianFrameIntervalMs: number,
  sampleCount: number
): SceneQuality | null {
  if (current !== 'high') return null;
  if (!Number.isFinite(medianFrameIntervalMs)) return null;
  if (sampleCount < ADAPTIVE_SAMPLE_FRAMES) return null;
  return medianFrameIntervalMs > SLOW_FRAME_INTERVAL_MS ? 'low' : null;
}
