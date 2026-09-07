// head-sticker.js — 贴图头像：把一张「透明背景」的角色头像图盖在真人脸上。
// 图片必须是已经抠好背景的 PNG（换图直接使用，不做任何运行时抠像）。
// 原理：MediaPipe 人脸追踪 → 人脸矩形 → 把头像图缩放到人脸大小 drawImage 到场景画布。

import { createFaceTracker, blurFaceRegion } from "./face-tracker.js";

const FACE_MAX_LOST = 24; // 连续丢脸超过该帧数 → 对最后位置打模糊，绝不露真脸

// 头像图中「头部」占图片的比例 / 中心位置（方形图、头部居中、偏上）。
export const HEAD_W_FRAC = 0.7; // 头部宽度占图片宽度的比例
export const HEAD_CX_FRAC = 0.5; // 头部中心 x（占宽度比例）
export const HEAD_CY_FRAC = 0.45; // 头部中心 y（占高度比例，含头顶发髻）

// 贴图矩形：给定人脸矩形 + 尺寸系数 → 图片画到画布上的 { x, y, w, h }。
export function stickerDrawRect(faceRect, scale) {
  const S = (faceRect.w * scale) / HEAD_W_FRAC;
  return {
    x: faceRect.cx - HEAD_CX_FRAC * S,
    y: faceRect.cy - HEAD_CY_FRAC * S,
    w: S,
    h: S,
    cx: faceRect.cx,
    cy: faceRect.cy,
  };
}

// ============================================================================
// 控制器
// ============================================================================
export async function createHeadSticker({
  wasmUrl, faceModelUrl, imageUrl, liveCtx, canvasW, canvasH,
  detCanvas, detCtx, drawCover,
}) {
  const tracker = await createFaceTracker({
    wasmUrl, faceModelUrl, canvasW, canvasH, detCanvas, detCtx, drawCover,
  });

  // 直接加载头像图（透明 PNG，已抠好背景）。
  const img = await loadImage(imageUrl);

  let enabled = false;
  let scale = 1.0;
  let yOff = -0.45; // 垂直偏移（相对贴图高度，负=上移）
  let lost = 0;
  let lastRect = null;
  let stickerImg = img;

  const controller = {
    enabled: false,
    get scale() { return scale; },
    get yOff() { return yOff; },
    setScale(s) { scale = Math.max(0.5, Math.min(2, s)); },
    setYOff(v) { yOff = Math.max(-0.9, Math.min(0.9, v)); },
    // 换图（用户上传新头像）：直接用上传的图片，不做抠像。
    __setImage(imgEl) { stickerImg = imgEl; },
    setEnabled(on) {
      enabled = on;
      controller.enabled = on;
      tracker.setEnabled(on);
      if (!on) { lost = 0; lastRect = null; }
    },
    tick(liveVideoEl) {
      if (!enabled) return;
      const face = tracker.tick(liveVideoEl);
      if (face) {
        lastRect = face.rect;
        lost = 0;
        drawSticker(liveCtx, stickerImg, face.rect, scale, yOff);
      } else if (lastRect) {
        lost++;
        if (lost >= FACE_MAX_LOST) {
          blurFaceRegion(liveCtx, lastRect);
          lastRect = null;
        } else {
          drawSticker(liveCtx, stickerImg, lastRect, scale, yOff);
        }
      }
    },
    // 录制画布需要带头像但又不想要滤镜/骨架时用：把当前头像画到任意 ctx。
    // face 追踪结果复用 tick() 的 lastRect（不重复追踪），无脸时留空不画。
    drawTo(ctx) {
      if (!enabled) return;
      if (lastRect) drawSticker(ctx, stickerImg, lastRect, scale, yOff);
    },
    // 测试钩子：无摄像头时也能把贴图画到画布指定位置。
    drawTest(rect, roll = 0) {
      lastRect = rect;
      drawSticker(liveCtx, stickerImg, rect, scale, yOff);
      return true;
    },
    dispose() { tracker.setEnabled(false); },
  };
  return controller;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败：" + url));
    img.src = url;
  });
}

// 贴图保持正立、跟随人脸位置。
function drawSticker(ctx, img, faceRect, scale, yOff) {
  const r = stickerDrawRect(faceRect, scale);
  ctx.save();
  ctx.translate(r.cx, r.cy + yOff * r.h);
  ctx.drawImage(img, -HEAD_CX_FRAC * r.w, -HEAD_CY_FRAC * r.h, r.w, r.h);
  ctx.restore();
}
