import {
  HandLandmarker,
  FilesetResolver,
} from "./vendor/vision_bundle.mjs";
import { t, initI18n, setLocale, getLocale, hasLocale, applyDataI18n } from "./i18n.js";
import { createHeadSticker, stickerDrawRect } from "./head-sticker.js";
import { computeFaceRect, computeFaceRoll } from "./face-tracker.js";

initI18n();

const WASM_URL = "./vendor/wasm";
const MODEL_URL = "./vendor/hand_landmarker.task";

const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 8, MIDDLE_MCP = 9;
const MIDDLE_TIP = 12, RING_TIP = 16, PINKY_TIP = 20;
const MAX_LOST_FRAMES = 25;
const JUMP_CONFIRM_FRAMES = 2;

// ---- DOM refs: AI mode ----
const orig = document.getElementById("orig");
const sty = document.getElementById("sty");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const stage = document.getElementById("stage");
const drop = document.getElementById("drop");
const dropSty = document.getElementById("drop-sty");
const btnPlay = document.getElementById("btn-play");
const btnExport = document.getElementById("btn-export");

// ---- DOM refs: live mode ----
const liveCanvas = document.getElementById("canvas-live");
const liveCtx = liveCanvas.getContext("2d");
const liveStage = document.getElementById("live-stage");
const liveStartWrap = document.getElementById("live-start-wrap");
const liveWorkspace = document.getElementById("live-workspace");
const liveCanvasWrap = document.getElementById("live-canvas-wrap");
const liveEffectsEl = document.getElementById("live-effects");
const statusLiveEl = document.getElementById("status-live");
const btnLiveStart = document.getElementById("btn-live-start");
const liveVideo = document.createElement("video");
liveVideo.playsInline = true;
liveVideo.muted = true;
document.body.appendChild(liveVideo);

// ---- shared ----
const isMobile =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && window.innerWidth < 900);

if (
  "serviceWorker" in navigator &&
  location.protocol === "https:" &&
  (location.hostname !== "localhost" || localStorage.getItem("fp-sw") === "1")
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

let landmarker = null;

function status(msg) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("working", /…\s*$/.test(msg));
}
function statusLive(msg) {
  statusLiveEl.textContent = msg;
  statusLiveEl.classList.toggle("working", /…\s*$/.test(msg));
}

// ============================================================================
// 反馈 / 联系作者 弹窗（右上角按钮）
// ============================================================================
const contactBtn = document.getElementById("btn-contact");
const contactModal = document.getElementById("contact-modal");
const contactClose = document.getElementById("btn-contact-close");
function openContact() {
  contactModal.classList.remove("hidden");
  contactBtn.setAttribute("aria-expanded", "true");
}
function closeContact() {
  contactModal.classList.add("hidden");
  contactBtn.setAttribute("aria-expanded", "false");
}
contactBtn.addEventListener("click", openContact);
contactClose.addEventListener("click", closeContact);
contactModal.addEventListener("click", (e) => {
  if (e.target === contactModal) closeContact();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !contactModal.classList.contains("hidden")) closeContact();
});

// ============================================================================
// Mode switching
// ============================================================================
const modeBtns = document.querySelectorAll(".mode-btn");
let liveMode = true;
let liveStarted = false;
let liveRaf = 0;

function setMode(mode) {
  liveMode = mode === "live";
  document.getElementById("mode-live").classList.toggle("hidden", !liveMode);
  document.getElementById("mode-ai").classList.toggle("hidden", liveMode);
  modeBtns.forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  if (!liveMode && liveStarted && liveRaf) {
    cancelAnimationFrame(liveRaf);
    liveRaf = 0;
  }
  if (liveMode && liveStarted && !liveRaf) liveLoop();
}
modeBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

// ============================================================================
// Live mode — realtime hand tracking + mask effects
// ============================================================================
// Fixed canvas size — never changes, regardless of camera resolution.
const LIVE_CANVAS_W = 1280;
const LIVE_CANVAS_H = 720;
// Detection runs on a small offscreen canvas (MediaPipe landmarks are
// normalized 0..1, so coordinates map straight onto the fixed canvas).
// Small input = fast detection = hand keeps up, while the display stays big.
const DET_W = 320;
const DET_H = 180;
const detCanvas = document.createElement("canvas");
detCanvas.width = DET_W;
detCanvas.height = DET_H;
const detCtx = detCanvas.getContext("2d", { willReadFrequently: true });

// 场景画布：每帧把「视频 + 贴图头像 + 手指」合成到这张画布，滤镜作用在它上面，
// 这样头像和手指与背景一起被滤镜处理（头像 = 换脸，滤镜同样生效）。
const sceneCanvas = document.createElement("canvas");
sceneCanvas.width = LIVE_CANVAS_W;
sceneCanvas.height = LIVE_CANVAS_H;
const sceneCtx = sceneCanvas.getContext("2d");

// 录制画布：captureStream 抓的是 canvas 原始像素，不含 CSS 的镜像显示翻转。
// 录制的「原视频」= 摄像头原始画面（双手比框 + 背景）+ 贴图头像（不露脸），
// 但**不带**滤镜/框线/手部检测点/水印。这样它适合喂给 AI 风格化（不被滤镜遮挡、
// 头像随画面一起被重绘、不露真脸），合成时二次检测手也不会被烧进像素的黑色
// 骨架干扰。屏幕实时预览仍是 liveCanvas 的完整特效画面（所见即所得），只有
// 下载的视频走这里的「干净源帧 + 头像」。
const recCanvas = document.createElement("canvas");
recCanvas.width = LIVE_CANVAS_W;
recCanvas.height = LIVE_CANVAS_H;
const recCtx = recCanvas.getContext("2d");

function syncRecCanvas() {
  recCtx.clearRect(0, 0, LIVE_CANVAS_W, LIVE_CANVAS_H);
  if (mirrored) {
    recCtx.save();
    recCtx.scale(-1, 1);
    recCtx.translate(-LIVE_CANVAS_W, 0);
    drawCover(recCtx, liveVideo, LIVE_CANVAS_W, LIVE_CANVAS_H);
    if (sticker && sticker.enabled) sticker.drawTo(recCtx);
    recCtx.restore();
  } else {
    drawCover(recCtx, liveVideo, LIVE_CANVAS_W, LIVE_CANVAS_H);
    if (sticker && sticker.enabled) sticker.drawTo(recCtx);
  }
}

// ---- 左上角水印：网站 LOGO + 「捏个框」----
const wmLogo = new Image();
wmLogo.src = "./assets/icons/icon-512.png";
const WM_MARGIN = 16;
const WM_LOGO = 24; // 与文字同高
const WM_TEXT = "捏个框";
const WM_FONT = 'bold 24px Nunito, "PingFang SC", "Microsoft YaHei", sans-serif';
const WM_BADGE = { r: 0, g: 0, b: 0, a: 0.22, padX: 12, padY: 6, radius: 12 };

function drawWatermark(ctx) {
  const y = WM_MARGIN;
  // 默认镜像开启：canvas 被 CSS scaleX(-1) 整个水平翻转。为了用户看到的
  // 水印始终在屏幕左上角且文字正向，镜像时把水印画到 canvas 逻辑右侧，
  // 再对水印区域做一次局部反向，抵消外层的 CSS 翻转。
  const flip = mirrored;
  ctx.save();
  ctx.font = WM_FONT;
  const textW = ctx.measureText(WM_TEXT).width;
  const badgeW = WM_LOGO + WM_BADGE.padX + textW + WM_BADGE.padX;
  const badgeH = WM_LOGO + WM_BADGE.padY * 2;
  const x = flip ? liveCanvas.width - badgeW - WM_MARGIN : WM_MARGIN;

  if (flip) {
    ctx.translate(x + badgeW / 2, y + badgeH / 2);
    ctx.scale(-1, 1);
    ctx.translate(-(x + badgeW / 2), -(y + badgeH / 2));
  }

  // 半透明深色圆角底板，压暗视频但内容可透出
  ctx.globalAlpha = WM_BADGE.a;
  ctx.fillStyle = "#000";
  roundRectPath(ctx, x, y, badgeW, badgeH, WM_BADGE.radius);
  ctx.fill();
  ctx.globalAlpha = 1;

  // LOGO（圆角小图标，高度与文字一致）
  if (wmLogo.complete && wmLogo.naturalWidth > 0) {
    const lx = x + WM_BADGE.padX, ly = y + WM_BADGE.padY;
    ctx.save();
    roundRectPath(ctx, lx, ly, WM_LOGO, WM_LOGO, 6);
    ctx.clip();
    ctx.drawImage(wmLogo, lx, ly, WM_LOGO, WM_LOGO);
    ctx.restore();
  }

  // 文字「捏个框」
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 4;
  ctx.fillText(WM_TEXT, x + WM_BADGE.padX + WM_LOGO + 8, y + badgeH / 2 + 1);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---- Offscreen canvases for the heavier effects (ported from finger-frame-effect) ----
const small = document.createElement("canvas");
const sctx = small.getContext("2d");

// Van Gogh buffers (reused across frames to avoid per-frame GC churn).
const vg = document.createElement("canvas");
const vgCtx = vg.getContext("2d", { willReadFrequently: true });
const VG_SCALE = 4;
let vgAngle = null, vgMag = null, vgData = null, vgW = 0, vgH = 0;
let vgLum = null, vgGx = null, vgGy = null, vgTx = null, vgTy = null;

function srcSize(src) {
  return { w: src.videoWidth || src.width || 0, h: src.videoHeight || src.height || 0 };
}
function quadBBox(q) {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
function vgHash(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

// Sample the image + build a smoothed gradient flow field (port of
// finger-frame-effect's Van Gogh, adapted to our un-mirrored drawImage).
function vgBuildField(w, h, src, bb) {
  vgW = Math.ceil(w / VG_SCALE);
  vgH = Math.ceil(h / VG_SCALE);
  if (vg.width !== vgW || vg.height !== vgH) { vg.width = vgW; vg.height = vgH; }
  vgCtx.filter = "saturate(1.8) contrast(1.1)";
  vgCtx.drawImage(src, 0, 0, vgW, vgH);
  vgCtx.filter = "none";
  vgData = vgCtx.getImageData(0, 0, vgW, vgH).data;

  const n = vgW * vgH;
  if (!vgLum || vgLum.length !== n) {
    vgLum = new Float32Array(n); vgGx = new Float32Array(n);
    vgGy = new Float32Array(n); vgTx = new Float32Array(n);
    vgTy = new Float32Array(n); vgAngle = new Float32Array(n);
    vgMag = new Float32Array(n);
  }
  const lum = vgLum, gx = vgGx, gy = vgGy, tmpx = vgTx, tmpy = vgTy;

  const M = 4;
  const cx0 = Math.max(1, Math.floor(bb.x0 / VG_SCALE) - M);
  const cx1 = Math.min(vgW - 2, Math.ceil(bb.x1 / VG_SCALE) + M);
  const cy0 = Math.max(1, Math.floor(bb.y0 / VG_SCALE) - M);
  const cy1 = Math.min(vgH - 2, Math.ceil(bb.y1 / VG_SCALE) + M);

  for (let y = cy0 - 1; y <= cy1 + 1; y++)
    for (let x = cx0 - 1; x <= cx1 + 1; x++) {
      const i = y * vgW + x, p = i * 4;
      lum[i] = 0.299 * vgData[p] + 0.587 * vgData[p + 1] + 0.114 * vgData[p + 2];
    }

  for (let y = cy0; y <= cy1; y++)
    for (let x = cx0; x <= cx1; x++) {
      const i = y * vgW + x;
      gx[i] = -lum[i - vgW - 1] - 2 * lum[i - 1] - lum[i + vgW - 1] +
              lum[i - vgW + 1] + 2 * lum[i + 1] + lum[i + vgW + 1];
      gy[i] = -lum[i - vgW - 1] - 2 * lum[i - vgW] - lum[i - vgW + 1] +
              lum[i + vgW - 1] + 2 * lum[i + vgW] + lum[i + vgW + 1];
    }

  const R = 2;
  for (let y = cy0; y <= cy1; y++) {
    const row = y * vgW;
    for (let x = cx0; x <= cx1; x++) {
      let sx = 0, sy = 0, c = 0;
      for (let k = -R; k <= R; k++) {
        const xx = x + k;
        if (xx < cx0 || xx > cx1) continue;
        sx += gx[row + xx]; sy += gy[row + xx]; c++;
      }
      tmpx[row + x] = sx / c; tmpy[row + x] = sy / c;
    }
  }
  for (let x = cx0; x <= cx1; x++) {
    for (let y = cy0; y <= cy1; y++) {
      let sx = 0, sy = 0, c = 0;
      for (let k = -R; k <= R; k++) {
        const yy = y + k;
        if (yy < cy0 || yy > cy1) continue;
        sx += tmpx[yy * vgW + x]; sy += tmpy[yy * vgW + x]; c++;
      }
      const i = y * vgW + x, fx = sx / c, fy = sy / c;
      vgMag[i] = Math.hypot(fx, fy);
      vgAngle[i] = Math.atan2(fy, fx) + Math.PI / 2;
    }
  }
}

function vgFieldAngle(px, py, t) {
  const sx = Math.min(vgW - 1, Math.max(0, Math.round(px / VG_SCALE)));
  const sy = Math.min(vgH - 1, Math.max(0, Math.round(py / VG_SCALE)));
  const i = sy * vgW + sx;
  if (vgMag[i] > 14) return vgAngle[i];
  return Math.sin(px * 0.011 + t * 0.35) * 1.7 + Math.cos(py * 0.013 - t * 0.28) * 1.7;
}

function vgStroke(c, px, py, segments, segLen, t) {
  c.beginPath();
  c.moveTo(px, py);
  let a = vgFieldAngle(px, py, t), x = px, y = py;
  for (let s = 0; s < segments; s++) {
    const na = vgFieldAngle(x, y, t);
    a = Math.cos(na - a) < 0 ? na + Math.PI : na;
    x += Math.cos(a) * segLen;
    y += Math.sin(a) * segLen;
    c.lineTo(x, y);
  }
  c.stroke();
}

function vgColor(px, py, jitter) {
  const sx = Math.min(vgW - 1, Math.max(0, Math.round(px / VG_SCALE)));
  const sy = Math.min(vgH - 1, Math.max(0, Math.round(py / VG_SCALE)));
  const p = (sy * vgW + sx) * 4;
  const v = 1 + (jitter - 0.5) * 0.3;
  const r = Math.min(255, vgData[p] * v);
  const g = Math.min(255, vgData[p + 1] * v);
  const b = Math.min(255, vgData[p + 2] * (1 + (jitter - 0.5) * 0.22));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function vgMagAt(px, py) {
  const sx = Math.min(vgW - 1, Math.max(0, Math.round(px / VG_SCALE)));
  const sy = Math.min(vgH - 1, Math.max(0, Math.round(py / VG_SCALE)));
  return vgMag[sy * vgW + sx];
}

function drawVanGogh(c, cv, src, q) {
  const w = cv.width, h = cv.height;
  const bb = q ? quadBBox(q) : { x0: 0, y0: 0, x1: w, y1: h };
  vgBuildField(w, h, src, bb);

  c.filter = "blur(10px) saturate(1.7) brightness(0.92)";
  c.drawImage(src, 0, 0, w, h);
  c.filter = "none";

  const x0 = Math.max(6, bb.x0), y0 = Math.max(6, bb.y0);
  const x1 = Math.min(w - 6, bb.x1), y1 = Math.min(h - 6, bb.y1);
  const t = performance.now() / 1000;
  const pa = c.globalAlpha;
  c.lineCap = "round";
  c.lineJoin = "round";

  const bigStep = 14;
  for (let y = y0; y < y1; y += bigStep)
    for (let x = x0; x < x1; x += bigStep) {
      const j = vgHash(x, y);
      const px = x + (j - 0.5) * bigStep, py = y + (vgHash(y, x) - 0.5) * bigStep;
      c.strokeStyle = vgColor(px, py, j);
      c.lineWidth = 8 + j * 4;
      c.globalAlpha = pa * 0.85;
      vgStroke(c, px, py, 4, 6.5, t);
    }

  const fineStep = 6;
  for (let y = y0; y < y1; y += fineStep)
    for (let x = x0; x < x1; x += fineStep) {
      const j = vgHash(x + 7, y + 3);
      const px = x + (j - 0.5) * fineStep, py = y + (vgHash(y + 5, x + 1) - 0.5) * fineStep;
      const onEdge = vgMagAt(px, py) > 20;
      if (!onEdge && j > 0.35) continue;
      c.strokeStyle = vgColor(px, py, vgHash(x, y + 11));
      c.lineWidth = onEdge ? 3 + j * 1.5 : 4 + j * 2;
      c.globalAlpha = pa * (onEdge ? 0.95 : 0.7);
      vgStroke(c, px, py, onEdge ? 2 : 3, 5, t);
    }
  c.globalAlpha = pa;
}

// ============================================================================
// 艺术滤镜引擎（移植自 FingerLens 的 palette_map 系）：灰度 → 调色板 / 通道位移
// / 颜色量化，纯 O(n) 逐像素。quad 区域下采样处理加速，再放大画回（c 已 clip）。
// ============================================================================
const ART_SCALE = 3;
const artCanvas = document.createElement("canvas");
const artCtx = artCanvas.getContext("2d", { willReadFrequently: true });
let artLum = null, artOut = null;

// 调色板 → 256 级插值查色表（anchors 均匀分布在 0..255）。
function makeLut(colors) {
  const lut = new Uint8ClampedArray(256 * 3);
  const n = colors.length;
  for (let c = 0; c < 3; c++) {
    for (let v = 0; v < 256; v++) {
      const pos = (v / 255) * (n - 1);
      const i0 = Math.min(n - 1, Math.floor(pos));
      const i1 = Math.min(n - 1, i0 + 1);
      const f = pos - i0;
      lut[v * 3 + c] = Math.round(colors[i0][c] * (1 - f) + colors[i1][c] * f);
    }
  }
  return lut;
}

const ART_LUTS = {
  vapor: makeLut([[38, 4, 28], [245, 30, 190], [35, 180, 255], [190, 250, 245]]),
  aurora: makeLut([[35, 8, 20], [90, 35, 125], [40, 245, 120], [175, 245, 255]]),
  matrix: makeLut([[0, 8, 0], [8, 55, 4], [45, 210, 35], [205, 255, 190]]),
  gold: makeLut([[15, 8, 3], [105, 55, 12], [225, 155, 35], [255, 245, 205]]),
};

function artClamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
function artAt(lum, w, h, x, y) {
  if (x < 0) x = 0; else if (x >= w) x = w - 1;
  if (y < 0) y = 0; else if (y >= h) y = h - 1;
  return lum[y * w + x];
}
function artSobel(lum, w, h, x, y) {
  const tl = artAt(lum, w, h, x - 1, y - 1), tc = artAt(lum, w, h, x, y - 1), tr = artAt(lum, w, h, x + 1, y - 1);
  const ml = artAt(lum, w, h, x - 1, y), mr = artAt(lum, w, h, x + 1, y);
  const bl = artAt(lum, w, h, x - 1, y + 1), bc = artAt(lum, w, h, x, y + 1), br = artAt(lum, w, h, x + 1, y + 1);
  const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
  const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
  return Math.hypot(gx, gy);
}
function artLaplace(lum, w, h, x, y) {
  const v = artAt(lum, w, h, x, y);
  const n = artAt(lum, w, h, x, y - 1) + artAt(lum, w, h, x, y + 1)
          + artAt(lum, w, h, x - 1, y) + artAt(lum, w, h, x + 1, y);
  return 4 * v - n;
}

// 蒸汽波：灰度→青粉渐变 + 高亮描边
function artVapor(lum, out, w, h, t) {
  const lut = ART_LUTS.vapor;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4, v = lum[i];
      out[p] = lut[v * 3]; out[p + 1] = lut[v * 3 + 1]; out[p + 2] = lut[v * 3 + 2];
      if (artSobel(lum, w, h, x, y) > 55) { out[p] = 90; out[p + 1] = 235; out[p + 2] = 255; }
      out[p + 3] = 255;
    }
}

// 极光：灰度 + 流动正弦波 → 彩色渐变
function artAurora(lum, out, w, h, t) {
  const lut = ART_LUTS.aurora;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      const v = (artClamp(lum[i] + 24 * Math.sin(x / 24 + t) + 18 * Math.cos(y / 19 - t)) | 0);
      out[p] = lut[v * 3]; out[p + 1] = lut[v * 3 + 1]; out[p + 2] = lut[v * 3 + 2];
      out[p + 3] = 255;
    }
}

// 矩阵绿：磷光绿渐变 + 网格
function artMatrix(lum, out, w, h, t) {
  const lut = ART_LUTS.matrix;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4, v = lum[i];
      out[p] = lut[v * 3]; out[p + 1] = lut[v * 3 + 1]; out[p + 2] = lut[v * 3 + 2];
      if ((x % 7 === 0 || y % 7 === 0) && v < 145) { out[p] = 0; out[p + 1] = 28; out[p + 2] = 0; }
      out[p + 3] = 255;
    }
}

// 金箔：高光浮雕 → 金色渐变
function artGold(lum, out, w, h, t) {
  const lut = ART_LUTS.gold;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      const v = (artClamp(lum[i] * 0.72 + Math.abs(artLaplace(lum, w, h, x, y)) * 1.8 + 24) | 0);
      out[p] = lut[v * 3]; out[p + 1] = lut[v * 3 + 1]; out[p + 2] = lut[v * 3 + 2];
      out[p + 3] = 255;
    }
}

// RGB 残影：红/蓝通道左右错位（位移量按下采样比例缩小）
function artRgb(lum, out, w, h, t) {
  const shift = Math.round((7 + 6 * Math.sin(t * 1.3)) / ART_SCALE) + 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      const r = lum[y * w + (x + shift) % w];
      const b = lum[y * w + (x - shift + w) % w];
      out[p] = artClamp(r * 1.28 - 18);
      out[p + 1] = artClamp(lum[i] * 1.28 - 18);
      out[p + 2] = artClamp(b * 1.28 - 18);
      out[p + 3] = 255;
    }
}

// 驱动：取 quad 包围盒 → 下采样 → process → 放大画回 c（c 已被 clip 到 quad）。
function artApply(c, src, q, process) {
  // src 可能是 canvas（在线模式）或 video（合成模式）。canvas 用 width/height，
  // video 必须用 videoWidth/videoHeight —— video.width 是默认的 300×150，
  // 会导致合成模式框内滤镜被截断成空白。
  const sz = srcSize(src);
  const w = sz.w, h = sz.h;
  const bb = q ? quadBBox(q) : { x0: 0, y0: 0, x1: w, y1: h };
  const x0 = Math.max(0, Math.floor(bb.x0)), y0 = Math.max(0, Math.floor(bb.y0));
  const x1 = Math.min(w, Math.ceil(bb.x1)), y1 = Math.min(h, Math.ceil(bb.y1));
  if (x1 - x0 < 2 || y1 - y0 < 2) return;
  const dw = Math.max(1, Math.ceil((x1 - x0) / ART_SCALE));
  const dh = Math.max(1, Math.ceil((y1 - y0) / ART_SCALE));
  if (artCanvas.width !== dw || artCanvas.height !== dh) {
    artCanvas.width = dw; artCanvas.height = dh;
  }
  artCtx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, dw, dh);
  const data = artCtx.getImageData(0, 0, dw, dh);
  const n = dw * dh;
  if (!artLum || artLum.length !== n) {
    artLum = new Uint8ClampedArray(n);
    artOut = new Uint8ClampedArray(n * 4);
  }
  const px = data.data, lum = artLum, out = artOut;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    lum[i] = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
  }
  process(lum, out, dw, dh, performance.now() / 1000);
  for (let i = 0; i < out.length; i++) px[i] = out[i];
  artCtx.putImageData(data, 0, 0);
  c.imageSmoothingEnabled = false;
  c.drawImage(artCanvas, 0, 0, dw, dh, x0, y0, x1 - x0, y1 - y0);
  c.imageSmoothingEnabled = true;
}

const LIVE_EFFECTS = {
  pixelate: (c, cv, src) => {
    const factor = 24;
    const sw = Math.max(2, Math.round(cv.width / factor));
    const sh = Math.max(2, Math.round(cv.height / factor));
    if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
    sctx.drawImage(src, 0, 0, sw, sh);
    c.imageSmoothingEnabled = false;
    c.drawImage(small, 0, 0, sw, sh, 0, 0, cv.width, cv.height);
    c.imageSmoothingEnabled = true;
  },
  none: (c, cv, src) => {
    c.drawImage(src, 0, 0, cv.width, cv.height);
  },
  greenscreen: (c, cv) => {
    // 纯绿幕：框内整块纯绿，方便后期抠图合成。
    c.fillStyle = "#00ff00";
    c.fillRect(0, 0, cv.width, cv.height);
  },
  invert: (c, cv, src) => {
    c.filter = "invert(1)";
    c.drawImage(src, 0, 0, cv.width, cv.height);
    c.filter = "none";
  },
  glitch: (c, cv, src) => {
    const w = cv.width, h = cv.height;
    const t = performance.now() / 1000;
    const pa = c.globalAlpha;
    const { w: vw, h: vh } = srcSize(src);
    c.filter = "saturate(1.6) contrast(1.1)";
    c.drawImage(src, 0, 0, w, h);
    c.globalAlpha = pa * 0.35;
    c.filter = "hue-rotate(120deg)";
    c.drawImage(src, 8 + Math.sin(t * 9) * 5, 0, w, h);
    c.filter = "hue-rotate(-120deg)";
    c.drawImage(src, -8 - Math.sin(t * 9) * 5, 0, w, h);
    c.filter = "none";
    c.globalAlpha = pa;
    const slices = 7;
    for (let i = 0; i < slices; i++) {
      const seed = Math.sin(i * 127.1 + Math.floor(t * 12) * 311.7);
      const sy = ((seed * 0.5 + 0.5) * h) | 0;
      const sliceH = 6 + ((Math.abs(seed) * 26) | 0);
      const dx = (seed * 34) | 0;
      if (vw && vh)
        c.drawImage(src, 0, (sy / h) * vh, vw, (sliceH / h) * vh, dx, sy, w, sliceH);
    }
    c.fillStyle = "rgba(0,0,0,0.16)";
    for (let y = 0; y < h; y += 6) c.fillRect(0, y, w, 2);
  },
  impression: (c, cv, src, q) => drawVanGogh(c, cv, src, q),
  vaporwave: (c, cv, src, q) => artApply(c, src, q, artVapor),
  aurora: (c, cv, src, q) => artApply(c, src, q, artAurora),
  matrix: (c, cv, src, q) => artApply(c, src, q, artMatrix),
  gold: (c, cv, src, q) => artApply(c, src, q, artGold),
  rgb: (c, cv, src, q) => artApply(c, src, q, artRgb),
};

// ============================================================================
// Pixel-filter engine (CamanJS-style color grading, downsampled for speed).
// Processing happens on a half-res offscreen canvas, then the result is drawn
// back onto the clipped canvas — so only the finger-frame window changes.
// ============================================================================
const fxCanvas = document.createElement("canvas");
const fxCtx = fxCanvas.getContext("2d", { willReadFrequently: true });

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const s = max === 0 ? 0 : d / max;
  return { h: (h + 360) % 360, s: s * 100, v: max * 100 };
}
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

// Map a pixel-by-pixel function over a half-res copy, then draw it back.
function pixelFilter(c, cv, src, fn) {
  const fw = Math.max(2, Math.round(cv.width / 2));
  const fh = Math.max(2, Math.round(cv.height / 2));
  if (fxCanvas.width !== fw || fxCanvas.height !== fh) { fxCanvas.width = fw; fxCanvas.height = fh; }
  fxCtx.drawImage(src, 0, 0, fw, fh);
  const img = fxCtx.getImageData(0, 0, fw, fh);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const out = fn(d[i], d[i + 1], d[i + 2], (i / 4) % fw, Math.floor(i / 4 / fw));
    d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2];
  }
  fxCtx.putImageData(img, 0, 0);
  c.imageSmoothingEnabled = true;
  c.drawImage(fxCanvas, 0, 0, fw, fh, 0, 0, cv.width, cv.height);
}

// CamanJS colorize: pull every pixel toward a target color, keeping luminance.
function colorizeFilter(target, level) {
  return (c, cv, src) => {
    pixelFilter(c, cv, src, (r, g, b) => [
      r - (r - target[0]) * (level / 100),
      g - (g - target[1]) * (level / 100),
      b - (b - target[2]) * (level / 100),
    ]);
  };
}

// 负片染色：反相后向目标色偏移（红外/蓝/青/粉负片感）
function negativeColorFilter(target, k = 0.55) {
  return (c, cv, src) =>
    pixelFilter(c, cv, src, (r, g, b) => {
      const ir = 255 - r, ig = 255 - g, ib = 255 - b;
      return [
        Math.min(255, ir - (ir - target[0]) * k),
        Math.min(255, ig - (ig - target[1]) * k),
        Math.min(255, ib - (ib - target[2]) * k),
      ];
    });
}

const LIVE_COLOR_FILTERS = {
  red: negativeColorFilter([255, 77, 77]),
  blue: negativeColorFilter([77, 166, 255]),
  cyan: negativeColorFilter([51, 214, 214]),
  pink: negativeColorFilter([255, 126, 179]),
  green: negativeColorFilter([80, 220, 120]),
  yellow: negativeColorFilter([255, 215, 0]),
};
Object.assign(LIVE_EFFECTS, LIVE_COLOR_FILTERS);
let currentLiveEffect = "aurora";

// ---- filter mode: single / dual / five / auto (全能模式: dual+five merged) ----
let fxMode = "single";
let dualA = "aurora";
let dualB = "vaporwave";
let dualC = "impression";
let dualD = "pink";
let dualE = "green";
let dualSlot = "A";
const fxSlots = document.getElementById("fx-slots");

const FX_EMOJI = {
  invert: "🎞️", red: "❤️", blue: "💙", cyan: "💠", pink: "🌸", green: "💚", yellow: "💛",
  pixelate: "🧩", none: "🚫", glitch: "📺", impression: "🎨",
  vaporwave: "🌴", aurora: "🌌", matrix: "👾", gold: "🥇", rgb: "👻", greenscreen: "🟩",
};

function updateChipActive() {
   liveEffectsEl.querySelectorAll(".effect-chip").forEach((chip) => {
    const id = chip.dataset.effect;
    const on =
      fxMode === "single" ? id === currentLiveEffect :
      fxMode === "dual" ? id === dualA || id === dualB :
      id === dualA || id === dualB || id === dualC;
    chip.classList.toggle("active", on);
  });
}
function updateSlots() {
  document.getElementById("fx-slot-a-emoji").textContent = FX_EMOJI[dualA] || "🎞️";
  document.getElementById("fx-slot-b-emoji").textContent = FX_EMOJI[dualB] || "💙";
  document.getElementById("fx-slot-c-emoji").textContent = FX_EMOJI[dualC] || "🧩";
  document.getElementById("fx-slot-d-emoji").textContent = FX_EMOJI[dualD] || "💨";
  document.getElementById("fx-slot-e-emoji").textContent = FX_EMOJI[dualE] || "📺";
   document.querySelectorAll(".fx-slot").forEach((s) => {
    const on = s.dataset.slot === dualSlot;
    s.classList.toggle("active", on);
    // 双选只显示 A/B；四指/全能显示 A/B/C；单选整个面板隐藏。
    const hide = fxMode === "dual"
      ? (s.dataset.slot !== "A" && s.dataset.slot !== "B")
      : (s.dataset.slot === "D" || s.dataset.slot === "E");
    s.classList.toggle("hidden", hide);
  });
}
function setFxMode(mode) {
  fxMode = mode === "dual" ? "dual" : mode === "five" ? "five" : mode === "auto" ? "auto" : "single";
  // 各模式默认滤镜（切模式时应用）：
  // 单选=极光；双选=极光+金箔；四指/全能=极光+蒸汽波+印象派。
  if (fxMode === "dual") {
    dualA = "aurora";
    dualB = "gold";
  } else if (fxMode !== "single") {
    dualA = "aurora";
    dualB = "vaporwave";
    dualC = "impression";
  } else {
    currentLiveEffect = "aurora";
  }
  document.querySelectorAll(".fx-mode-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === fxMode)
  );
  fxSlots.classList.toggle("hidden", fxMode === "single");
  if (fxMode === "single") dualSlot = "A";
  updateChipActive();
  updateSlots();
}

document.getElementById("fx-mode-single").addEventListener("click", () => setFxMode("single"));
document.getElementById("fx-mode-dual").addEventListener("click", () => setFxMode("dual"));
document.getElementById("fx-mode-five").addEventListener("click", () => setFxMode("five"));
document.getElementById("fx-mode-auto").addEventListener("click", () => setFxMode("auto"));
setFxMode(fxMode); // initialize default 傻瓜模式 → show its slots
document.querySelectorAll(".fx-slot").forEach((s) =>
  s.addEventListener("click", () => {
    dualSlot = s.dataset.slot;
    updateSlots();
    updateChipActive();
  })
);

liveEffectsEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".effect-chip");
  if (!chip) return;
  if (fxMode === "dual" || fxMode === "five") {
    if (dualSlot === "A") dualA = chip.dataset.effect;
    else if (dualSlot === "B") dualB = chip.dataset.effect;
    else if (dualSlot === "C") dualC = chip.dataset.effect;
    else if (dualSlot === "D") dualD = chip.dataset.effect;
    else dualE = chip.dataset.effect;
    updateSlots();
  } else {
    currentLiveEffect = chip.dataset.effect;
  }
  updateChipActive();
  // Mobile: pick a filter and the drawer closes itself.
  if (isMobile) closeFxDrawer();
});

// ---- mobile filter drawer (🎨 button slides the panel in from the left) ----
const fxToggle = document.getElementById("btn-fx-toggle");
function openFxDrawer() {
  liveEffectsEl.classList.add("open");
  fxToggle?.classList.add("active");
  fxToggle?.setAttribute("aria-expanded", "true");
}
function closeFxDrawer() {
  liveEffectsEl.classList.remove("open");
  fxToggle?.classList.remove("active");
  fxToggle?.setAttribute("aria-expanded", "false");
}
fxToggle?.addEventListener("click", () => {
  if (liveEffectsEl.classList.contains("open")) closeFxDrawer();
  else openFxDrawer();
});
document.getElementById("btn-fx-close")?.addEventListener("click", closeFxDrawer);

// ---- camera mirror (default on, selfie style) ----
let mirrored = true;
const btnMirror = document.getElementById("btn-mirror");
function applyMirror() {
  liveCanvas.classList.toggle("mirrored", mirrored);
  btnMirror.classList.toggle("active", mirrored);
  btnMirror.textContent = mirrored ? "🔄" : "↔";
}
btnMirror.addEventListener("click", () => {
  mirrored = !mirrored;
  applyMirror();
});

// Sync the initial state: mirrored=true means the canvas gets .mirrored too,
// not just the button's active look.
applyMirror();

// ---- 贴图头像：人脸追踪 → 把透明头像图盖在脸上（录制不想露脸） ----
const btnSticker = document.getElementById("btn-sticker");
const stickerPanel = document.getElementById("sticker-panel");
const stickerSize = document.getElementById("sticker-size");
const stickerYoff = document.getElementById("sticker-yoff");
const stickerFile = document.getElementById("sticker-file");
let sticker = null;

async function ensureSticker() {
  if (sticker) return sticker;
  btnSticker.classList.add("loading");
  statusLive(t("sticker.loading"));
  sticker = await createHeadSticker({
    wasmUrl: WASM_URL,
    faceModelUrl: "./vendor/face_landmarker.task",
    imageUrl: "./assets/avatar/avatar.png",
    liveCtx: sceneCtx,
    canvasW: LIVE_CANVAS_W,
    canvasH: LIVE_CANVAS_H,
    detCanvas,
    detCtx,
    drawCover,
  }).catch((err) => {
    console.error(err);
    statusLive(t("sticker.error", { err: (err && err.message) || err }));
    return null;
  });
  btnSticker.classList.remove("loading");
  if (sticker) statusLive(t("sticker.ready"));
  return sticker;
}

btnSticker.addEventListener("click", async () => {
  if (!liveStarted) return;
  const s = await ensureSticker();
  if (!s) return;
  const on = !s.enabled;
  s.setEnabled(on);
  btnSticker.classList.toggle("active", on);
  stickerPanel.classList.toggle("hidden", !on);
  statusLive(on ? t("sticker.on") : t("sticker.off"));
});

// ---- 手部检测点可视化开关 ----
let showHandPoints = false;
const btnHandPoints = document.getElementById("btn-hand-points");
btnHandPoints.addEventListener("click", () => {
  showHandPoints = !showHandPoints;
  btnHandPoints.classList.toggle("active", showHandPoints);
  statusLive(showHandPoints ? t("points.on") : t("points.off"));
});

stickerSize.addEventListener("input", () => {
  if (sticker) sticker.setScale(parseFloat(stickerSize.value));
});
stickerYoff.addEventListener("input", () => {
  if (sticker) sticker.setYOff(parseFloat(stickerYoff.value));
});

// 换图：重新加载用户选的头像图并重新抠图。
stickerFile.addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (sticker) {
    const s = await replaceStickerImage(f);
    if (s) statusLive(t("sticker.ready"));
  }
});

async function replaceStickerImage(file) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("图片加载失败"));
    im.src = url;
  });
  // 直接用用户上传的图（透明 PNG），不做运行时抠像。
  sticker.__setImage(img);
  return sticker;
}

// ---- fullscreen toggle (bottom-right button) ----
const btnFullscreen = document.getElementById("btn-fullscreen");
function fsActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function toggleFullscreen() {
  const req = liveCanvasWrap.requestFullscreen || liveCanvasWrap.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (fsActive()) exit.call(document);
  else if (req) req.call(liveCanvasWrap).catch(() => {});
}
btnFullscreen.addEventListener("click", toggleFullscreen);
function syncFsIcon() {
  btnFullscreen.textContent = fsActive() ? "✕" : "⛶";
}
document.addEventListener("fullscreenchange", syncFsIcon);
document.addEventListener("webkitfullscreenchange", syncFsIcon);

// ---- record toggle (bottom-left buttons: manual + 10s) ----
const btnRecord = document.getElementById("btn-record");
const btnRecord10 = document.getElementById("btn-record10");
let liveRecorder = null;
let liveRecChunks = [];
let recStart = 0;
let recTimer = null;
let autoStopTimer = null;
let recType = null; // 'countdown' | 'manual' | 'fixed'

function updateRecLabels() {
  if (recType === "countdown") {
    const remain = Math.max(0.1, 3 - (performance.now() - recStart) / 1000);
    btnRecord10.textContent = `${t("record.count")} ${Math.ceil(remain)}s`;
    btnRecord10.disabled = false;
    btnRecord.disabled = true;
    return;
  }
  const s = (performance.now() - recStart) / 1000;
  if (recType === "fixed") {
    btnRecord10.textContent = `${t("record.rec10")} ${Math.max(0, 10 - s).toFixed(1)}s`;
    btnRecord10.disabled = false;
    btnRecord.disabled = true;
  } else if (recType === "manual") {
    btnRecord.textContent = `${t("record.rec")} ${s.toFixed(1)}s`;
    btnRecord.disabled = false;
    btnRecord10.disabled = true;
  }
}

function startRecording(type, autoStopSec) {
  if (liveRecorder) return;
  const stream = recCanvas.captureStream(30);
  const mime =
    ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find(
      (m) => MediaRecorder.isTypeSupported(m)
    ) || "video/webm";
  const isMp4 = mime.startsWith("video/mp4");
  liveRecorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 10_000_000,
  });
  liveRecChunks = [];
  liveRecorder.ondataavailable = (e) => e.data.size && liveRecChunks.push(e.data);
  liveRecorder.onstop = () => {
    const blob = new Blob(liveRecChunks, {
      type: isMp4 ? "video/mp4" : "video/webm",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `finger-play.${isMp4 ? "mp4" : "webm"}`;
    a.click();
    liveRecorder = null;
    clearInterval(recTimer);
    recTimer = null;
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
    recType = null;
    btnRecord.classList.remove("recording");
    btnRecord10.classList.remove("recording");
    btnRecord.disabled = false;
    btnRecord10.disabled = false;
    btnRecord.textContent = t("record.idle");
    btnRecord10.textContent = t("record.idle10");
  };
  recType = type;
  liveRecorder.start();
  recStart = performance.now();
  btnRecord.classList.add("recording");
  btnRecord10.classList.add("recording");
  updateRecLabels();
  recTimer = setInterval(updateRecLabels, 100);
  if (autoStopSec) {
    autoStopTimer = setTimeout(() => liveRecorder.stop(), autoStopSec * 1000);
  }
}

btnRecord.addEventListener("click", () => {
  if (recType === "countdown") return; // ignore during 3s prep
  if (liveRecorder) liveRecorder.stop();
  else startRecording("manual", null);
});
btnRecord10.addEventListener("click", () => {
  if (liveRecorder || recType === "countdown") return;
  if (recType === "manual" || recType === "fixed") {
    liveRecorder.stop();
    return;
  }
  // 3s countdown before recording 10s.
  recType = "countdown";
  recStart = performance.now();
  btnRecord.classList.add("recording");
  btnRecord10.classList.add("recording");
  updateRecLabels();
  recTimer = setInterval(updateRecLabels, 100);
  autoStopTimer = setTimeout(() => {
    clearInterval(recTimer);
    recTimer = null;
    autoStopTimer = null;
    btnRecord.classList.remove("recording");
    startRecording("fixed", 10);
  }, 3000);
});

btnLiveStart.addEventListener("click", async () => {
  if (liveStarted) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusLive(t("live.camUnavailable"));
    return;
  }
  btnLiveStart.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: isMobile
        ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }
        : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    liveVideo.srcObject = stream;
    await liveVideo.play();
    await waitForVideoSize(liveVideo);
    // Canvas is FIXED — never resized, layout stays rock solid.
    liveCanvas.width = LIVE_CANVAS_W;
    liveCanvas.height = LIVE_CANVAS_H;

    liveStartWrap.classList.add("hidden");
    liveWorkspace.classList.remove("hidden");
    liveStarted = true;

    // 画面立即启动（landmarker 未就绪时先显示纯摄像头画面）
    liveLoop();
    if (!landmarker) initLandmarker();
  } catch (err) {
    statusLive(t("live.camFail", { err: err.message || err }));
    console.error(err);
    btnLiveStart.disabled = false;
  }
});

function waitForVideoSize(v) {
  return new Promise((resolve) => {
    if (v.videoWidth) return resolve();
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (v.videoWidth || performance.now() - t0 > 8000) {
        clearInterval(iv);
        resolve();
      }
    }, 50);
  });
}

// Draw a video onto a canvas filling w×h with a cover crop (no distortion).
function drawCover(c, v, w, h) {
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return;
  const s = Math.max(w / vw, h / vh);
  const dw = vw * s, dh = vh * s;
  c.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

let liveDetSeq = 0;
function liveLoop() {
  if (!liveStarted) return;

  // 1. 合成场景画布：视频 + 贴图头像 + 手指（头像/手指在滤镜之前进场景，
  //    这样框内滤镜对它们同样生效 —— 头像 = 换脸）。
  drawCover(sceneCtx, liveVideo, LIVE_CANVAS_W, LIVE_CANVAS_H);
  if (sticker && sticker.enabled) {
    sticker.tick(liveVideo); // 画到 sceneCtx
    if (lastHands && lastHands.length) {
      drawHandsOnTop(sceneCtx, liveVideo, lastHands, LIVE_CANVAS_W, LIVE_CANVAS_H);
    }
  }

  // 2. 基础画面 = 场景（视频 + 头像），滤镜之前就位。
  liveCtx.drawImage(sceneCanvas, 0, 0);

  if (landmarker && liveFrame++ % (isMobile ? 2 : 1) === 0) {
    // Downscale into the small detection canvas (fast inference, no async
    // hop): detectForVideo(canvas) returns synchronously, so the result is
    // applied in the same frame — no extra latency behind the hands.
    // Desktop detects EVERY frame (60 fps, matches neon-hand-gesture's
    // "render never waits, detect every frame" feel); mobile throttles to
    // every 2 frames to protect the CPU delegate.
    drawCover(detCtx, liveVideo, DET_W, DET_H);
    const res = landmarker.detectForVideo(detCanvas, performance.now());
    lastHands = res.landmarks || null;
    updateTrackerLive(
      liveSt,
      res.landmarks || [],
      res.handedness || [],
      LIVE_CANVAS_W,
      LIVE_CANVAS_H
    );
    // Five-finger prism with hold: keep the last good pillar for a few frames
    // while the hands briefly drop / a finger bends, instead of collapsing
    // back to single-filter mode every time tracking blips.
    const fq = computeFiveFingers(
      res.landmarks || [],
      res.handedness || [],
      LIVE_CANVAS_W,
      LIVE_CANVAS_H
    );
    if (fq) {
      fiveQuads = fq;
      fiveLostFrames = 0;
    } else if (fiveQuads) {
      if (++fiveLostFrames > FIVE_MAX_LOST) fiveQuads = null;
    }
  }

  // 3. 滤镜框：数据源换成场景画布（头像 + 手指 + 背景一起吃滤镜）。
  if (liveSt.corners && liveSt.presence > 0.01) {
    if (fxMode === "five" || fxMode === "auto") {
      // Four fingers → 3 gaps between index/middle/ring/pinky, each its own
      // filter (A/B/C).
      if (fiveQuads) {
        renderPillar(
          liveCtx, liveCanvas, fiveQuads.tipsL, fiveQuads.tipsR,
          [dualA, dualB, dualC],
          sceneCanvas, liveSt.presence
        );
      } else if (fxMode === "auto") {
        // 傻瓜模式回落到四指框：交叉 → 左三角 A/右三角 B；正常 → 整个框 A。
        const { crossed, triA, triB } = splitQuad(liveSt.corners, LIVE_CANVAS_W);
        if (crossed && triA && triB) {
          drawWindow(triA, liveSt.presence, liveCtx, liveCanvas, (c, cv) =>
            LIVE_EFFECTS[dualA](c, cv, sceneCanvas, triA)
          );
          drawWindow(triB, liveSt.presence, liveCtx, liveCanvas, (c, cv) =>
            LIVE_EFFECTS[dualB](c, cv, sceneCanvas, triB)
          );
        } else {
          drawWindow(liveSt.corners, liveSt.presence, liveCtx, liveCanvas, (c, cv) =>
            LIVE_EFFECTS[dualFrameEffect(liveSt.corners)](c, cv, sceneCanvas, liveSt.corners)
          );
        }
      } else {
        // five: hands not fully open → fall back to whole A filter.
        drawWindow(liveSt.corners, liveSt.presence, liveCtx, liveCanvas, (c, cv) =>
          LIVE_EFFECTS[dualA](c, cv, sceneCanvas, liveSt.corners)
        );
      }
    } else if (fxMode === "dual") {
      const { crossed, triA, triB } = splitQuad(liveSt.corners, LIVE_CANVAS_W);
      if (crossed && triA && triB) {
        // Hands crossed → bow-tie: left triangle gets A, right triangle gets B.
        drawWindow(triA, liveSt.presence, liveCtx, liveCanvas, (c, cv) =>
          LIVE_EFFECTS[dualA](c, cv, sceneCanvas, triA)
        );
        drawWindow(triB, liveSt.presence, liveCtx, liveCanvas, (c, cv) =>
          LIVE_EFFECTS[dualB](c, cv, sceneCanvas, triB)
        );
      } else {
        // 正常框：按正反用 A 或 B（翻面 → B）。
        drawWindow(liveSt.corners, liveSt.presence, liveCtx, liveCanvas, (c, cv) =>
          LIVE_EFFECTS[dualFrameEffect(liveSt.corners)](c, cv, sceneCanvas, liveSt.corners)
        );
      }
    } else {
      drawWindow(liveSt.corners, liveSt.presence, liveCtx, liveCanvas, (c, cv) =>
        LIVE_EFFECTS[currentLiveEffect](c, cv, sceneCanvas, liveSt.corners)
      );
    }
  }

  // 4. 框线盖在最上层（手指画的框不能被头像压住）。
  if (
    liveSt.corners &&
    liveSt.presence > 0.01 &&
    fxMode !== "five" &&
    !(fxMode === "auto" && fiveQuads)
  ) {
    drawOutline(liveSt.corners, liveSt.presence, performance.now() / 1000, liveCtx);
  }

  // 手部检测点可视化（开关开启时，用最近一帧的 21 点）
  if (showHandPoints && lastHands && lastHands.length) {
    drawHandLandmarks(liveCtx, lastHands, LIVE_CANVAS_W, LIVE_CANVAS_H);
  }

  // 左上角水印（LOGO + 捏个框），始终画在最上层
  drawWatermark(liveCtx);

  // 录制期间同步到录制画布，让录制内容 = 屏幕所见（镜像开 → 画面镜像 + 水印左上角正向）
  if (liveRecorder) syncRecCanvas();

  liveRaf = requestAnimationFrame(liveLoop);
}

// 贴图头像开启时，把真实手画回最上层。用 21 个关键点连成手的外轮廓多边形
// 裁剪后画原始画面——只露出「手的形状」，手后面的背景/真脸不会漏出来，
// 头像不会被啃出窟窿。
function drawHandsOnTop(ctx, video, hands, W, H) {
  if (!hands) return;
  for (const hand of hands) {
    if (!hand || hand.length < 21) continue;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < hand.length; i++) {
      const x = hand[i].x * W, y = hand[i].y * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.clip();
    drawCover(ctx, video, W, H);
    ctx.restore();
  }
}

// ---- 手部检测点可视化（Air-Draw hand-vision 风格） ----
// 21 个关键点：按手指分色的霓虹圆点 + 骨骼连线 + 数字标签。
const HAND_SKELETON = [
  [0, 1], [1, 2], [2, 3], [3, 4],             // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8],             // 食指
  [5, 9], [9, 10], [10, 11], [11, 12],        // 中指
  [9, 13], [13, 14], [14, 15], [15, 16],      // 无名指
  [13, 17], [17, 18], [18, 19], [19, 20],     // 小指
  [0, 17],                                    // 掌心
];
const HAND_FINGER = [ // 每个点属于哪根手指（0..4，-1=掌心）
  -1, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4,
];
const HAND_COLORS = [
  "#ff9e3d", // 拇指 橙
  "#56e08f", // 食指 绿
  "#4dd2ff", // 中指 青
  "#ff6ad5", // 无名指 粉
  "#b96cff", // 小指 紫
  "#8ea2c0", // 掌心 灰蓝
];

function drawHandLandmarks(ctx, hands, W, H) {
  if (!hands) return;
  for (const hand of hands) {
    if (!hand || hand.length < 21) continue;
    const pts = hand.map((p) => ({ x: p.x * W, y: p.y * H }));

    // 骨骼连线（全黑加粗）
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const [a, b] of HAND_SKELETON) {
      ctx.strokeStyle = "#000";
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 圆点（全黑，无数字标签）
    for (let i = 0; i < pts.length; i++) {
      const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
      const isWrist = i === 0;
      const r = isWrist ? 9 : isTip ? 7 : 5;
      ctx.beginPath();
      ctx.fillStyle = "#000";
      ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ============================================================================
// Tracker (shared by both modes, state passed in)
// ============================================================================
function createTrackerState() {
  return { corners: null, presence: 0, frameActive: false, lostFrames: 0, jumpFrames: 0 };
}
const aiSt = createTrackerState();
const liveSt = createTrackerState();
let liveFrame = 0;
let lastHands = null; // 最近一帧的手部关键点（归一化），用于把手指盖到贴图上面

function toPixel(lm, w, h) {
  return { x: lm.x * w, y: lm.y * h };
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function lerpPt(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

function computeQuad(hands, w, h, st) {
  if (hands.length !== 2) return null;
  const info = hands.map((lm) => ({
    index: toPixel(lm[INDEX_TIP], w, h),
    thumb: toPixel(lm[THUMB_TIP], w, h),
    wristX: toPixel(lm[WRIST], w, h).x,
    scale: dist(toPixel(lm[WRIST], w, h), toPixel(lm[MIDDLE_MCP], w, h)) + 1,
  }));
  const needed = st.frameActive ? 0.2 : 0.75;
  for (const hd of info) {
    if (dist(hd.thumb, hd.index) < hd.scale * needed) return null;
  }
  info.sort((a, b) => a.wristX - b.wristX);
  const [A, B] = info;
  const pts = [A.index, B.index, B.thumb, A.thumb];
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const hull = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );
  const minArea = st.frameActive ? 0.0005 : 0.005;
  if (polygonArea(hull) < w * h * minArea) return null;
  return pts;
}

// Signed area via shoelace (four-finger-frame).
function signedArea(p) {
  return (
    (p[0].x * p[1].y - p[1].x * p[0].y) +
    (p[1].x * p[2].y - p[2].x * p[1].y) +
    (p[2].x * p[3].y - p[3].x * p[2].y) +
    (p[3].x * p[0].y - p[0].x * p[3].y)
  ) / 2;
}
// 双选正反：框的绕序（带符号面积）决定 A/B。
// 角点固定 [L.食指,R.食指,R.拇指,L.拇指]：正放（食指在上）→ 正面积 → A；
// 翻面（拇指在上/食指在下）→ 负面积 → B。带滞回防临界抖动。
let dualFlip = 1; // 1=正(A) -1=反(B)
function dualFrameEffect(q) {
  const sa = signedArea(q);
  if (sa > 800) dualFlip = 1;
  else if (sa < -800) dualFlip = -1;
  return dualFlip === 1 ? dualA : dualB;
}
// Max distance from centroid to any corner (four-finger-frame).
function quadSpan(p) {
  let mx = 0, my = 0;  for (const q of p) { mx += q.x; my += q.y; }
  mx /= 4; my /= 4;
  let d = 0;
  for (const q of p) d = Math.max(d, Math.hypot(q.x - mx, q.y - my));
  return d;
}

// Segment intersection (a-b vs c-d). Returns the crossing point when the
// segments genuinely cross in their interiors, otherwise null.
function segIntersect(a, b, c, d) {
  const d1x = b.x - a.x, d1y = b.y - a.y;
  const d2x = d.x - c.x, d2y = d.y - c.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * d2y - (c.y - a.y) * d2x) / den;
  const u = ((c.x - a.x) * d1y - (c.y - a.y) * d1x) / den;
  if (t > 0.05 && t < 0.95 && u > 0.05 && u < 0.95) {
    return { x: a.x + t * d1x, y: a.y + t * d1y };
  }
  return null;
}

// Split a crossed (bow-tie) quad into two triangles. A quad is a bow-tie when
// its edges p0-p1 and p2-p3 genuinely cross mid-segment (a normal rectangle
// has them parallel). signedArea can't tell us this — a symmetric bow-tie
// evaluates to 0. The two wings are the triangles {p0,p3,cp} and {p1,p2,cp}
// (adjacent vertex pairs), NOT {p0,p1,cp}/{p2,p3,cp}. triA = left wing,
// triB = right wing (by centroid x, in on-screen/mirrored coords when W given).
function splitQuad(q, W) {
  const cp = segIntersect(q[0], q[1], q[2], q[3]);
  if (!cp) return { crossed: false, triA: null, triB: null };
  const t1 = [q[0], q[3], cp];
  const t2 = [q[1], q[2], cp];
  let c1 = (t1[0].x + t1[1].x + t1[2].x) / 3;
  let c2 = (t2[0].x + t2[1].x + t2[2].x) / 3;
  if (W > 0) { c1 = W - c1; c2 = W - c2; } // mirror to on-screen coordinates
  return c1 <= c2
    ? { crossed: true, triA: t1, triB: t2 }
    : { crossed: true, triA: t2, triB: t1 };
}

// ---- Five-finger pillar tracking ----------------------------------------
// When both hands are fully spread, the 5 paired fingertips form 4 pillar
// quads: [L[i], L[i+1], R[i+1], R[i]] for i = 0..3. Each pillar gets its own
// filter (slots A/B/C/D). Returns { quads, height } in pixel coords, or null
// when either hand is missing / not fully open.
const FINGER_TIPS = [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP];
let fiveQuads = null;
let fiveLostFrames = 0;
const FIVE_MAX_LOST = 15;

function computeFiveFingers(hands, handedness, w, h) {
  const valid = [];
  for (let i = 0; i < hands.length; i++) {
    const conf = handedness?.[i]?.[0]?.score ?? 0.8;
    if (conf >= 0.3) valid.push(hands[i]);
  }
  if (valid.length !== 2) return null;
  valid.sort((a, b) => toPixel(a[WRIST], w, h).x - toPixel(b[WRIST], w, h).x);
  const [L, R] = valid;
  const wristL = toPixel(L[WRIST], w, h);
  const wristR = toPixel(R[WRIST], w, h);
  const scaleL = dist(wristL, toPixel(L[MIDDLE_MCP], w, h)) + 1;
  const scaleR = dist(wristR, toPixel(R[MIDDLE_MCP], w, h)) + 1;
  const tipsL = FINGER_TIPS.map((i) => toPixel(L[i], w, h));
  const tipsR = FINGER_TIPS.map((i) => toPixel(R[i], w, h));
  // 张开门禁：食指/中指/无名指/小指（tips 1..4）都要离手腕够远才出区。
  // 否则（比如只露两根手指）全能模式就不会误触发，正常回落单选框。
  // 拇指不参与区，收着也不影响。阈值宽松 + 丢失保持避免闪。
  const open = (tips, wrist, scale) =>
    tips.slice(1).every((p) => dist(p, wrist) > 0.6 * scale);
  if (!open(tipsL, wristL, scaleL) || !open(tipsR, wristR, scaleR)) return null;
  return { tipsL, tipsR };
}

// ---- Live tracker: verbatim port of four-finger-frame's gating.
// Draw when all four corners are seen this frame AND (area > 300 px² OR span
// > 50 px) — a deliberately loose pixel gate, so the box appears the moment
// the hands make even a small open frame. No "fingers must spread to 0.75×
// palm" requirement, no proportional-area minimum.
function updateTrackerLive(st, hands, handedness, w, h) {
  if (!st.corners) st.corners = [null, null, null, null];
  const seen = [false, false, false, false];
  const next = [...st.corners];

  // Filter low-confidence hands (score still from handedness), then assign the
  // four corners by ON-SCREEN wrist X — never by the handedness label. MediaPipe
  // assumes a mirrored selfie input, so its Left/Right labels are inverted for
  // a raw un-mirrored getUserMedia feed; wrist X is mirror-proof and keeps the
  // corner order as a proper clockwise rectangle for the normal gesture.
  const valid = [];
  for (let i = 0; i < hands.length; i++) {
    const conf = handedness?.[i]?.[0]?.score ?? 0.8;
    if (conf >= 0.3) valid.push(hands[i]);
  }
  if (valid.length >= 2) {
    valid.sort((a, b) => toPixel(a[WRIST], w, h).x - toPixel(b[WRIST], w, h).x);
    const L = valid[0]; // left-most (smallest un-mirrored x)
    const R = valid[1];
    const pts = [
      [0, toPixel(L[INDEX_TIP], w, h)],
      [1, toPixel(R[INDEX_TIP], w, h)],
      [2, toPixel(R[THUMB_TIP], w, h)],
      [3, toPixel(L[THUMB_TIP], w, h)],
    ];
    for (const [ci, p] of pts) {
      const prev = st.corners[ci] ?? p;
      next[ci] = lerpPt(prev, p, 0.75);
      seen[ci] = true;
    }
  }

  const allSeen = seen.every(Boolean);
  const sa = allSeen ? signedArea(next) : 0;
  const span = allSeen ? quadSpan(next) : 0;
  const shouldDraw = allSeen && (Math.abs(sa) > 300 || span > 50);

  if (shouldDraw) {
    st.lostFrames = 0;
    st.corners = next;
    st.frameActive = true;
    st.presence = Math.min(1, st.presence + 0.12);
  } else if (
    st.corners &&
    st.corners.every(Boolean) &&
    ++st.lostFrames <= MAX_LOST_FRAMES
  ) {
    // Hands briefly lost (fast motion / out of frame for a few frames): hold
    // the last good corners and KEEP presence up so the box never blinks —
    // the draw gate is presence > 0.01, so fading it here would hide the box.
    st.presence = Math.min(1, st.presence + 0.05);
  } else {
    st.presence = Math.max(0, st.presence - 0.05);
    if (st.presence === 0) {
      st.corners = null;
      st.frameActive = false;
      st.lostFrames = 0;
    }
  }
}

// ---- AI tracker: smooth, gated (suited to video-to-video alignment).
function updateTracker(st, hands, w, h) {
  const target = computeQuad(hands, w, h, st);
  if (target) {
    if (!st.corners) {
      st.lostFrames = 0;
      st.frameActive = true;
      st.jumpFrames = 0;
      st.corners = target;
      st.presence = Math.min(1, st.presence + 0.12);
    } else {
      const moved = target.reduce((s, p, i) => s + dist(p, st.corners[i]), 0) / 4;
      if (moved > w * 0.3 && ++st.jumpFrames < JUMP_CONFIRM_FRAMES) {
        if (++st.lostFrames > MAX_LOST_FRAMES) st.presence = Math.max(0, st.presence - 0.05);
      } else {
        st.lostFrames = 0;
        st.frameActive = true;
        st.jumpFrames = 0;
        const alpha = Math.min(0.85, Math.max(0.35, moved / (w * 0.05)));
        st.corners = st.corners.map((c, i) => lerpPt(c, target[i], alpha));
        st.presence = Math.min(1, st.presence + 0.12);
      }
    }
  } else if (st.corners && ++st.lostFrames <= MAX_LOST_FRAMES) {
    st.presence = Math.min(1, st.presence + 0.12);
  } else {
    st.presence = Math.max(0, st.presence - 0.05);
    if (st.presence === 0) {
      st.corners = null;
      st.frameActive = false;
      st.jumpFrames = 0;
    }
  }
}

// ============================================================================
// Rendering (shared)
// ============================================================================
function quadPath(c, q) {
  c.beginPath();
  c.moveTo(q[0].x, q[0].y);
  for (let i = 1; i < q.length; i++) c.lineTo(q[i].x, q[i].y);
  c.closePath();
}

function drawWindow(q, presence, c, cv, drawContent) {
  c.save();
  quadPath(c, q);
  c.clip();
  c.globalAlpha = presence;
  drawContent(c, cv);
  c.restore();
  c.globalAlpha = 1;
}

// Render the whole two-hand region as ONE 3D-looking pillar with 5 faces,
// Render the 5 side faces of the two-hand prism only (no top/bottom lids):
// side i = [L[i], L[i+1], R[i+1], R[i]] gets slot i's filter (A/B/C/D/E).
// 把 4 个顶点按绕质心角度排序：手交叉时四边形也不会自交（蝴蝶结），
// 永远是一个有效的凸四边形区域（移植自 FingerLens 的核心技巧）。
function orderQuad(p) {
  if (p.length !== 4) return p;
  let cx = 0, cy = 0;
  for (const q of p) { cx += q.x; cy += q.y; }
  cx /= 4; cy /= 4;
  return p.slice().sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );
}

// 3 个指缝区的描边色（食指-中指/中指-无名指/无名指-小指）。
const PILLAR_COLORS = ["#ff36b5", "#ff9f1f", "#38ffeb"];

// 区间距（像素）：每个区向中心内缩，让 3 个滤镜互相隔开、各自独立。
const PILLAR_GAP = 10;

// 四边形向中心内缩 m 像素（产生可见间隔）。
function shrinkQuad(q, m) {
  let cx = 0, cy = 0;
  for (const p of q) { cx += p.x; cy += p.y; }
  cx /= q.length; cy /= q.length;
  return q.map((p) => {
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.max(0, 1 - m / d);
    return { x: cx + dx * k, y: cy + dy * k };
  });
}

// 平面 4 指：用食指/中指/无名指/小指（tips 下标 1..4），两两相邻构成 3 个
// 交叉区（食指-中指/中指-无名指/无名指-小指），按顺序填 A/B/C，内缩出间隔，
// 0.94 alpha 软边 + 每区彩色蚂蚁线描边。不做 3D 柱体。
function renderPillar(c, cv, tipsL, tipsR, slots, src, presence) {
  const n = 3;
  for (let i = 0; i < n; i++) {
    const a = i + 1, b = i + 2; // tips: 0拇指 1食指 2中指 3无名指 4小指
    const q = shrinkQuad(
      orderQuad([tipsL[a], tipsL[b], tipsR[b], tipsR[a]]),
      PILLAR_GAP
    );
    drawWindow(q, presence * 0.94, c, cv, (cc, cccv) =>
      LIVE_EFFECTS[slots[i]](cc, cccv, src, q)
    );
    marchingQuad(c, q, PILLAR_COLORS[i], presence);
  }
}

// 彩色蚂蚁线描边：虚线沿边框流动（对应 drawOutline 的行进蚂蚁风格）。
function marchingQuad(c, q, color, presence) {
  const t = performance.now() / 1000;
  c.save();
  c.globalAlpha = presence;
  quadPath(c, q);
  c.setLineDash([10, 8]);
  c.lineDashOffset = -t * 40;
  c.lineWidth = 2;
  c.strokeStyle = color;
  c.shadowColor = "rgba(0,0,0,0.4)";
  c.shadowBlur = 5;
  c.stroke();
  c.setLineDash([]);
  c.lineDashOffset = 0;
  c.restore();
}

function drawOutline(q, presence, t, c) {
  c.save();
  c.globalAlpha = presence;
  quadPath(c, q);
  // 干净的白虚线（行进蚂蚁），配暗色柔和阴影增加对比，而不是粗深色线。
  c.setLineDash([10, 8]);
  c.lineDashOffset = -t * 40;
  c.lineWidth = 2;
  c.strokeStyle = "rgba(255,255,255,0.95)";
  c.shadowColor = "rgba(0,0,0,0.5)";
  c.shadowBlur = 6;
  c.stroke();
  c.setLineDash([]);
  c.lineDashOffset = 0;
  c.shadowBlur = 0;
  // 四个角的小圆点：柔和扩散光晕 + 白色实心点 + 细暗圈。
  q.forEach((p, i) => {
    const r = 7 + Math.sin(t * 3 + i * 1.5) * 1.5;
    const halo = (t * 0.8 + i * 0.25) % 1;
    c.beginPath();
    c.arc(p.x, p.y, r + halo * 14, 0, Math.PI * 2);
    c.strokeStyle = `rgba(255,255,255,${0.5 * (1 - halo) * presence})`;
    c.lineWidth = 2;
    c.stroke();
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.fillStyle = "#fff";
    c.fill();
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.strokeStyle = "rgba(0,0,0,0.25)";
    c.lineWidth = 1.5;
    c.stroke();
  });
  c.restore();
}

// ============================================================================
// Model status badge (online mode, top-left of the live canvas)
// ============================================================================
const modelBadge = document.getElementById("model-badge");
const mbText = document.getElementById("mb-text");

function setModelBadge(state, msg) {
  if (!modelBadge) return;
  modelBadge.dataset.state = state;
  mbText.textContent = msg;
}

// ============================================================================
// Model init
// ============================================================================
async function initLandmarker() {
  const msg = t("status.model.loading");
  status(msg);
  statusLive(msg);
  setModelBadge("loading", t("model.loading"));
  try {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    // CPU delegate measured 28ms vs 216ms for GPU(SwiftShader/iGPU) at this
    // input size — CPU is far more predictable across devices (incl. weak
    // iGPUs), so we always use it. 320×240 is the model's happy size.
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.3,
      minHandPresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
    });
    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU"));
    } catch (err) {
      if (err) throw err;
      landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU"));
    }
    const ok = t("status.model.ready");
    status(ok);
    statusLive(ok);
    setModelBadge("ready", t("model.ready"));
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    const m = t("status.model.fail", { err: reason });
    status(m);
    statusLive(m);
    setModelBadge("error", t("model.fail", { err: reason }));
    console.error(err);
  }
}

// ============================================================================
// 合成模式 — 上传原视频 + AI 风格化视频，两段齐了就合成
// ============================================================================

let haveOrig = false;
let haveSty = false;
let recorder = null;
let exporting = false;
let aiLastHands = null; // 合成模式最近一帧的手部 landmarks（供手点加回）
let aiFiveQuads = null; // 合成模式四指/全能的指缝区（双手张开时非 null，供 renderPillar 用）
let aiFiveLostFrames = 0;
let swapCompose = true; // 合成模式：视频中点后框内换成原视频、框外变成风格化

// ---- 合成界面效果清单：显示录制时选了哪些效果，合成时会加回哪些 ----
const compFxSummaryEl = document.getElementById("comp-fx-summary");
const compFxChipsEl = document.getElementById("comp-fx-chips");

const FX_MODE_NAMES = { single: "fx.mode.single", dual: "fx.mode.dual", five: "fx.mode.five", auto: "fx.mode.auto" };

function renderFxSummary() {
  if (!compFxChipsEl) return;
  const chips = [];
  // 滤镜模式 + 当前滤镜
  const modeName = t(FX_MODE_NAMES[fxMode] || "fx.mode.single");
  if (fxMode === "dual" || fxMode === "five" || fxMode === "auto") {
    const effs = [];
    if (fxMode === "dual") {
      effs.push(`${FX_EMOJI[dualA] || ""} ${t("fx.slotA")}·${t("fx." + dualA)}`);
      effs.push(`${FX_EMOJI[dualB] || ""} ${t("fx.slotB")}·${t("fx." + dualB)}`);
    } else {
      effs.push(`${FX_EMOJI[dualA] || ""} ${t("fx.slotA")}·${t("fx." + dualA)}`);
      effs.push(`${FX_EMOJI[dualB] || ""} ${t("fx.slotB")}·${t("fx." + dualB)}`);
      effs.push(`${FX_EMOJI[dualC] || ""} ${t("fx.slotC")}·${t("fx." + dualC)}`);
    }
    chips.push({ text: `${modeName}（${effs.join(" / ")}）`, on: true });
  } else {
    chips.push({
      text: `${modeName}：${FX_EMOJI[currentLiveEffect] || ""} ${t("fx." + currentLiveEffect)}`,
      on: true,
    });
  }
  // 贴图头像
  chips.push({ text: `🙈 ${t("sticker.title")}`, on: !!(sticker && sticker.enabled) });
  // 手部检测点
  chips.push({ text: `🖐 ${t("points.title")}`, on: showHandPoints });
  // 后半段换位
  chips.push({ text: t("comp.summary.swap"), on: swapCompose });

  compFxChipsEl.innerHTML = "";
  const hasAny = chips.some((c) => c.on);
  if (!hasAny) {
    const chip = document.createElement("span");
    chip.className = "cfs-chip empty";
    chip.textContent = t("comp.summary.empty");
    compFxChipsEl.appendChild(chip);
    return;
  }
  for (const c of chips) {
    if (!c.on) continue;
    const chip = document.createElement("span");
    chip.className = "cfs-chip";
    const dot = document.createElement("span");
    dot.className = "cfs-dot";
    dot.style.background = "var(--mint)";
    chip.appendChild(dot);
    const txt = document.createElement("span");
    txt.textContent = c.text;
    chip.appendChild(txt);
    compFxChipsEl.appendChild(chip);
  }
}

// 切到合成模式或状态变化时刷新清单
renderFxSummary();
const _origRenderFx = renderFxSummary;
setInterval(() => {
  if (!document.getElementById("mode-ai").classList.contains("hidden")) _origRenderFx();
}, 800);

// 后半段换位开关
const compSwapEl = document.getElementById("comp-swap");
if (compSwapEl) {
  compSwapEl.addEventListener("change", (e) => {
    swapCompose = e.target.checked;
    renderFxSummary();
  });
}

// ---- 原视频上传（第 1 卡） ----
document.getElementById("file").addEventListener("change", (e) => {
  if (e.target.files[0]) loadVideo(e.target.files[0]);
});
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files[0]) loadVideo(e.dataTransfer.files[0]);
});

// ---- 风格化视频上传（第 2 卡） ----
const fileSty = document.getElementById("file-sty");
fileSty.addEventListener("change", (e) => {
  if (e.target.files[0]) loadStyVideo(e.target.files[0]);
});
dropSty.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropSty.classList.add("over");
});
dropSty.addEventListener("dragleave", () => dropSty.classList.remove("over"));
dropSty.addEventListener("drop", (e) => {
  e.preventDefault();
  dropSty.classList.remove("over");
  if (e.dataTransfer.files[0]) loadStyVideo(e.dataTransfer.files[0]);
});

// 复制提示词（卡片里只显示两行，点按钮复制当前版本的完整提示词）
const copyPromptBtn = document.getElementById("btn-copy-prompt");
const copyPromptOrig = t("comp.drop2.copy");
let promptVer = "basic";
document.querySelectorAll(".prompt-tab").forEach((tab) => {
  tab.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    promptVer = tab.dataset.ver;
    document.querySelectorAll(".prompt-tab").forEach((b) =>
      b.classList.toggle("active", b === tab)
    );
    document.querySelectorAll(".prompt-pane").forEach((p) =>
      p.classList.toggle("active", p.dataset.ver === promptVer)
    );
  });
});
copyPromptBtn.addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const full = t(`comp.drop2.prompt.${promptVer}`);
  try {
    await navigator.clipboard.writeText(full);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = full;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  copyPromptBtn.textContent = t("comp.drop2.copied");
  setTimeout(() => (copyPromptBtn.textContent = copyPromptOrig), 1500);
});

function updateStage() {
  stage.classList.toggle("hidden", !(haveOrig && haveSty));
  btnPlay.disabled = !(haveOrig && haveSty);
  btnExport.disabled = !(haveOrig && haveSty);
}

async function loadVideo(file) {
  orig.src = URL.createObjectURL(file);
  await new Promise((res) => (orig.onloadedmetadata = res));
  canvas.width = orig.videoWidth;
  canvas.height = orig.videoHeight;
  drop.classList.add("compact");
  drawPoster();
  if (!landmarker) initLandmarker();
  haveOrig = true;
  updateStage();
  if (haveSty) {
    status(readyStatus());
  } else {
    status(
      t("status.video.loaded", {
        name: file.name,
        w: orig.videoWidth,
        h: orig.videoHeight,
        dur: orig.duration.toFixed(1),
      }) + " " + t("status.sty.need")
    );
  }
}

async function loadStyVideo(file) {
  sty.src = URL.createObjectURL(file);
  await new Promise((res) => (sty.onloadedmetadata = res));
  dropSty.classList.add("compact");
  styMeta = {
    name: file.name,
    w: sty.videoWidth,
    h: sty.videoHeight,
    dur: sty.duration.toFixed(1),
  };
  haveSty = true;
  updateStage();
  if (haveOrig) {
    status(readyStatus());
  } else {
    status(
      t("status.sty.loaded", styMeta) + " " + t("status.orig.need")
    );
  }
}

let styMeta = null;
let mismatchWarned = false;
function checkSizeMismatch() {
  if (haveOrig && haveSty && !mismatchWarned) {
    const sw = canvas.width, sh = canvas.height;
    if (Math.abs(sw - sty.videoWidth) > 2 || Math.abs(sh - sty.videoHeight) > 2) {
      mismatchWarned = true;
    }
  }
}
function readyStatus() {
  checkSizeMismatch();
  const msg = t("status.sty.loaded", styMeta) + " " + t("status.both.ready");
  return mismatchWarned ? msg + " " + t("status.size.mismatch") : msg;
}

function drawPoster() {
  orig.currentTime = 0.01;
  orig.onseeked = () => {
    ctx.drawImage(orig, 0, 0, canvas.width, canvas.height);
    orig.onseeked = null;
  };
}

const srcParam = new URLSearchParams(location.search).get("src");
if (srcParam) {
  fetch(srcParam)
    .then((r) => r.blob())
    .then((b) => loadVideo(new File([b], srcParam, { type: "video/quicktime" })));
}

// ============================================================================
// 合成播放
// ============================================================================
// 合成模式渲染计划：根据滤镜模式 + 当前手部状态，决定框内滤镜的区域分配。
// 与 live 模式的渲染分支一一对应（liveLoop），抽成纯函数便于单测 ——
// 保证合成效果与录制时一致。返回 { type, ... }：
//   pillar     = 四指/全能的 3 个指缝区（A/B/C），tipsL/tipsR + effects
//   triangles  = 双手交叉（蝴蝶结）左三角 A / 右三角 B
//   quad       = 整框单个滤镜
function composeFxPlan(fxMode, corners, fiveQuads, W) {
  if (fxMode === "five" || fxMode === "auto") {
    if (fiveQuads) {
      return {
        type: "pillar",
        tipsL: fiveQuads.tipsL,
        tipsR: fiveQuads.tipsR,
        effects: [dualA, dualB, dualC],
      };
    }
    if (fxMode === "auto") {
      const { crossed, triA, triB } = splitQuad(corners, W);
      if (crossed && triA && triB) {
        return { type: "triangles", triA, triB, effectA: dualA, effectB: dualB };
      }
    }
    // 四指：手未完全张开 → 整框 A；全能回落四指框 → 按正反 A/B。
    return { type: "quad", effect: fxMode === "five" ? dualA : dualFrameEffect(corners) };
  }
  if (fxMode === "dual") {
    const { crossed, triA, triB } = splitQuad(corners, W);
    if (crossed && triA && triB) {
      return { type: "triangles", triA, triB, effectA: dualA, effectB: dualB };
    }
    return { type: "quad", effect: dualFrameEffect(corners) };
  }
  return { type: "quad", effect: currentLiveEffect };
}

// 合成模式的「框内画面源」：默认前半段是风格化视频、后半段（视频中点后）是原视频。
// 返回 { frame, isSwapped }——frame 是滤镜作用在框内的源。都在中点一次性切换，
// 不做逐帧淡入淡出（与手势框的风格保持一致）。
function isComposeSwapped(swapOn, bothLoaded, duration, t) {
  if (!swapOn || !bothLoaded || !duration || !isFinite(duration)) return false;
  return t >= duration / 2;
}
function composeFrameSource() {
  const swapped = isComposeSwapped(swapCompose, haveOrig && haveSty, orig.duration, orig.currentTime);
  return swapped ? { frame: orig, isSwapped: true } : { frame: sty, isSwapped: false };
}

let lastVideoTime = -1;
function loop() {
  if (!orig.paused && !orig.ended) requestAnimationFrame(loop);

  // 前半段：整帧画原视频，框内套风格化；后半段（中点后）：整帧画风格化，框内换回原视频。
  const { frame, isSwapped } = composeFrameSource();
  if (isSwapped) ctx.drawImage(sty, 0, 0, canvas.width, canvas.height);
  else ctx.drawImage(orig, 0, 0, canvas.width, canvas.height);

  if (landmarker && orig.currentTime !== lastVideoTime) {
    lastVideoTime = orig.currentTime;
    // 在线模式验证过：MediaPipe 从隐藏的 <video> 元素直接抓帧会拿不到画面
    // （video{display:none}），必须先把当前帧画到检测画布再 detect —— 与
    // liveLoop 的 drawCover(detCtx, liveVideo, DET_W, DET_H) 一致。
    drawCover(detCtx, orig, DET_W, DET_H);
    const res = landmarker.detectForVideo(detCanvas, performance.now());
    aiLastHands = res.landmarks || null;
    updateTracker(aiSt, res.landmarks || [], canvas.width, canvas.height);
    // 合成模式也要追踪四指/全能的指缝区（与 liveLoop 的 fiveQuads 一致，带丢失保持）
    const fq = computeFiveFingers(
      res.landmarks || [],
      res.handedness || [],
      canvas.width,
      canvas.height
    );
    if (fq) {
      aiFiveQuads = fq;
      aiFiveLostFrames = 0;
    } else if (aiFiveQuads) {
      if (++aiFiveLostFrames > FIVE_MAX_LOST) aiFiveQuads = null;
    }
  }

  if (haveSty && Math.abs(sty.currentTime - orig.currentTime) > 0.15) {
    sty.currentTime = orig.currentTime;
  }

  if (aiSt.corners && aiSt.presence > 0.01) {
    // 合成时把录制时选的滤镜「加回」：框内对风格化视频套滤镜（复用在线
    // 模式同一条 LIVE_EFFECTS 管线）。录制下载的是干净源文件，特效在这里重画。
    const plan = composeFxPlan(fxMode, aiSt.corners, aiFiveQuads, canvas.width);
    if (plan.type === "pillar") {
      // 四指/全能：双手张开 → 3 个指缝区各套一个滤镜（A/B/C），与录制一致。
      renderPillar(ctx, canvas, plan.tipsL, plan.tipsR, plan.effects, frame, aiSt.presence);
    } else if (plan.type === "triangles") {
      drawWindow(plan.triA, aiSt.presence, ctx, canvas, (c, cv) =>
        LIVE_EFFECTS[plan.effectA](c, cv, frame, plan.triA)
      );
      drawWindow(plan.triB, aiSt.presence, ctx, canvas, (c, cv) =>
        LIVE_EFFECTS[plan.effectB](c, cv, frame, plan.triB)
      );
    } else {
      drawWindow(aiSt.corners, aiSt.presence, ctx, canvas, (c, cv) =>
        LIVE_EFFECTS[plan.effect](c, cv, frame, aiSt.corners)
      );
    }
    // 四指/全能有指缝区时 renderPillar 已画彩色蚂蚁线，不再画整框线。
    if (fxMode !== "five" && !(fxMode === "auto" && aiFiveQuads)) {
      drawOutline(aiSt.corners, aiSt.presence, orig.currentTime, ctx);
    }
  }

  // 合成时把录制时开的手部检测点（🖐 黑骨架）加回
  if (showHandPoints && aiLastHands && aiLastHands.length) {
    drawHandLandmarks(ctx, aiLastHands, canvas.width, canvas.height);
  }
}

async function playThrough() {
  Object.assign(aiSt, createTrackerState());
  orig.currentTime = 0;
  sty.currentTime = 0;
  sty.play();
  await orig.play();
  requestAnimationFrame(loop);
}

btnPlay.addEventListener("click", () => {
  if (exporting) return;
  playThrough();
  status(t("status.preview"));
});

// ============================================================================
// 合成导出
// ============================================================================
btnExport.addEventListener("click", async () => {
  if (exporting) return;
  exporting = true;
  btnExport.disabled = true;
  btnPlay.disabled = true;
  status(t("status.exporting"));

  const stream = canvas.captureStream(30);
  const mime = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm",
  ].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
  const isMp4 = mime.startsWith("video/mp4");
  recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 10_000_000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const ext = isMp4 ? "mp4" : "webm";
    const blob = new Blob(chunks, { type: isMp4 ? "video/mp4" : "video/webm" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `finger-frame.${ext}`;
    a.click();
    status(
      t("status.exported", { file: `finger-frame.${ext}` }) +
      (isMp4 ? "" : t("status.exported.webm"))
    );
    exporting = false;
    btnExport.disabled = false;
    btnPlay.disabled = false;
  };

  orig.onended = () => {
    orig.onended = null;
    recorder.stop();
  };
  recorder.start();
  await playThrough();
});

// Test hook: expose pure tracker functions for Playwright unit tests.
window.__fingerPlayTest = {
  updateTrackerLive,
  createTrackerState,
  aiSt,
  updateTracker,
  landmarker: () => landmarker,
  polygonArea,
  toPixel,
  LIVE_EFFECTS,
  getLiveEffect: () => currentLiveEffect,
  liveSt,
  liveCanvas,
  liveVideo,
  sceneCanvas,
  drawCover,
  drawHandsOnTop,
  drawHandLandmarks,
  handPoints: () => showHandPoints,
  setHandPoints: (on) => { showHandPoints = !!on; if (btnHandPoints) btnHandPoints.classList.toggle("active", showHandPoints); },
  setFxMode: (m) => { if (["single", "dual", "five", "auto"].includes(m)) fxMode = m; },
  renderFxSummary,
  segIntersect,
  splitQuad,
  orderQuad,
  signedArea,
  dualFrameEffect,
  composeFxPlan,
  composeFrameSource,
  isComposeSwapped,
  setSwapCompose: (on) => { swapCompose = !!on; },
  swapCompose: () => swapCompose,
  getDualAB: () => ({ a: dualA, b: dualB }),
  renderPillar,
  computeFiveFingers,
  i18n: { t, setLocale, getLocale, hasLocale, applyDataI18n },
  drawWatermark,
  wmLogo,
  recCanvas,
  syncRecCanvas,
  setMirror: (on) => {
    mirrored = !!on;
    liveCanvas.classList.toggle("mirrored", mirrored);
    if (btnMirror) btnMirror.classList.toggle("active", mirrored);
  },
  sticker: {
    computeFaceRect,
    computeFaceRoll,
    stickerDrawRect,
    init: ensureSticker,
    ready: () => !!(sticker),
    enabled: () => !!(sticker && sticker.enabled),
    setEnabled: (on) => {
      if (sticker) sticker.setEnabled(on);
      return !!(sticker && sticker.enabled);
    },
    setScale: (s) => { if (sticker) sticker.setScale(s); },
    setYOff: (v) => { if (sticker) sticker.setYOff(v); },
    yOff: () => (sticker ? sticker.yOff : null),
    drawTest: (rect, roll) => (sticker ? sticker.drawTest(rect, roll) : false),
  },
  // Diagnostic: run one real detection on the offscreen canvas and return the
  // raw landmarks (normalized to the DET canvas) plus the DET canvas size, so
  // we can verify landmarks land on the same pixel as the visible video.
  detectOnce: () => {
    if (!landmarker || !liveVideo.videoWidth) return null;
    drawCover(detCtx, liveVideo, DET_W, DET_H);
    const res = landmarker.detectForVideo(detCanvas, performance.now());
    return {
      landmarks: (res.landmarks || []).map((lm) => lm.map((p) => ({ x: p.x, y: p.y, z: p.z }))),
      detW: detCanvas.width,
      detH: detCanvas.height,
      canvasW: LIVE_CANVAS_W,
      canvasH: LIVE_CANVAS_H,
    };
  },
  // Benchmark a single detectForVideo() call against the live offscreen
  // canvas. Returns per-call latency stats so we can see where the lag is.
  benchDetect: (n = 30) => {
    if (!landmarker) return { error: "landmarker not ready" };
    if (!liveVideo.videoWidth) return { error: "no video stream" };
    drawCover(detCtx, liveVideo, DET_W, DET_H);
    const times = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      landmarker.detectForVideo(detCanvas, performance.now());
      times.push(performance.now() - t0);
    }
    const sorted = [...times].sort((a, b) => a - b);
    return {
      n,
      first: +times[0].toFixed(1),
      p50: +sorted[Math.floor(n * 0.5)].toFixed(1),
      p90: +sorted[Math.floor(n * 0.9)].toFixed(1),
      max: +sorted[n - 1].toFixed(1),
      detCanvas: `${DET_W}x${DET_H}`,
      delegate: "CPU",
    };
  },
};
