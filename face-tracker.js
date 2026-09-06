// face-tracker.js — MediaPipe Face Landmarker 人脸追踪。
// 供贴图头像（head-sticker.js）使用：识别人脸 → 返回「人脸矩形 + 头部倾斜角」。

import { FaceLandmarker, FilesetResolver } from "./vendor/vision_bundle.mjs";

const FACE_COVER = 1.35; // 人脸包围盒放大系数
const FACE_EVERY = 2; // 每 N 帧检测一次人脸（CPU 省一半）

// 关键点索引：左右眼外角（MediaPipe 命名，33=右眼外角、263=左眼外角）。
const EYE_R_OUTER = 33;
const EYE_L_OUTER = 263;

// 归一化 landmark（0..1，未镜像视频坐标）→ 画布像素级人脸矩形（含放大）。
export function computeFaceRect(landmarks, canvasW, canvasH, cover = FACE_COVER) {
  if (!landmarks || landmarks.length < 10) return null;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of landmarks) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  const cx = ((x0 + x1) / 2) * canvasW;
  const cy = ((y0 + y1) / 2) * canvasH;
  const w = (x1 - x0) * canvasW * cover;
  const h = (y1 - y0) * canvasH * cover;
  return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
}

// 头部倾斜角（弧度）：双眼连线相对水平线的角度（画布 y 向下坐标系）。
// 用「右眼(33) → 左眼(263)」方向（在未镜像图像里指向右），水平时 roll=0。
export function computeFaceRoll(landmarks) {
  if (!landmarks || landmarks.length <= EYE_L_OUTER) return 0;
  const l = landmarks[EYE_L_OUTER];
  const r = landmarks[EYE_R_OUTER];
  if (!l || !r) return 0;
  return Math.atan2(l.y - r.y, l.x - r.x);
}

// 创建人脸追踪控制器。detCanvas/detCtx 为共享小检测画布（与手部追踪同用）。
export async function createFaceTracker({
  wasmUrl, faceModelUrl, canvasW, canvasH, detCanvas, detCtx, drawCover,
}) {
  const fileset = await FilesetResolver.forVisionTasks(wasmUrl);
  const faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: faceModelUrl, delegate: "CPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.4,
    minFacePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });

  let enabled = false;
  let frame = 0;
  let lost = 0;
  let rect = null;
  let roll = 0;

  const controller = {
    enabled: false,
    get lost() { return lost; },
    getRect() { return rect; },
    getRoll() { return roll; },
    setEnabled(on) {
      enabled = on;
      controller.enabled = on;
      if (!on) { rect = null; lost = 0; roll = 0; }
    },
    // 每帧调用；返回 { rect, roll } 或 null（未检测到 / 关闭）。
    tick(liveVideoEl) {
      if (!enabled) return null;
      if (++frame % FACE_EVERY === 0) {
        drawCover(detCtx, liveVideoEl, detCanvas.width, detCanvas.height);
        let res = null;
        try {
          res = faceLandmarker.detectForVideo(detCanvas, performance.now());
        } catch (err) { /* face inference hiccup — keep last rect */ }
        const lm = res && res.faceLandmarks && res.faceLandmarks[0];
        if (lm) {
          rect = computeFaceRect(lm, canvasW, canvasH);
          roll = computeFaceRoll(lm);
          lost = 0;
        } else {
          lost++;
        }
      }
      return rect ? { rect, roll } : null;
    },
  };
  return controller;
}

// 丢脸太久 → 对最后位置打模糊，绝不露真脸。返回是否执行了模糊。
export function blurFaceRegion(ctx, rect, blurPx = 18) {
  if (!rect || rect.w <= 0 || rect.h <= 0) return false;
  const src = ctx.canvas;
  const buf = document.createElement("canvas");
  buf.width = src.width;
  buf.height = src.height;
  const bctx = buf.getContext("2d");
  bctx.drawImage(src, 0, 0);
  ctx.save();
  ctx.filter = `blur(${blurPx}px)`;
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.drawImage(buf, 0, 0);
  ctx.restore();
  ctx.filter = "none";
  return true;
}
