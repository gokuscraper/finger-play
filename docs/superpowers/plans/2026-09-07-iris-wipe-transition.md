# 合成模式光圈转场（iris wipe）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 合成模式在视频中点切换画面时，用「从手指框中心向四周扩散的光圈」替代生硬硬切：新画面（框内=原视频、框外=风格化）从一个扩大的圆中逐渐揭示。

**Architecture:** 复用现有 `loop()` 渲染管线，把框内滤镜渲染抽成 `renderComposeFrame(c, frame, cv, W, H)`；切换瞬间用离屏 canvas 渲染「新画面」图层，用 `destination-in` 径向渐变做羽化，再以 `ctx.clip()` 圆形遮罩 + `drawImage` 合成到主画布。扩散半径按 `easeOutCubic` 缓动从 0 增长到覆盖全屏。圆圈中心取手指框四角质心（无框时回退屏幕中心）。

**Tech Stack:** 原生 Canvas 2D（`clip`、`globalCompositeOperation=destination-in`、`createRadialGradient`、离屏 `canvas`），无新依赖。

## Global Constraints

- 仅修改 `app.js`、`tests/smoke.spec.js`，不新增文件（离屏 canvas 用模块级 `document.createElement("canvas")`）
- 复用现有 `composeFxPlan` / `drawWindow` / `renderPillar` / `drawOutline` 渲染管线，不重复造滤镜
- 切换时长常量 `SWAP_DURATION = 0.9`（秒），缓动 `1-(1-t)^3`（easeOutCubic）
- 所有新逻辑必须在 `window.__fingerPlayTest` 暴露纯函数，测试沿用现有 Playwright + `page.evaluate` 风格
- 提交信息沿用仓库中文风格
- 开关 `swapCompose`（合成面板勾选，默认开）关闭时行为与现状完全一致（硬切）

---

### Task 1: 纯函数（扩散进度 / 质心 / 覆盖半径）+ 测试

**Files:**
- Modify: `app.js`（在 `composeFrameSource()` 之后、`let lastVideoTime` 之前插入 3 个纯函数 + 常量）
- Test: `tests/smoke.spec.js`（在现有「中点后框内换成原视频」测试之后新增 1 个测试）

**Interfaces:**
- Produces:
  - `const SWAP_DURATION = 0.9;`
  - `function irisRevealProgress(t, mid, dur)` → number in [0,1]。`mid<=0` 或非有限返回 0；`t<=mid` 返回 0；`t>=mid+dur` 返回 1；否则 `1-(1-local)^3`，`local=(t-mid)/dur`
  - `function quadCentroid(q)` → `{x,y}`（4 点平均），`q` 缺失/不足 3 点返回 `null`
  - `function revealFullRadius(cx, cy, w, h)` → 质心到 4 个屏幕角的 `Math.hypot` 最大值

- [ ] **Step 1: 写失败测试**（插在 smoke.spec.js 的 swap 测试 `});` 之后）

```js
test("合成模式：光圈扩散进度/质心/覆盖半径（irisRevealProgress）", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.irisRevealProgress);
  const r = await page.evaluate(() => {
    const { irisRevealProgress, quadCentroid, revealFullRadius } = window.__fingerPlayTest;
    return {
      before: irisRevealProgress(1.9, 2, 1),        // 中点前 → 0
      atStart: irisRevealProgress(2.0, 2, 1),       // 恰在中点 → 0
      eased: irisRevealProgress(2.5, 2, 1),         // local=0.5 → easeOutCubic=0.875
      after: irisRevealProgress(3.1, 2, 1),         // 超过时长 → 1
      badMid: irisRevealProgress(5, 0, 1),          // duration 无效 → 0
      centroid: quadCentroid([{x:100,y:100},{x:300,y:100},{x:300,y:300},{x:100,y:300}]),
      noCentroid: quadCentroid(null),
      fullR: revealFullRadius(200, 200, 640, 480),
    };
  });
  expect(r.before).toBe(0);
  expect(r.atStart).toBe(0);
  expect(r.eased).toBeCloseTo(0.875, 5);
  expect(r.after).toBe(1);
  expect(r.badMid).toBe(0);
  expect(r.centroid).toEqual({ x: 200, y: 200 });
  expect(r.noCentroid).toBeNull();
  expect(r.fullR).toBeCloseTo(Math.hypot(640 - 200, 480 - 200), 5);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test -g "光圈扩散进度" --timeout=180000`
Expected: FAIL（`window.__fingerPlayTest.irisRevealProgress` 为 undefined，waitForFunction 超时）

- [ ] **Step 3: 最小实现**（插入到 app.js `composeFrameSource()` 结束的 `}` 之后、`let lastVideoTime = -1;` 之前）

```js
const SWAP_DURATION = 0.9; // 光圈扩散时长（秒）
// 光圈扩散进度：中点前 0，中点后按 easeOutCubic 缓动到 1。
function irisRevealProgress(t, mid, dur) {
  if (!isFinite(mid) || mid <= 0 || dur <= 0) return 0;
  if (t <= mid) return 0;
  const local = (t - mid) / dur;
  if (local >= 1) return 1;
  return 1 - Math.pow(1 - local, 3);
}
// 手指框 4 角质心（光圈起始圆心）。
function quadCentroid(q) {
  if (!q || q.length < 3) return null;
  let x = 0, y = 0;
  for (const p of q) { x += p.x; y += p.y; }
  return { x: x / q.length, y: y / q.length };
}
// 从 (cx,cy) 到 4 个屏幕角的最近距离 —— 光圈扩散满屏所需的最大半径。
function revealFullRadius(cx, cy, w, h) {
  return Math.max(
    Math.hypot(cx, cy), Math.hypot(cx - w, cy),
    Math.hypot(cx, cy - h), Math.hypot(cx - w, cy - h)
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test -g "光圈扩散进度" --timeout=180000`
Expected: PASS

- [ ] **Step 5: 临时暴露 3 个纯函数供测试**（`window.__fingerPlayTest` 里 `composeFrameSource` 那行后加一行 `irisRevealProgress, quadCentroid, revealFullRadius,`）

- [ ] **Step 6: 跑测试确认通过**（加暴露后再跑一次）

Run: `npx playwright test -g "光圈扩散进度" --timeout=180000`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add app.js tests/smoke.spec.js
git commit -m "合成光圈转场：抽出 irisRevealProgress/quadCentroid/revealFullRadius 纯函数 + 测试"
```

---

### Task 2: 抽 `renderComposeFrame` + 离屏光圈揭示层 + 接入 `loop()`

**Files:**
- Modify: `app.js`
  - 新增模块级 `const revealCanvas = document.createElement("canvas"); const revealCtx = revealCanvas.getContext("2d");`（放在 `let lastVideoTime` 之前）
  - 新增 `renderComposeFrame(c, frame, cv, W, H)`（把现有 loop 2060-2088 的框内渲染块搬进来，引用改为参数化）
  - 新增 `drawIrisReveal(ctx, base, frame, cx, cy, radius, W, H)`
  - 重写 `loop()` 渲染部分

**Interfaces:**
- Consumes: `composeFxPlan`、`LIVE_EFFECTS`、`renderPillar`、`drawWindow`、`drawOutline`、`drawHandLandmarks`、`aiSt`、`aiFiveQuads`、`fxMode`、`showHandPoints`、`aiLastHands`、`orig`、`canvas`、`irisRevealProgress`、`quadCentroid`、`revealFullRadius`、`SWAP_DURATION`
- Produces:
  - `function renderComposeFrame(c, frame, cv, W, H)` — 在上下文 `c` 上画「框内滤镜窗口 + 框线 + 手点」，`frame` 为框内画面源，`cv` 为滤镜作用的目标画布（供特效取 width/height）
  - `function drawIrisReveal(ctx, base, frame, cx, cy, radius, W, H)` — 把「base 打底 + renderComposeFrame(frame)」渲染到离屏，径向渐变羽化，再以圆形 clip 合成到 `ctx`

- [ ] **Step 1: 新增离屏画布 + `renderComposeFrame`**（插入到 `let lastVideoTime = -1;` 之前）

```js
// 光圈转场的离屏图层：先整帧渲染「新画面」再羽化合成，避免污染主画布。
const revealCanvas = document.createElement("canvas");
const revealCtx = revealCanvas.getContext("2d");

// 画「框内滤镜窗口 + 框线 + 手部检测点」。frame 是框内画面源（风格化或原视频），
// cv 是滤镜目标画布（决定特效的 width/height），W/H 是场景尺寸。
function renderComposeFrame(c, frame, cv, W, H) {
  if (aiSt.corners && aiSt.presence > 0.01) {
    const plan = composeFxPlan(fxMode, aiSt.corners, aiFiveQuads, W);
    if (plan.type === "pillar") {
      // 四指/全能：双手张开 → 3 个指缝区各套一个滤镜（A/B/C），与录制一致。
      renderPillar(c, cv, plan.tipsL, plan.tipsR, plan.effects, frame, aiSt.presence);
    } else if (plan.type === "triangles") {
      drawWindow(plan.triA, aiSt.presence, c, cv, (cc, cccv) =>
        LIVE_EFFECTS[plan.effectA](cc, cccv, frame, plan.triA)
      );
      drawWindow(plan.triB, aiSt.presence, c, cv, (cc, cccv) =>
        LIVE_EFFECTS[plan.effectB](cc, cccv, frame, plan.triB)
      );
    } else {
      drawWindow(aiSt.corners, aiSt.presence, c, cv, (cc, cccv) =>
        LIVE_EFFECTS[plan.effect](cc, cccv, frame, aiSt.corners)
      );
    }
    // 四指/全能有指缝区时 renderPillar 已画彩色蚂蚁线，不再画整框线。
    if (fxMode !== "five" && !(fxMode === "auto" && aiFiveQuads)) {
      drawOutline(aiSt.corners, aiSt.presence, orig.currentTime, c);
    }
  }
  // 合成时把录制时开的手部检测点（🖐 黑骨架）加回
  if (showHandPoints && aiLastHands && aiLastHands.length) {
    drawHandLandmarks(c, aiLastHands, W, H);
  }
}

// 光圈揭示层：整帧 = base 打底 + renderComposeFrame(frame)，用径向渐变做羽化边缘，
// 再以 (cx,cy) 半径 radius 的圆形 clip 合成到主上下文。diffusion 只在这一层发生。
function drawIrisReveal(ctx, base, frame, cx, cy, radius, W, H) {
  if (revealCanvas.width !== W || revealCanvas.height !== H) {
    revealCanvas.width = W; revealCanvas.height = H;
  }
  const oc = revealCtx;
  oc.clearRect(0, 0, W, H);
  oc.drawImage(base, 0, 0, W, H);
  renderComposeFrame(oc, frame, revealCanvas, W, H);

  // 羽化：径向渐变 destination-in，中心不透明、边缘透明。
  oc.save();
  oc.globalCompositeOperation = "destination-in";
  const feather = Math.min(56, radius * 0.5);
  const g = oc.createRadialGradient(cx, cy, Math.max(0, radius - feather), cx, cy, radius);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  oc.fillStyle = g;
  oc.fillRect(0, 0, W, H);
  oc.restore();

  // 圆形 clip 合成（羽化后的圆，边缘已透明）。
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(revealCanvas, 0, 0);
  ctx.restore();
}
```

- [ ] **Step 2: 重写 `loop()` 渲染部分**（把现有 2027-2030 的 base 绘制 + 2060-2088 的框内渲染整体替换为下面的逻辑；检测/同步 `sty.currentTime` 部分保持不动）

```js
  // 前半段：框内=风格化、框外=原视频；后半段（中点后）：框内=原视频、框外=风格化。
  // 切换不再硬切：以光圈从手指框中心向四周扩散揭示新画面。
  const swapped = isComposeSwapped(swapCompose, haveOrig && haveSty, orig.duration, orig.currentTime);
  const progress = swapped ? irisRevealProgress(orig.currentTime, orig.duration / 2, SWAP_DURATION) : 0;
  const W = canvas.width, H = canvas.height;
  if (progress > 0 && progress < 1) {
    // 旧状态：框内=风格化、框外=原视频
    ctx.drawImage(orig, 0, 0, W, H);
    renderComposeFrame(ctx, sty, canvas, W, H);
    // 新状态：光圈从框中心扩散 —— 框内=原视频、框外=风格化
    const c = quadCentroid(aiSt.corners) || { x: W / 2, y: H / 2 };
    const R = revealFullRadius(c.x, c.y, W, H);
    drawIrisReveal(ctx, sty, orig, c.x, c.y, R * progress, W, H);
  } else {
    const base = swapped ? sty : orig;
    const frame = swapped ? orig : sty;
    ctx.drawImage(base, 0, 0, W, H);
    renderComposeFrame(ctx, frame, canvas, W, H);
  }
```

注意：把原来 2027-2028 的 `const { frame, isSwapped } = composeFrameSource();` 两行删除（改用上面的 `swapped`/`progress` 判断）。`composeFrameSource` 保留给测试钩子用。

- [ ] **Step 3: 跑全量测试确认无回归**

Run: `npx playwright test --timeout=180000`
Expected: 37 passed（含既有合成滤镜/swap/清单测试）

- [ ] **Step 4: 提交**

```bash
git add app.js
git commit -m "合成模式光圈转场：renderComposeFrame 抽取 + 离屏羽化光圈揭示层，中点切换由硬切改为从框中心扩散"
```

---

### Task 3: 测试钩子 + 光圈像素级验证 + 全量回归

**Files:**
- Modify: `app.js`（`window.__fingerPlayTest` 增加 `renderComposeFrame`、`drawIrisReveal` 暴露）
- Test: `tests/smoke.spec.js`（新增 1 个像素级光圈验证测试）

**Interfaces:**
- Consumes: `drawIrisReveal`、`renderComposeFrame`、`aiSt`
- Produces: 无（仅验证）

- [ ] **Step 1: 暴露钩子**（`window.__fingerPlayTest` 里 `composeFrameSource,` 那行后加）

```js
  renderComposeFrame,
  drawIrisReveal,
```

- [ ] **Step 2: 写像素级失败测试**（插在 Task 1 的光圈测试 `});` 之后）

```js
test("合成模式：光圈扩散真正按圆遮罩揭示新画面（中心=新、角落=旧）", async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fingerPlayTest && window.__fingerPlayTest.drawIrisReveal);
  const r = await page.evaluate(async () => {
    const api = window.__fingerPlayTest;
    const W = 640, H = 480;
    // 切到「空白」滤镜：框内直接透出源画面，便于像素断言
    [...document.querySelectorAll(".effect-chip")].find((c) => c.dataset.effect === "none").click();
    await new Promise((res) => setTimeout(res, 50));
    // 旧基色红、新帧色蓝
    const base = document.createElement("canvas"); base.width = W; base.height = H;
    const bctx = base.getContext("2d"); bctx.fillStyle = "#ff0000"; bctx.fillRect(0, 0, W, H);
    const frame = document.createElement("canvas"); frame.width = W; frame.height = H;
    const fctx = frame.getContext("2d"); fctx.fillStyle = "#0000ff"; fctx.fillRect(0, 0, W, H);
    // 手框几乎覆盖全屏（光圈中心取它的质心）
    api.aiSt.corners = [{ x: 20, y: 20 }, { x: W - 20, y: 20 }, { x: W - 20, y: H - 20 }, { x: 20, y: H - 20 }];
    api.aiSt.presence = 1;
    const out = document.createElement("canvas"); out.width = W; out.height = H;
    const octx = out.getContext("2d");
    octx.drawImage(base, 0, 0); // 底层 = 旧画面（红）
    api.drawIrisReveal(octx, base, frame, 320, 240, 80, W, H); // 半径 80 的光圈
    const px = (x, y) => { const d = octx.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
    return { center: px(320, 240), corner: px(5, 5), outside: px(400, 360) };
  });
  expect(r.center[2]).toBeGreaterThan(150); // 中心 = 蓝（新画面已揭示）
  expect(r.center[0]).toBeLessThan(80);
  expect(r.corner[0]).toBeGreaterThan(150); // 角落 = 红（旧画面）
  expect(r.corner[2]).toBeLessThan(80);
  expect(r.outside[0]).toBeGreaterThan(150); // (400,360) 距圆心 hypot(80,120)=144>80 → 仍是红
  expect(r.outside[2]).toBeLessThan(80);
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `npx playwright test -g "光圈扩散真正按圆遮罩" --timeout=180000`
Expected: PASS（中心蓝、角落/圆外红）

- [ ] **Step 4: 全量回归**

Run: `npx playwright test --timeout=180000`
Expected: 39 passed

- [ ] **Step 5: 提交**

```bash
git add app.js tests/smoke.spec.js
git commit -m "光圈转场：暴露 renderComposeFrame/drawIrisReveal 钩子 + 像素级遮罩验证测试"
```

---

## Self-Review

- **Spec coverage:** 整屏光圈 ✓（Task 2 loop 改造）、中点切换 ✓、框内滤镜保留 ✓（renderComposeFrame 复用 LIVE_EFFECTS）、羽化 ✓（Task 2 destination-in）、开关关闭=硬切 ✓（`swapped ? ... : ...` 当 swapCompose=false 时 progress=0 走 else）、导出自动生效 ✓（同一 loop）。
- **Placeholder scan:** 无 TBD；每个步骤含完整代码与命令。
- **Type consistency:** `renderComposeFrame(c, frame, cv, W, H)`、`drawIrisReveal(ctx, base, frame, cx, cy, radius, W, H)`、`irisRevealProgress(t, mid, dur)` 在各任务签名一致；Task 2 loop 与 Task 3 测试参数一致。
