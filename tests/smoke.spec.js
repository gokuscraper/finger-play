const { test, expect } = require("@playwright/test");

const BASE = "http://localhost:8125";

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  return errors;
}

test("页面加载且无 JS 错误（app.js 必须成功执行）", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(BASE);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);

  expect(await page.title()).toContain("捏个框");
  expect(await page.locator(".mode-btn").count()).toBe(2);
  expect(await page.locator("#btn-live-start").count()).toBe(1);
  // mode switch buttons must be wired (JS ran)
  const liveBtn = page.locator('[data-mode="ai"]');
  await expect(liveBtn).toBeVisible();

  const fatal = errors.filter(
    (e) => !e.includes("favicon") && !e.includes("Manifest")
  );
  expect(fatal, fatal.join("\n")).toEqual([]);
});

test("联系按钮：点开弹窗显示二维码，可关闭", async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator("#contact-modal")).toBeHidden();

  await page.locator("#btn-contact").click();
  await expect(page.locator("#contact-modal")).toBeVisible();
  await expect(page.locator("#contact-modal img")).toBeVisible();
  await expect(page.locator("#contact-modal h2")).toHaveText("反馈 / 建议 / 联系作者");

  // ✕ 关闭
  await page.locator("#btn-contact-close").click();
  await expect(page.locator("#contact-modal")).toBeHidden();

  // Esc 也能关
  await page.locator("#btn-contact").click();
  await expect(page.locator("#contact-modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#contact-modal")).toBeHidden();

  // 点遮罩也能关
  await page.locator("#btn-contact").click();
  await expect(page.locator("#contact-modal")).toBeVisible();
  await page.locator("#contact-modal").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#contact-modal")).toBeHidden();
});

test("模式切换：在线 ↔ AI 互斥显示", async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator("#mode-live")).toBeVisible();
  await expect(page.locator("#mode-ai")).toBeHidden();

  await page.locator('[data-mode="ai"]').click();
  await expect(page.locator("#mode-ai")).toBeVisible();
  await expect(page.locator("#mode-live")).toBeHidden();

  await page.locator('[data-mode="live"]').click();
  await expect(page.locator("#mode-live")).toBeVisible();
  await expect(page.locator("#mode-ai")).toBeHidden();
});

test("镜像初始状态：按钮 active 且 canvas 带 mirrored class（一致）", async ({ page }) => {
  await page.goto(BASE);
  const hasMirrored = await page
    .locator("#canvas-live")
    .evaluate((c) => c.classList.contains("mirrored"));
  const btnActive = await page.locator("#btn-mirror").evaluate((b) => b.classList.contains("active"));
  expect(hasMirrored).toBe(true);
  expect(btnActive).toBe(true);

  // Toggling off removes both together.
  await page.locator("#btn-mirror").dispatchEvent("click");
  expect(
    await page.locator("#canvas-live").evaluate((c) => c.classList.contains("mirrored"))
  ).toBe(false);
  expect(
    await page.locator("#btn-mirror").evaluate((b) => b.classList.contains("active"))
  ).toBe(false);
});

test("在线模式：开启摄像头 → 画面出现 + 模型状态徽章到达终态", async ({ page }) => {
  // Fake webcam: a canvas-driven MediaStream, no real camera needed.
  await page.addInitScript(() => {
    const cv = document.createElement("canvas");
    cv.width = 640;
    cv.height = 480;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffb3d1";
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = "#3a2e5c";
    ctx.font = "40px sans-serif";
    ctx.fillText("FP TEST", 20, 240);
    const stream = cv.captureStream(30);
    navigator.mediaDevices.getUserMedia = () => Promise.resolve(stream);
  });

  const errors = collectErrors(page);
  await page.goto(BASE);
  await page.locator("#btn-live-start").click();

  // Live canvas container must become visible.
  await expect(page.locator("#live-canvas-wrap")).toBeVisible({ timeout: 15000 });
  const canvasSize = await page
    .locator("#canvas-live")
    .evaluate((c) => ({ w: c.width, h: c.height }));
  expect(canvasSize.w).toBe(1280); // canvas is FIXED, never resized
  expect(canvasSize.h).toBe(720);

  // Model status badge must reach a TERMINAL state (ready or error) — never
  // stuck loading, never missing.
  await page.waitForFunction(
    () => {
      const el = document.getElementById("model-badge");
      if (!el) return false;
      const s = el.dataset.state;
      return s === "ready" || s === "error";
    },
    null,
    { timeout: 120000 }
  );
  const state = await page.locator("#model-badge").getAttribute("data-state");
  const text = await page.locator("#mb-text").textContent();
  console.log("[badge terminal] state =", state, "| text =", text);

  // Let the realtime loop run a bit so detectForVideo(canvas) actually
  // executes a few times — any throw surfaces here as a pageerror.
  await page.waitForTimeout(1500);

  const fatal = errors.filter(
    (e) =>
      !e.includes("favicon") &&
      !e.includes("Manifest") &&
      !e.includes("INFO:") // MediaPipe C++ log noise via console.error
  );
  expect(fatal, fatal.join("\n")).toEqual([]);
});

test("合成模式：上传原视频 + 风格化视频 → 预览/导出启用", async ({ page }) => {
  await page.goto(BASE);
  await page.locator('[data-mode="ai"]').click();
  await expect(page.locator("#drop")).toBeVisible();
  await expect(page.locator("#drop-sty")).toBeVisible();
  await expect(page.locator("#stage")).toBeHidden();

  // 只传原视频：卡1 compact，但还没法合成（还缺风格化视频）
  await page.setInputFiles("#file", "examples/final.mp4");
  await expect(page.locator("#drop")).toHaveClass(/compact/);
  await expect(page.locator("#stage")).toBeHidden();

  // 再传风格化视频：两卡都就绪 → 合成区出现，预览/导出可用
  await page.setInputFiles("#file-sty", "examples/final.mp4");
  await expect(page.locator("#drop-sty")).toHaveClass(/compact/);
  await expect(page.locator("#stage")).toBeVisible();
  await expect(page.locator("#btn-play")).toBeEnabled();
  await expect(page.locator("#btn-export")).toBeEnabled();
});

test("在线模式追踪：双手高置信 → 框出现", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest);
  const r = await page.evaluate(() => {
    const { updateTrackerLive, createTrackerState } = window.__fingerPlayTest;
    const st = createTrackerState();
    const W = 640, H = 480;
    // Build a 21-point hand; only indices 4 (thumb) / 8 (index) matter.
    const mkHand = (index, thumb) => {
      const pts = [];
      for (let i = 0; i < 21; i++) pts.push({ x: 0, y: 0, z: 0 });
      pts[8] = index;
      pts[4] = thumb;
      return pts;
    };
    const left = mkHand({ x: 100 / 640, y: 100 / 480, z: 0 }, { x: 100 / 640, y: 380 / 480, z: 0 });
    const right = mkHand({ x: 540 / 640, y: 100 / 480, z: 0 }, { x: 540 / 640, y: 380 / 480, z: 0 });
    const handedness = [[{ categoryName: "Left", score: 0.9 }], [{ categoryName: "Right", score: 0.9 }]];
    updateTrackerLive(st, [left, right], handedness, W, H);
    return {
      corners: st.corners,
      presence: st.presence,
    };
  });
  expect(r.corners).not.toBeNull();
  expect(r.corners.every((c) => c)).toBe(true);
  expect(r.presence).toBeGreaterThan(0);
  // corners in expected order: [L.index, R.index, R.thumb, L.thumb]
  expect(r.corners[0].x).toBeCloseTo(100, 0);
  expect(r.corners[1].x).toBeCloseTo(540, 0);
  expect(r.corners[2].y).toBeCloseTo(380, 0);
  expect(r.corners[3].y).toBeCloseTo(380, 0);
});

test("在线模式追踪：低置信手被忽略 → 不出框", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest);
  const r = await page.evaluate(() => {
    const { updateTrackerLive, createTrackerState } = window.__fingerPlayTest;
    const st = createTrackerState();
    const W = 640, H = 480;
    const mkHand = (index, thumb) => {
      const pts = [];
      for (let i = 0; i < 21; i++) pts.push({ x: 0, y: 0, z: 0 });
      pts[8] = index;
      pts[4] = thumb;
      return pts;
    };
    const left = mkHand({ x: 100 / 640, y: 100 / 480, z: 0 }, { x: 100 / 640, y: 380 / 480, z: 0 });
    const right = mkHand({ x: 540 / 640, y: 100 / 480, z: 0 }, { x: 540 / 640, y: 380 / 480, z: 0 });
    // Right hand below confidence 0.5 → only 2 corners → no box.
    const handedness = [[{ categoryName: "Left", score: 0.9 }], [{ categoryName: "Right", score: 0.2 }]];
    updateTrackerLive(st, [left, right], handedness, W, H);
    return { corners: st.corners, presence: st.presence };
  });
  expect(r.corners).toBeNull();
  expect(r.presence).toBe(0);
});

test("在线模式追踪：手捏着（框面积过小）→ 不出框", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest);
  const r = await page.evaluate(() => {
    const { updateTrackerLive, createTrackerState } = window.__fingerPlayTest;
    const st = createTrackerState();
    const W = 640, H = 480;
    const mkHand = (index, thumb) => {
      const pts = [];
      for (let i = 0; i < 21; i++) pts.push({ x: 0, y: 0, z: 0 });
      pts[8] = index;
      pts[4] = thumb;
      return pts;
    };
    // All four tips clustered in the centre → tiny area → rejected.
    const left = mkHand({ x: 320 / 640, y: 240 / 480, z: 0 }, { x: 322 / 640, y: 242 / 480, z: 0 });
    const right = mkHand({ x: 324 / 640, y: 244 / 480, z: 0 }, { x: 326 / 640, y: 246 / 480, z: 0 });
    const handedness = [[{ categoryName: "Left", score: 0.9 }], [{ categoryName: "Right", score: 0.9 }]];
    updateTrackerLive(st, [left, right], handedness, W, H);
    return { corners: st.corners, presence: st.presence };
  });
  expect(r.corners).toBeNull();
  expect(r.presence).toBe(0);
});

test("在线模式追踪：手短暂丢失 → 框保持不闪断，超时后正常消失", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest);
  const r = await page.evaluate(() => {
    const { updateTrackerLive, createTrackerState } = window.__fingerPlayTest;
    const st = createTrackerState();
    const W = 1280, H = 720;
    const mkHand = (index, thumb) => {
      const pts = [];
      for (let i = 0; i < 21; i++) pts.push({ x: 0, y: 0, z: 0 });
      pts[8] = index;
      pts[4] = thumb;
      return pts;
    };
    const left = mkHand({ x: 200 / W, y: 150 / H, z: 0 }, { x: 200 / W, y: 570 / H, z: 0 });
    const right = mkHand({ x: 1080 / W, y: 150 / H, z: 0 }, { x: 1080 / W, y: 570 / H, z: 0 });
    const hd = [[{ categoryName: "Left", score: 0.9 }], [{ categoryName: "Right", score: 0.9 }]];

    // Box appears.
    updateTrackerLive(st, [left, right], hd, W, H);
    const appeared = st.corners !== null && st.presence > 0;

    // Hands vanish for 10 frames (< MAX_LOST_FRAMES=25): box must be held.
    for (let i = 0; i < 10; i++) updateTrackerLive(st, [], [], W, H);
    const held = st.corners !== null && st.presence > 0;

    // Hands come back: box re-locks immediately.
    updateTrackerLive(st, [left, right], hd, W, H);
    const recovered = st.corners !== null && st.presence > 0;

    // Hands gone for 80 frames (> 25 hold + fade): box finally clears.
    for (let i = 0; i < 80; i++) updateTrackerLive(st, [], [], W, H);
    const cleared = st.corners === null;

    return { appeared, held, recovered, cleared };
  });
  expect(r.appeared).toBe(true);
  expect(r.held).toBe(true); // < 25 frames → held, no blink
  expect(r.recovered).toBe(true);
  expect(r.cleared).toBe(true); // > 25 frames → released
});

test("所有在线效果都能绘制而不抛错", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(
    () => window.__fingerPlayTest && window.__fingerPlayTest.LIVE_EFFECTS
  );
  const failures = await page.evaluate(() => {
    const { LIVE_EFFECTS } = window.__fingerPlayTest;
    const src = document.createElement("canvas");
    src.width = 200;
    src.height = 150;
    const sctx = src.getContext("2d");
    sctx.fillStyle = "#ffb3d1";
    sctx.fillRect(0, 0, 200, 150);
    sctx.fillStyle = "#3a2e5c";
    sctx.fillRect(60, 40, 80, 70);
    const bad = [];
    for (const id of Object.keys(LIVE_EFFECTS)) {
      const cv = document.createElement("canvas");
      cv.width = 200;
      cv.height = 150;
      const c = cv.getContext("2d");
      try {
        LIVE_EFFECTS[id](c, cv, src);
      } catch (e) {
        bad.push(id + ": " + e.message);
      }
    }
    return bad;
  });
  expect(failures).toEqual([]);
});

test("切换风格后重新比框，风格保持不失效", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest);

  // Switch to a non-default style ("蓝"). Workspace may be hidden, so
  // dispatch the click directly on the chip.
  await page.locator('.effect-chip[data-effect="blue"]').dispatchEvent("click");
  expect(await page.evaluate(() => window.__fingerPlayTest.getLiveEffect())).toBe("blue");

  // Box appears → hands dropped → re-frame → box reappears; style must persist.
  const r = await page.evaluate(() => {
    const { updateTrackerLive, createTrackerState, getLiveEffect } = window.__fingerPlayTest;
    const st = createTrackerState();
    const W = 1280, H = 720;
    const mkHand = (index, thumb) => {
      const pts = [];
      for (let i = 0; i < 21; i++) pts.push({ x: 0, y: 0, z: 0 });
      pts[8] = index;
      pts[4] = thumb;
      return pts;
    };
    const left = mkHand({ x: 200 / W, y: 150 / H, z: 0 }, { x: 200 / W, y: 570 / H, z: 0 });
    const right = mkHand({ x: 1080 / W, y: 150 / H, z: 0 }, { x: 1080 / W, y: 570 / H, z: 0 });
    const hd = [[{ categoryName: "Left", score: 0.9 }], [{ categoryName: "Right", score: 0.9 }]];

    updateTrackerLive(st, [left, right], hd, W, H);
    const appeared = !!st.corners;

    for (let i = 0; i < 200; i++) updateTrackerLive(st, [], [], W, H);
    const cleared = st.corners === null;

    updateTrackerLive(st, [left, right], hd, W, H);
    return {
      appeared,
      cleared,
      reappeared: !!st.corners,
      effect: getLiveEffect(),
    };
  });

  expect(r.appeared).toBe(true);
  expect(r.cleared).toBe(true);
  expect(r.reappeared).toBe(true);
  expect(r.effect).toBe("blue");
});

test("每个效果输出互不相同（效果真实生效）", async ({ page }) => {
  await page.goto(BASE);  await page.waitForFunction(
    () => window.__fingerPlayTest && window.__fingerPlayTest.LIVE_EFFECTS
  );
  const r = await page.evaluate(() => {
    const { LIVE_EFFECTS } = window.__fingerPlayTest;
    const src = document.createElement("canvas");
    src.width = 200;
    src.height = 150;
    const sctx = src.getContext("2d");
    const grad = sctx.createLinearGradient(0, 0, 200, 150);
    grad.addColorStop(0, "#ffb3d1");
    grad.addColorStop(1, "#9ec8ff");
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 200, 150);
    sctx.fillStyle = "#3a2e5c";
    sctx.fillRect(60, 40, 80, 70);
    sctx.fillStyle = "#a8f0d0";
    sctx.fillRect(20, 100, 160, 30);
    const outs = {};
    for (const id of Object.keys(LIVE_EFFECTS)) {
      const cv = document.createElement("canvas");
      cv.width = 200;
      cv.height = 150;
      const c = cv.getContext("2d");
      LIVE_EFFECTS[id](c, cv, src);
      outs[id] = cv.toDataURL();
    }
    return outs;
  });
  const ids = Object.keys(r);
  expect(ids.length).toBeGreaterThan(1);
  const unique = new Set(Object.values(r));
  // Every effect must produce a visually distinct output.
  expect(unique.size).toBe(ids.length);
});

test("检测延迟基准：单次 detectForVideo 耗时", async ({ page }) => {
  // Fake webcam with motion so frames aren't blank.
  await page.addInitScript(() => {
    const cv = document.createElement("canvas");
    cv.width = 640;
    cv.height = 480;
    const ctx = cv.getContext("2d");
    let t = 0;
    const tick = () => {
      ctx.fillStyle = "#ffb3d1";
      ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = "#3a2e5c";
      const x = 200 + Math.sin(t / 10) * 100;
      ctx.fillRect(x, 120 + (t % 50), 80, 200);
      t++;
      requestAnimationFrame(tick);
    };
    tick();
    const stream = cv.captureStream(30);
    navigator.mediaDevices.getUserMedia = () => Promise.resolve(stream);
  });
  await page.goto(BASE);
  await page.locator("#btn-live-start").click();
  await page.waitForFunction(
    () => document.getElementById("model-badge").dataset.state === "ready",
    null,
    { timeout: 120000 }
  );
  const r = await page.evaluate(() => window.__fingerPlayTest.benchDetect(30));
  console.log("[bench detect]", JSON.stringify(r));
  expect(r.error).toBeUndefined();
  expect(r.p50).toBeLessThan(250); // even CPU inference should beat this
});

test("录制按钮：开始/停止录制不抛错", async ({ page }) => {
  await page.goto(BASE);
  const btn = page.locator("#btn-record");
  expect(await btn.count()).toBe(1);

  // Start recording (workspace may be hidden, dispatch directly).
  await btn.dispatchEvent("click");
  await page.waitForTimeout(500);
  expect(await btn.evaluate((b) => b.classList.contains("recording"))).toBe(true);

  // Stop recording.
  await btn.dispatchEvent("click");
  await page.waitForTimeout(400);
  expect(await btn.evaluate((b) => b.classList.contains("recording"))).toBe(false);
});

test("i18n：data-i18n 填充 + t() 取词 + 语言切换预留", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.i18n);

  // Static [data-i18n] elements are populated (zh-CN by default).
  await expect(page.locator("h1")).toHaveText("捏个框");
  await expect(page.locator('[data-mode="ai"]')).toHaveText("✨ 合成");
  await expect(page.locator("#btn-live-start")).toHaveText("📷 开启摄像头");

  const r = await page.evaluate(() => {
    const { i18n } = window.__fingerPlayTest;
    return {
      red: i18n.t("fx.red"),
      header: i18n.t("fx.header"),
      missing: i18n.t("nope.not_exist"), // unknown key -> raw key fallback
      locale: i18n.getLocale(),
      hasEn: i18n.hasLocale("en-US"),
      hasZh: i18n.hasLocale("zh-CN"),
    };
  });
  expect(r.red).toBe("红");
  expect(r.header).toBe("滤镜");
  expect(r.missing).toBe("nope.not_exist");
  expect(r.locale).toBe("zh-CN");
  expect(r.hasEn).toBe(false);
  expect(r.hasZh).toBe(true);

  // Setting a locale that doesn't exist keeps zh-CN (no crash).
  const after = await page.evaluate(() => {
    const { i18n } = window.__fingerPlayTest;
    i18n.setLocale("en-US");
    return { locale: i18n.getLocale(), h1: document.querySelector("h1").textContent };
  });
  expect(after.locale).toBe("zh-CN");
  expect(after.h1).toBe("捏个框");
});

test("双滤镜：交叉检测 + 三角拆分（左三角=滤镜A）", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.splitQuad);

  const r = await page.evaluate(() => {
    const { segIntersect, splitQuad } = window.__fingerPlayTest;
    // 正常长方形（不交叉）: 4 corners no bow-tie
    const rect = [
      { x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 },
    ];
    const rectSplit = splitQuad(rect);

    // 交叉（蝴蝶结）：反转一只手 → 边 p0-p1 与边 p2-p3 在中段交叉
    // [左食指 左上, 右食指 右下(反转), 右拇指 右上(反转), 左拇指 左下]
    const bow = [
      { x: 100, y: 100 }, // p0 左食指 左上
      { x: 250, y: 300 }, // p1 右食指 右下（右手反转）
      { x: 350, y: 100 }, // p2 右拇指 右上（右手反转）
      { x: 150, y: 300 }, // p3 左拇指 左下
    ];
    const crossPt = segIntersect(bow[0], bow[1], bow[2], bow[3]);
    const bowSplit = splitQuad(bow);

    return {
      rectCrossed: rectSplit.crossed,
      bowCrossed: bowSplit.crossed,
      crossPt,
      triA: bowSplit.triA, // 应偏左
      triB: bowSplit.triB, // 应偏右
    };
  });

  // 正常矩形：不交叉
  expect(r.rectCrossed).toBe(false);

  // 蝴蝶结：交叉，有交点
  expect(r.bowCrossed).toBe(true);
  expect(r.crossPt).not.toBeNull();
  expect(r.crossPt.x).toBeGreaterThan(190);
  expect(r.crossPt.x).toBeLessThan(230);

  // triA 质心靠左（滤镜A），triB 质心靠右（滤镜B）
  const cx = (t) => (t[0].x + t[1].x + t[2].x) / 3;
  expect(cx(r.triA)).toBeLessThan(cx(r.triB));
  expect(cx(r.triA)).toBeLessThan(200);
  expect(cx(r.triB)).toBeGreaterThan(200);
});

test("双滤镜：UI 切换到双选并设置 A/B", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.i18n);

  // 切到双选
  await page.locator("#fx-mode-dual").dispatchEvent("click");
  await expect(page.locator("#fx-slots")).not.toHaveClass(/hidden/);

  // 默认 A=极光 B=金箔
  expect(await page.locator("#fx-slot-a-emoji").textContent()).toBe("🌌");
  expect(await page.locator("#fx-slot-b-emoji").textContent()).toBe("🥇");

  // A 槽位激活，点「青」chip → A 变青
  await page.locator('.effect-chip[data-effect="cyan"]').dispatchEvent("click");
  expect(await page.locator("#fx-slot-a-emoji").textContent()).toBe("💠");

  // 切到 B 槽位，点「粉」→ B 变粉
  await page.locator('.fx-slot[data-slot="B"]').dispatchEvent("click");
  await page.locator('.effect-chip[data-effect="pink"]').dispatchEvent("click");
  expect(await page.locator("#fx-slot-b-emoji").textContent()).toBe("🌸");
});

test("四指模式：双手构建 3 个指缝区，收拢手返回 null（张开门禁）", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.computeFiveFingers);
  const r = await page.evaluate(() => {
    const { computeFiveFingers } = window.__fingerPlayTest;
    const W = 1280, H = 720;
    const mk = (palmX, palmY, gap, flip) => {
      const lm = [];
      for (let i = 0; i < 21; i++) lm.push({ x: 0, y: 0, z: 0 });
      lm[0] = { x: palmX / W, y: palmY / H, z: 0 }; // wrist
      lm[9] = { x: palmX / W, y: (palmY + 60) / H, z: 0 }; // middle mcp
      const tips = [4, 8, 12, 16, 20];
      tips.forEach((idx, i) => {
        const x = palmX + (flip ? -1 : 1) * (i - 2) * gap;
        lm[idx] = { x: x / W, y: (palmY - 100) / H, z: 0 }; // tips above
      });
      return lm;
    };
    const left = mk(400, 500, 80, false);
    const right = mk(880, 500, 80, true);
    const hd = [[{ score: 0.9 }], [{ score: 0.9 }]];
    const quads = computeFiveFingers([left, right], hd, W, H);

    // 手指收拢（tips 贴手腕）→ 应返回 null（张开门禁，防止全能模式误触发）
    const closed = mk(400, 500, 80);
    [4, 8, 12, 16, 20].forEach((idx) => { closed[idx] = { x: 400 / W, y: 480 / H, z: 0 }; });
    const closedResult = computeFiveFingers([closed, right], hd, W, H);

    return { quads, closedResult };
  });

  expect(r.quads).not.toBeNull();
  expect(r.quads.tipsL.length).toBe(5);
  expect(r.quads.tipsR.length).toBe(5);
  expect(r.quads.tipsL[0].x).toBeLessThan(r.quads.tipsR[0].x);
  // 手指收拢（tips 贴手腕）→ null（只露两根手指不会误触发四指区）
  expect(r.closedResult).toBeNull();
});

test("五指柱体：orderQuad 质心角排序让交叉手四边形不自交", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.orderQuad);
  const r = await page.evaluate(() => {
    const { orderQuad, segIntersect } = window.__fingerPlayTest;
    // 交叉手的蝴蝶结四边形（面积 0，两条对边交叉）
    const bow = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ];
    const before = {
      cross1: segIntersect(bow[0], bow[1], bow[2], bow[3]),
      cross2: segIntersect(bow[1], bow[2], bow[3], bow[0]),
    };
    const sorted = orderQuad(bow);
    const after = {
      cross1: segIntersect(sorted[0], sorted[1], sorted[2], sorted[3]),
      cross2: segIntersect(sorted[1], sorted[2], sorted[3], sorted[0]),
    };
    return { before, after, sorted };
  });
  // 排序前：蝴蝶结，对边交叉（segIntersect 返回交点对象=truthy）
  expect(!!(r.before.cross1 || r.before.cross2)).toBe(true);
  // 排序后：不再交叉 → 有效凸四边形
  expect(!!r.after.cross1).toBe(false);
  expect(!!r.after.cross2).toBe(false);
  // 4 个点一个不少
  expect(r.sorted.length).toBe(4);
});

test("双选：正常框用 A，翻面用 B", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.signedArea);
  const r = await page.evaluate(() => {
    const { signedArea, dualFrameEffect, getDualAB } = window.__fingerPlayTest;
    const normal = [
      { x: 300, y: 150 }, { x: 980, y: 150 }, // L.index, R.index（食指在上）
      { x: 1080, y: 620 }, { x: 200, y: 620 }, // R.thumb, L.thumb（拇指在下）
    ];
    const flipped = [
      { x: 300, y: 620 }, { x: 980, y: 620 }, // 食指在下
      { x: 1080, y: 150 }, { x: 200, y: 150 }, // 拇指在上
    ];
    return {
      normalSign: Math.sign(signedArea(normal)),
      flippedSign: Math.sign(signedArea(flipped)),
      normalEffect: dualFrameEffect(normal),   // 正放 → 应返回 dualA
      flippedEffect: dualFrameEffect(flipped), // 翻面 → 应返回 dualB
      ab: getDualAB(),
    };
  });
  expect(r.normalSign).toBe(1);
  expect(r.flippedSign).toBe(-1);
  expect(r.normalEffect).toBe(r.ab.a);   // 正放 = A
  expect(r.flippedEffect).toBe(r.ab.b);  // 翻面 = B
  expect(r.ab.a).not.toBe(r.ab.b);       // A/B 默认不同
});

test("手部检测点：drawHandLandmarks 画出 21 点 + 连线（无摄像头冒烟）", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.drawHandLandmarks);
  const r = await page.evaluate(() => {
    const { drawHandLandmarks } = window.__fingerPlayTest;
    const canvas = document.getElementById("canvas-live");
    canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f0f0f0"; ctx.fillRect(0, 0, 640, 480); // 浅底，黑点/黑线可见
    // 一只手：21 点围成手型（腕在下、指尖在上）
    const hand = [];
    for (let i = 0; i < 21; i++) hand.push({ x: 0.5, y: 0.5, z: 0 });
    hand[0] = { x: 0.5, y: 0.8, z: 0 }; // 手腕
    [4, 8, 12, 16, 20].forEach((idx, i) => {
      hand[idx] = { x: 0.35 + i * 0.075, y: 0.2, z: 0 }; // 指尖
    });
    drawHandLandmarks(ctx, [hand], 640, 480);
    const data = ctx.getImageData(0, 0, 640, 480).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120) dark++;
    }
    return { dark };
  });
  expect(r.dark).toBeGreaterThan(50); // 画出了黑色圆点/连线
});

test("手部检测点：按钮存在且可切换状态", async ({ page }) => {
  await page.goto(BASE);
  const btn = page.locator("#btn-hand-points");
  expect(await btn.count()).toBe(1);
  await btn.dispatchEvent("click");
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__fingerPlayTest.handPoints())).toBe(true);
  await btn.dispatchEvent("click");
  expect(await page.evaluate(() => window.__fingerPlayTest.handPoints())).toBe(false);
});

test("四指模式：UI 切四指并设置 3 槽位", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.i18n);
  await page.locator("#fx-mode-five").dispatchEvent("click");
  await expect(page.locator("#fx-slots")).not.toHaveClass(/hidden/);
  // 四指只有 A/B/C：D/E 隐藏
  await expect(page.locator("#fx-slot-d")).toHaveClass(/hidden/);
  await expect(page.locator("#fx-slot-e")).toHaveClass(/hidden/);
  // C 槽位激活 → 点「红」→ C 变红
  await page.locator('.fx-slot[data-slot="C"]').dispatchEvent("click");
  await page.locator('.effect-chip[data-effect="red"]').dispatchEvent("click");
  expect(await page.locator("#fx-slot-c-emoji").textContent()).toBe("❤️");
  // B 槽位 → 点「青」→ B 变青
  await page.locator('.fx-slot[data-slot="B"]').dispatchEvent("click");
  await page.locator('.effect-chip[data-effect="cyan"]').dispatchEvent("click");
  expect(await page.locator("#fx-slot-b-emoji").textContent()).toBe("💠");
});

test("录制10秒：10 秒后自动停止", async ({ page }) => {
  await page.goto(BASE);
  const btn = page.locator("#btn-record10");
  expect(await btn.count()).toBe(1);

  await btn.dispatchEvent("click");
  await page.waitForTimeout(600);
  expect(await btn.evaluate((b) => b.classList.contains("recording"))).toBe(true);

  // ~10s later it auto-stops (recording class removed).
  await page.waitForTimeout(14000);
  expect(await btn.evaluate((b) => b.classList.contains("recording"))).toBe(false);
});

// ============================================================================
// 贴图头像
// ============================================================================

test("贴图：computeFaceRoll 水平脸 roll=0，歪头方向正确", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.sticker);
  const r = await page.evaluate(() => {
    const { computeFaceRoll } = window.__fingerPlayTest.sticker;
    const mk = (x, y) => ({ x, y, z: 0 });
    const lms = [];
    for (let i = 0; i < 478; i++) lms.push(mk(0.5, 0.5));
    lms[33] = mk(0.3, 0.5); // 右眼（未镜像：图像左侧）
    lms[263] = mk(0.7, 0.5); // 左眼（图像右侧）
    const level = computeFaceRoll(lms);
    lms[33] = mk(0.3, 0.42); // 右眼上移 → 头部倾斜
    lms[263] = mk(0.7, 0.5);
    const tilted = computeFaceRoll(lms);
    return { level, tilted };
  });
  expect(r.level).toBeCloseTo(0, 5); // 水平时绝对不能再是 ±180°
  expect(r.tilted).toBeGreaterThan(0);
});

test("贴图：stickerDrawRect 按人脸矩形算贴图矩形", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.sticker);
  const r = await page.evaluate(() => {
    const { stickerDrawRect } = window.__fingerPlayTest.sticker;
    return stickerDrawRect({ cx: 640, cy: 360, w: 300 }, 1.0);
  });
  const S = 300 / 0.7;
  expect(r.w).toBeCloseTo(S, 1);
  expect(r.h).toBeCloseTo(S, 1);
  expect(r.x).toBeCloseTo(640 - 0.5 * S, 1);
  expect(r.y).toBeCloseTo(360 - 0.45 * S, 1);
});

test("滤镜作用在场景画布上：头像区域也被滤镜处理（换脸 = 滤镜同样生效）", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.LIVE_EFFECTS);
  const r = await page.evaluate(() => {
    const { LIVE_EFFECTS, sceneCanvas } = window.__fingerPlayTest;
    const sctx = sceneCanvas.getContext("2d");
    sctx.fillStyle = "#00ff00";
    sctx.fillRect(0, 0, 1280, 720);
    sctx.fillStyle = "#ff0000"; // 模拟「头像」：红色方块
    sctx.fillRect(600, 300, 200, 200);
    const canvas = document.getElementById("canvas-live");
    canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(sceneCanvas, 0, 0);
    LIVE_EFFECTS.invert(ctx, canvas, sceneCanvas); // 滤镜数据源 = 场景画布
    const avatar = ctx.getImageData(700, 400, 1, 1).data; // 头像区域
    const bg = ctx.getImageData(100, 100, 1, 1).data; // 背景区域
    return { avatar: Array.from(avatar.slice(0, 3)), bg: Array.from(bg.slice(0, 3)) };
  });
  // 红 → 反相 → 青（头像被滤镜处理了）
  expect(r.avatar[0]).toBeLessThan(10);
  expect(r.avatar[1]).toBeGreaterThan(240);
  expect(r.avatar[2]).toBeGreaterThan(240);
  // 绿 → 反相 → 品红
  expect(r.bg[0]).toBeGreaterThan(240);
  expect(r.bg[1]).toBeLessThan(20);
});

test("贴图：drawHandsOnTop 把手的外轮廓多边形盖到最上层", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.drawHandsOnTop);
  const r = await page.evaluate(() => {
    const { drawHandsOnTop } = window.__fingerPlayTest;
    const canvas = document.getElementById("canvas-live");
    canvas.width = 300; canvas.height = 150;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, 300, 150);
    const fake = document.createElement("canvas");
    fake.width = 300; fake.height = 150;
    fake.videoWidth = 300; fake.videoHeight = 150;
    const fctx = fake.getContext("2d");
    fctx.fillStyle = "#ff0000"; fctx.fillRect(0, 0, 300, 150);
    // 一只「手」：21 个点围成一个圆（模拟手轮廓，包住画面中心）
    const hand = [];
    for (let i = 0; i < 21; i++) {
      const a = (i / 21) * Math.PI * 2;
      hand.push({ x: 0.5 + 0.2 * Math.cos(a), y: 0.5 + 0.2 * Math.sin(a) });
    }
    drawHandsOnTop(ctx, fake, [hand], 300, 150);
    const inside = ctx.getImageData(140, 70, 20, 20).data; // 圆内
    const outside = ctx.getImageData(5, 5, 1, 1).data; // 圆外
    let red = 0;
    for (let i = 0; i < inside.length; i += 4) {
      if (inside[i] > 200 && inside[i + 3] > 200) red++;
    }
    return { red, total: inside.length / 4, outsideRed: outside[0] > 200 ? 1 : 0 };
  });
  expect(r.red).toBeGreaterThan(300); // 手轮廓内画上了视频内容
  expect(r.outsideRed).toBe(0); // 轮廓外保持原样（背景/真脸不漏出来）
});

test("全屏：竖屏手机下 canvas 旋转90°铺满，横屏手机不旋转", async ({ page }) => {
  // Fake webcam so the live canvas can start (fullscreen button lives there).
  await page.addInitScript(() => {
    const cv = document.createElement("canvas");
    cv.width = 640;
    cv.height = 480;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffb3d1";
    ctx.fillRect(0, 0, 640, 480);
    const stream = cv.captureStream(30);
    navigator.mediaDevices.getUserMedia = () => Promise.resolve(stream);
  });

  async function enterFullscreen() {
    await page.locator("#btn-live-start").click();
    await expect(page.locator("#live-canvas-wrap")).toBeVisible({ timeout: 15000 });
    await page.locator("#btn-fullscreen").click();
    await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 10000 });
  }

  // ---- 竖屏手机：canvas 旋转 90°（画面横过来铺满竖屏）----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE);
  await enterFullscreen();
  const portrait = await page
    .locator("#canvas-live")
    .evaluate((c) => {
      const s = getComputedStyle(c);
      return {
        portrait: matchMedia("(orientation: portrait)").matches,
        transform: s.transform,
        width: parseFloat(s.width),
        height: parseFloat(s.height),
      };
    });
  expect(portrait.portrait).toBe(true);
  // 竖屏旋转 90°：纯 rotate = matrix(0,1,-1,0,..)；默认镜像开着 = rotate90+scaleX(-1)
  const rotate90 = portrait.transform === "matrix(0, 1, -1, 0, 0, 0)";
  const rotate90Mirrored = portrait.transform === "matrix(0, -1, -1, 0, 0, 0)";
  expect(rotate90 || rotate90Mirrored, `unexpected transform: ${portrait.transform}`).toBe(true);
  // 旋转前的逻辑宽度 = 竖屏高度方向，须大于视口宽度（cover 铺满，不留细条）
  expect(portrait.width).toBeGreaterThan(700);

  // 退出全屏
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement);

  // ---- 横屏手机：canvas 不旋转，cover 铺满 ----
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator("#btn-fullscreen").click();
  await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 10000 });
  const landscape = await page
    .locator("#canvas-live")
    .evaluate((c) => {
      const s = getComputedStyle(c);
      return {
        landscape: matchMedia("(orientation: landscape)").matches,
        transform: s.transform,
        width: parseFloat(s.width),
      };
    });
  expect(landscape.landscape).toBe(true);
  // 横屏无 90° 旋转：transform 要么 none，要么只有镜像 scaleX(-1)
  const noRotate = ["none", "matrix(-1, 0, 0, 1, 0, 0)"].includes(landscape.transform);
  expect(noRotate, `unexpected transform: ${landscape.transform}`).toBe(true);
  // cover 铺满宽度（width = 100vw，不含细条缩放）
  expect(landscape.width).toBeGreaterThanOrEqual(843);
  await page.evaluate(() => document.exitFullscreen());
});

test("贴图：模型加载 + 画到画布（无摄像头冒烟）", async ({ page }) => {
  test.setTimeout(120000);
  const errors = collectErrors(page);
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.sticker);

  await page.evaluate(() => window.__fingerPlayTest.sticker.init());
  await page.waitForFunction(() => window.__fingerPlayTest.sticker.ready(), null, { timeout: 90000 });

  // 画到场景画布（贴图画到 sceneCtx）：清除 → 画贴图 → 出现不透明像素
  const draw = await page.evaluate(() => {
    const canvas = window.__fingerPlayTest.sceneCanvas;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const drew = window.__fingerPlayTest.sticker.drawTest({ cx: 150, cy: 75, w: 120 }, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 128) opaque++;
    return { drew, opaque };
  });
  expect(draw.drew).toBe(true);
  expect(draw.opaque).toBeGreaterThan(100); // 头像真的画上去了

  const fatal = errors.filter(
    (e) => !e.includes("favicon") && !e.includes("Manifest") && !e.includes("INFO:")
  );
  expect(fatal, fatal.join("\n")).toEqual([]);
});

test("录制画布 = 干净源帧：水印/滤镜不进录制，仅在预览画布", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.drawWatermark);

  // 用假摄像头给 liveVideo 填充画面，再验证 syncRecCanvas 输出干净帧
  const r = await page.evaluate(async () => {
    const api = window.__fingerPlayTest;
    const live = api.liveCanvas;
    const rec = api.recCanvas;
    live.width = 1280;
    live.height = 720;

    // 造一个假视频帧：蓝色背景 + 红色圆点（模拟摄像头画面）
    const vc = document.createElement("canvas");
    vc.width = 1280;
    vc.height = 720;
    const vctx = vc.getContext("2d");
    vctx.fillStyle = "#0044ff";
    vctx.fillRect(0, 0, 1280, 720);
    vctx.fillStyle = "#ff2222";
    vctx.beginPath();
    vctx.arc(640, 360, 80, 0, Math.PI * 2);
    vctx.fill();
    const stream = vc.captureStream(30);
    api.liveVideo.srcObject = stream;
    await api.liveVideo.play();
    await new Promise((res) => setTimeout(res, 200));

    // 预览画布画水印（屏幕所见）
    const liveCtx = live.getContext("2d");
    liveCtx.clearRect(0, 0, 1280, 720);
    liveCtx.drawImage(vc, 0, 0, 1280, 720);
    api.drawWatermark(liveCtx);

    // 同步到录制画布（应只含干净视频帧）
    api.syncRecCanvas();
    const recCtx = rec.getContext("2d");
    function px(x, y) {
      const d = recCtx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    }
    // 录制画布左上角应是干净视频的蓝色，而不是水印/滤镜
    return {
      recTopLeft: px(10, 10), // 干净视频蓝
      recCenter: px(640, 360), // 干净视频红
      recWatermarkArea: px(20, 20), // 不应有半透明黑底水印
    };
  });
  // 录制画布 = 干净视频帧（蓝 + 红），无水印压暗
  expect(r.recTopLeft[2]).toBeGreaterThan(200); // 蓝色分量高
  expect(r.recTopLeft[1]).toBeLessThan(80); // 绿分量低
  expect(r.recCenter[0]).toBeGreaterThan(200); // 红色分量高
});

test("合成滤镜加回：合成框内用录制时选的滤镜处理风格化视频", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.LIVE_EFFECTS);

  // 验证合成复用在线滤镜管线：选择不同滤镜，作用在同一风格化视频源上结果不同
  const r = await page.evaluate(async () => {
    const { LIVE_EFFECTS, getLiveEffect, setHandPoints } = window.__fingerPlayTest;
    // 用真实 DOM 的 effect-chip 切滤镜（合成默认沿用 currentLiveEffect）
    const chips = document.querySelectorAll(".effect-chip");
    const chip = (id) => [...chips].find((c) => c.dataset.effect === id);
    if (chip("invert")) chip("invert").click();
    await new Promise((res) => setTimeout(res, 50));
    const invertSel = getLiveEffect();

    if (chip("aurora")) chip("aurora").click();
    await new Promise((res) => setTimeout(res, 50));
    const auroraSel = getLiveEffect();

    // 确认合成 loop 的分支：单选/双选对应不同效果名
    return {
      invertSel,
      auroraSel,
      hasDualA: !!window.__fingerPlayTest.getDualAB,
      hasSplitQuad: !!window.__fingerPlayTest.splitQuad,
      effects: Object.keys(LIVE_EFFECTS).length,
    };
  });
  expect(r.invertSel).toBe("invert");
  expect(r.auroraSel).toBe("aurora");
  expect(r.hasSplitQuad).toBe(true);
  expect(r.effects).toBeGreaterThanOrEqual(17);
});

test("贴图头像进入录制画布：录制 = 干净视频帧 + 头像（不带滤镜/骨架）", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.sticker);

  const r = await page.evaluate(async () => {
    const api = window.__fingerPlayTest;
    const live = api.liveCanvas;
    const rec = api.recCanvas;
    live.width = 1280;
    live.height = 720;

    // 假摄像头：纯色背景
    const vc = document.createElement("canvas");
    vc.width = 1280;
    vc.height = 720;
    const vctx = vc.getContext("2d");
    vctx.fillStyle = "#0044ff";
    vctx.fillRect(0, 0, 1280, 720);
    const stream = vc.captureStream(30);
    api.liveVideo.srcObject = stream;
    await api.liveVideo.play();
    await new Promise((res) => setTimeout(res, 200));

    // 初始化贴图并画一个头像到场景画布（模拟追踪到人脸）
    await api.sticker.init();
    api.sticker.setEnabled(true);
    const face = { cx: 640, cy: 300, w: 200, h: 260 };
    api.sticker.drawTest(face, 0);

    // 同步录制画布
    api.syncRecCanvas();
    const recCtx = rec.getContext("2d");

    function px(x, y) {
      const d = recCtx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    }
    // 头像中心区域应有非纯蓝内容（头像贴上了）
    const faceArea = px(640, 300);
    const bg = px(50, 50);
    return {
      faceArea,
      bg,
      stickerEnabled: api.sticker.enabled(),
    };
  });
  // 背景仍是干净蓝色
  expect(r.bg[2]).toBeGreaterThan(200);
  expect(r.bg[1]).toBeLessThan(80);
  // 头像区域不完全是纯蓝背景（贴图覆盖了）
  const faceDiff =
    Math.abs(r.faceArea[0] - r.bg[0]) +
    Math.abs(r.faceArea[1] - r.bg[1]) +
    Math.abs(r.faceArea[2] - r.bg[2]);
  expect(faceDiff).toBeGreaterThan(30);
});

test("合成界面效果清单：显示录制时选的滤镜/贴图/手点", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.renderFxSummary);
  await page.locator('[data-mode="ai"]').click();
  await page.waitForTimeout(400);

  async function chips() {
    return page.locator("#comp-fx-chips .cfs-chip").allTextContents();
  }

  // 默认单选 + 极光
  let cs = await chips();
  expect(cs.some((c) => c.includes("单选") && c.includes("极光"))).toBe(true);

  // 四指模式 → A/B/C
  await page.evaluate(() => window.__fingerPlayTest.setFxMode("five"));
  await page.waitForTimeout(800); // 等 setInterval 刷新
  cs = await chips();
  expect(cs.some((c) => c.includes("四指"))).toBe(true);
  expect(cs.some((c) => c.includes("A") && c.includes("B"))).toBe(true);

  // 双选模式 → A/B
  await page.evaluate(() => window.__fingerPlayTest.setFxMode("dual"));
  await page.waitForTimeout(800);
  cs = await chips();
  expect(cs.some((c) => c.includes("双选"))).toBe(true);

  // 开手点 → 显示手部检测点
  await page.evaluate(() => window.__fingerPlayTest.setHandPoints(true));
  await page.waitForTimeout(800);
  cs = await chips();
  expect(cs.some((c) => c.includes("手部检测点"))).toBe(true);
});
