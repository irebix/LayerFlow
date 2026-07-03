/* LayerFlow: fixed build */
const photoshop = require('photoshop');
const uxp = require('uxp');
const { app, core, action, imaging } = photoshop;
const batchPlay = action.batchPlay;
const fs = uxp.storage.localFileSystem;
// 引入纯 JS 解码库 (确保这俩文件在同级目录)
// 注意：UPNG 内部会自动寻找 pako，但在 UXP 里最好显式挂载
const pako = require("./lib/pako.min.js");
const UPNG = require("./lib/UPNG.js");
const { entrypoints } = uxp;

/** ---------- Robust HTTP client with timeout and retry ---------- **/
async function http(url, opts = {}, tries = 3, timeoutMs = 15000) {
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    try {
      const resp = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      clearTimeout(t);
      if (!resp.ok) {
        let detail = "";
        try { detail = await resp.text(); } catch (_) { }
        if (detail && detail.length > 600) detail = detail.slice(0, 600) + "...";
        throw new Error(detail ? `HTTP ${resp.status}: ${detail}` : `HTTP ${resp.status}`);
      }
      return resp;
    } catch (e) {
      clearTimeout(t);
      // 最后一轮还失败就抛出；否则指数退避
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 300 * (2 ** i) + Math.random() * 150));
    }
  }
}

/** ---------- Panel mount (Manifest v5) ---------- **/
function mountToPanelRoot(root) {
  // Move body children into panel root so Spectrum components render correctly
  const frag = document.createDocumentFragment();
  while (document.body.firstChild) frag.appendChild(document.body.firstChild);
  root.appendChild(frag);
  setupUI();
}

entrypoints.setup({
  panels: {
    layerflowPanel: {
      create(root) { mountToPanelRoot(root); }
    }
  }
});

function $(id) { return document.getElementById(id); }
function setStatus(msg) { const el = $("status"); if (el) el.textContent = msg; }
function showResultTip(msg) { const el = $("result"); if (el) el.textContent = msg || ""; }

function setProgress(v, msg) {
  const bar = $("progressBar");
  const btn = $("removeBtn");
  if (bar) {
    if (typeof v === 'number') { bar.removeAttribute('indeterminate'); bar.value = Math.max(0, Math.min(100, v)); }
    else { bar.setAttribute('indeterminate', ''); }
    bar.style.display = 'block';
    try { bar.scrollIntoView({ block: 'nearest' }); } catch (_) { }
  }
  if (btn && typeof v === 'number') { btn.textContent = `处理中 ${v | 0}%…`; btn.disabled = true; }
  if (typeof msg === 'string') setStatus(msg);
}
function endProgress(msg) {
  const bar = $("progressBar"); const btn = $("removeBtn");
  if (bar) bar.style.display = 'none';
  if (btn) { btn.textContent = '抠图'; btn.disabled = false; }
  if (typeof msg === 'string') setStatus(msg);
}

/** ---------- Settings persistence ---------- **/
async function loadSettings() {
  try {
    const data = await fs.getDataFolder();
    const file = await data.getEntry("settings.json");
    const json = JSON.parse(await file.read());
    return json || {};
  } catch (e) {
    return {};
  }
}
async function saveSettings(obj) {
  const data = await fs.getDataFolder();
  const file = await data.createFile("settings.json", { overwrite: true });
  await file.write(JSON.stringify(obj || {}));
}

/** ---------- Comfy base URL ---------- **/
let _cachedBaseURL = null;
async function getComfyBaseURL() {
  if (_cachedBaseURL) return _cachedBaseURL;
  let url = "http://10.0.99.49:8188";
  try {
    const pluginFolder = await fs.getPluginFolder();
    const cfg = await pluginFolder.getEntry("config.json").catch(() => null);
    if (cfg) {
      const json = JSON.parse(await cfg.read());
      if (json && json.comfyui_url) url = json.comfyui_url;
    }
  } catch (e) { }
  _cachedBaseURL = String(url).replace(/\/+$/, "");
  return _cachedBaseURL;
}

/** ---------- Utility: walk all layers ---------- **/
function collectAllLayers(doc) {
  const list = [];
  function walk(container) {
    const layers = container.layers || [];
    for (const l of layers) {
      list.push(l);
      if (l.layers && l.layers.length) walk(l);
    }
  }
  walk(doc);
  return list;
}

/** ---------- Layer visibility isolation ---------- **/
async function isolateOnlyTargetVisible(targetLayer) {
  const doc = app.activeDocument;
  const all = collectAllLayers(doc).map(l => ({ layer: l, visible: l.visible }));

  // Hide all
  for (const it of all) {
    try { it.layer.visible = false; } catch (_) { }
  }
  // Show target and all its ancestors
  let node = targetLayer;
  while (node) {
    try { node.visible = true; } catch (_) { }
    node = node.parent;
  }

  // Return restore function
  return () => {
    for (const it of all) {
      try { it.layer.visible = it.visible; } catch (_) { }
    }
  };
}

/** ---------- Save current visible composite to PNG ---------- **/
async function saveVisibleCompositeToPNG(outFileEntry) {
  const token = await fs.createSessionToken(outFileEntry);
  const doc = app.activeDocument;
  const docId = doc._id || doc.id;

  await batchPlay([{
    _obj: "save",
    as: { _obj: "PNGFormat" },
    in: { _path: token, _kind: "local" },
    copy: true,
    lowerCase: true,
    documentID: docId,
    _options: { dialogOptions: "dontDisplay" }
  }], { synchronousExecution: true, modalBehavior: "execute" });
}


/** ---------- base64 -> ArrayBuffer helper ---------- **/
function base64ToArrayBuffer(b64) {
  const binary = atob(b64); const len = binary.length; const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i); return bytes.buffer;
}

/** ---------- One-step history helper (单一撤回步骤) ---------- **/
async function withSingleHistoryState(historyName, work) {
  return core.executeAsModal(
    async (executionContext) => {
      const { hostControl } = executionContext;
      const doc = app.activeDocument;
      const suspension = await hostControl.suspendHistory({
        documentID: doc.id,
        name: historyName
      });

      try {
        const r = await work();
        // 提交为单一历史项
        await hostControl.resumeHistory(suspension, true);
        return r;
      } catch (e) {
        // 出错则回滚，不产生历史记录项
        try { await hostControl.resumeHistory(suspension, false); } catch (_) { }
        throw e;
      }
    },
    { commandName: historyName }
  );
}

/** ---------- Imaging path: getPixels -> encodeImageData (PNG, no UI) ---------- **/
async function exportLayerViaImagingPng(targetLayer) {
  const { imaging } = require('photoshop'); const doc = app.activeDocument;
  if (!doc) throw new Error('没有打开的文档'); const id = targetLayer && (targetLayer._id || targetLayer.id);
  const b = (targetLayer.boundsNoEffects || targetLayer.bounds);
  const sourceBounds = { left: Number(b.left), top: Number(b.top), right: Number(b.right), bottom: Number(b.bottom) };
  let imageObj; await core.executeAsModal(async () => {
    imageObj = await imaging.getPixels({ documentID: doc.id, layerID: id, sourceBounds, colorSpace: 'RGB', componentSize: 8, includeAlpha: true, applyAlpha: true });
  }, { commandName: '获取图层像素（Imaging）' });
  if (!imageObj || !imageObj.imageData) throw new Error('imaging.getPixels 未返回 imageData');
  const base64Str = await imaging.encodeImageData({ imageData: imageObj.imageData, base64: true }); imageObj.imageData.dispose();
  const tmp = await fs.getTemporaryFolder(); const fileEntry = await tmp.createFile('ps_remove_bg_input.png', { overwrite: true });
  let ab; try { const resp = await fetch('data:image/png;base64,' + base64Str); ab = await resp.arrayBuffer(); } catch (_) { ab = base64ToArrayBuffer(base64Str); }
  await fileEntry.write(ab, { format: uxp.storage.formats.binary });
  const sb = imageObj.sourceBounds; const anchor = { left: Number(sb.left), top: Number(sb.top), width: Math.max(1, Number(sb.right - sb.left)), height: Math.max(1, Number(sb.bottom - sb.top)) };
  return { fileEntry, anchor };
}

/** ---------- 回退方案：用可视合成导出目标图层区域 PNG ---------- **/
async function exportLayerBoundsToPNG(targetLayer) {
  const tmp = await fs.getTemporaryFolder();
  const fileEntry = await tmp.createFile('ps_remove_bg_input.png', { overwrite: true });

  // 只显示目标图层（及祖先），导出合成
  const restore = await isolateOnlyTargetVisible(targetLayer);
  try {
    await saveVisibleCompositeToPNG(fileEntry);
  } finally {
    try { await restore(); } catch (_) { }
  }

  const b = targetLayer.boundsNoEffects || targetLayer.bounds;
  const anchor = {
    left: Number(b.left),
    top: Number(b.top),
    width: Math.max(1, Number(b.right - b.left)),
    height: Math.max(1, Number(b.bottom - b.top))
  };
  return { fileEntry, anchor };
}

/** 命名：原名_futu / _futu_2 / _futu_3 ... **/
function computeNextRmbgName(baseName, siblingLayers) {
  const m = (baseName || '').match(/^(.*?)(?:_futu(?:_(\d+))?)?$/i); const stem = (m && m[1].length) ? m[1] : baseName;
  const tag = stem + '_futu'; let maxN = 0; const re = new RegExp('^' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:_(\\d+))?$', 'i');
  try { for (const l of (siblingLayers || [])) { const mm = re.exec(l.name || ''); if (mm) { const n = mm[1] ? parseInt(mm[1], 10) : 1; if (!isNaN(n) && n > maxN) maxN = n; } } } catch (_) { }
  if (maxN <= 0) return tag; if (maxN === 1) return tag + '_2'; return tag + '_' + (maxN + 1);
}

/** Imaging 优先；失败则回退旧方案 **/
async function getLayerInputFilePreferImaging(targetLayer) {
  try { const r = await exportLayerViaImagingPng(targetLayer); r.via = 'IMAGING'; return r; }
  catch (e) { const r2 = await exportLayerBoundsToPNG(targetLayer); r2.via = 'TMP'; return r2; }
}

/** 
 * 辅助：使用 UPNG.js 纯代码解码 (方案 B - 终极稳定版)
 * 不依赖 DOM，不依赖渲染引擎，绝无超时
 */
async function decodeBase64ToPixels(base64Str) {
  const len = base64Str ? base64Str.length : 0;

  // 1. 数据清洗与校验
  if (len < 100) throw new Error("接收到的数据太短，非有效图片");

  // 移除 data:image 前缀
  const raw = base64Str.replace(/^data:image\/\w+;base64,/, "").replace(/\s/g, "");

  // 2. Base64 -> ArrayBuffer (复用你最稳的代码)
  const binaryString = atob(raw);
  const bytesLen = binaryString.length;
  const bytes = new Uint8Array(bytesLen);
  for (let i = 0; i < bytesLen; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // 3. UPNG 解码 (纯 CPU 运算)
  try {
    // UPNG.decode 接受 ArrayBuffer
    const img = UPNG.decode(bytes.buffer);

    // 转换为 RGBA 像素数据 (返回的是 Uint8Array 的数组，我们取第一帧)
    const rgbaBuffer = UPNG.toRGBA8(img)[0];

    // 转换为 Uint8ClampedArray (Canvas/Imaging API 标准格式)
    const pixels = new Uint8ClampedArray(rgbaBuffer);

    return {
      pixels: pixels,
      width: img.width,
      height: img.height
    };
  } catch (e) {
    console.error("[LayerFlow] UPNG 解码失败:", e);
    throw new Error("图片解码失败，文件可能已损坏");
  }
}

async function applySmartMask(targetLayer, base64Result, useMask = true) {
  // 确保获取最新的 imaging 对象
  const { imaging } = require('photoshop');

  // 1. 解码数据 (得到 RGBA)
  const { pixels, width: maskW, height: maskH } = await decodeBase64ToPixels(base64Result);

  await core.executeAsModal(async (executionContext) => {
    const { hostControl } = executionContext;
    const doc = app.activeDocument;

    // 开启历史记录挂起 (Single Undo Step)
    const suspensionID = await hostControl.suspendHistory({
      "documentID": doc.id,
      "name": "智能遮罩合成"
    });

    try {
      // 获取目标图层实际尺寸
      const bounds = targetLayer.boundsNoEffects || targetLayer.bounds;
      const targetW = Math.round(bounds.right - bounds.left);
      const targetH = Math.round(bounds.bottom - bounds.top);
      const targetLeft = Math.round(bounds.left);
      const targetTop = Math.round(bounds.top);

      // 在原图层上操作
      targetLayer.selected = true;
      const finalLayer = targetLayer;



      // ====== RGBA -> 灰度遮罩 ======
      const srcGray = new Uint8Array(maskW * maskH);
      for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
        // 结果是黑白图，R=G=B，这里取 R 通道即可
        srcGray[j] = pixels[i];
      }

      // 如果尺寸不一致，先在 JS 里缩放到目标尺寸
      let dstW = targetW;
      let dstH = targetH;
      let dstGray;

      if (maskW === targetW && maskH === targetH) {
        dstGray = srcGray;
      } else {
        dstGray = new Uint8Array(dstW * dstH);
        const scaleX = maskW / dstW;
        const scaleY = maskH / dstH;
        for (let y = 0; y < dstH; y++) {
          const srcY = Math.min(maskH - 1, Math.round((y + 0.5) * scaleY - 0.5));
          for (let x = 0; x < dstW; x++) {
            const srcX = Math.min(maskW - 1, Math.round((x + 0.5) * scaleX - 0.5));
            dstGray[y * dstW + x] = srcGray[srcY * maskW + srcX];
          }
        }
      }

      // 确保有一张用户蒙版（已存在时可能抛错，直接忽略）
      try {
        await action.batchPlay([{
          "_obj": "make",
          "new": { "_class": "channel" },
          "at": { "_ref": "channel", "_enum": "channel", "_value": "mask" },
          "using": { "_enum": "userMaskEnabled", "_value": "hideAll" }
        }], { synchronousExecution: true, modalBehavior: "execute" });
      } catch (e) {
        console.warn("[LayerFlow] 创建蒙版通道失败（可能已经有蒙版）：", e);
      }

      // 写入蒙版像素
      let maskImageData;
      try {
        maskImageData = await imaging.createImageDataFromBuffer(dstGray, {
          width: dstW,
          height: dstH,
          components: 1,
          chunky: true,
          colorSpace: "Grayscale",
          colorProfile: "Gray Gamma 2.2"
        });

        await imaging.putLayerMask({
          documentID: doc.id,
          layerID: finalLayer.id,
          kind: "user",
          imageData: maskImageData,
          replace: true,
          targetBounds: { left: targetLeft, top: targetTop }
        });
      } finally {
        if (maskImageData) {
          maskImageData.dispose();
        }
      }

      // 根据“使用蒙版”开关，决定是否直接应用蒙版
      if (!useMask) {
        try {
          await action.batchPlay([{
            "_obj": "delete",
            "_target": [{ "_ref": "channel", "_enum": "channel", "_value": "mask" }],
            "apply": true
          }], { synchronousExecution: true, modalBehavior: "execute" });
        } catch (e) {
          console.warn("[LayerFlow] 应用图层蒙版失败：", e);
        }
      }

      // 提交历史记录
      await hostControl.resumeHistory(suspensionID, true);

    } catch (err) {
      // 发生错误，回滚历史记录
      await hostControl.resumeHistory(suspensionID, false);
      throw err;
    }

  }, { commandName: "智能遮罩合成" });
}



/** ---------- ComfyUI workflow helpers ---------- **/

async function uploadToComfy(baseURL, fileEntry, dstName) {
  const arrBuf = await fileEntry.read({ format: uxp.storage.formats.binary });
  const blob = new Blob([arrBuf], { type: "image/png" });
  const form = new FormData();
  form.append("image", blob, dstName);
  // ComfyUI: POST /upload/image
  const resp = await http(baseURL + "/upload/image", { method: "POST", body: form });
  // 返回 JSON（包含 name / subfolder 等）
  return await resp.json();
}

async function loadWorkflowJSON() {
  const plugin = await fs.getPluginFolder();
  // Prefer workflow.json; fallback to any other json (except manifest)
  const names = ["workflow.json"];
  for (const name of names) {
    try { return JSON.parse(await (await plugin.getEntry(name)).read()); } catch (e) { }
  }
  // heuristic: first .json except manifest
  const entries = await plugin.getEntries();
  for (const e of entries) {
    if (e.name.toLowerCase().endsWith(".json") && e.name !== "manifest.json") {
      try { return JSON.parse(await e.read()); } catch (e) { }
    }
  }
  throw new Error("未找到 workflow.json。请将工作流 JSON 放在插件根目录。");
}

function replaceImageInWorkflow(workflow, filename) {
  // 适配常见 ComfyUI 节点：LoadImage 节点的 "image" 字段
  const jsonStr = JSON.stringify(workflow);
  // 正则表达式查找 "image": "any_value" 并替换
  const replaced = jsonStr.replace(/"image"\s*:\s*"[^"]*"/g, `"image":"${filename.replace(/\\/g, '\\\\')}"`);
  return JSON.parse(replaced);
}

async function waitForResult(baseURL, promptId, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // 首先，检查历史记录中是否已有结果
    const resp = await http(`${baseURL}/history/${promptId}`, {}, 2, 10000);
    const data = await resp.json();
    if (data && data[promptId] && data[promptId].outputs) {
      const outputs = data[promptId].outputs;
      // 尝试找到第一个 text 输出 
      for (const k of Object.keys(outputs)) {
        const nodeOutput = outputs[k];

        // 根据我们从API获取的JSON，输出字段是 "text"，并且它是一个数组
        if (nodeOutput && nodeOutput.text && Array.isArray(nodeOutput.text) && nodeOutput.text.length > 0) {
          const base64Data = nodeOutput.text[0]; // 获取数组中的第一个元素
          if (base64Data) {
            // 直接返回 Base64 字符串，不再转换为 ArrayBuffer
            return base64Data;
          }
        }
      }
    }

    // 如果还没有结果，则更新队列信息
    try {
      const queueResp = await http(`${baseURL}/queue`, {}, 1, 5000);
      const queueData = await queueResp.json();
      const pendingCount = (queueData.queue_pending || []).length;
      const runningCount = (queueData.queue_running || []).length;
      const totalInQueue = pendingCount + runningCount;
      if (totalInQueue > 0) {
        setStatus(`等待 ComfyUI 处理… (队列: ${totalInQueue})`);
      } else {
        setStatus("等待 ComfyUI 处理…");
      }
    } catch (e) {
      // 如果队列检查失败，只需保持上一个消息，不要中断轮询
      console.warn("无法获取 ComfyUI 队列状态。", e);
    }

    await new Promise(r => setTimeout(r, 1200));
  }
  throw new Error("等待 ComfyUI 结果超时");
}

async function runComfyWorkflow(baseURL, fileEntry, dstName) {
  setStatus("上传输入到 ComfyUI…");
  const uploadResult = await uploadToComfy(baseURL, fileEntry, dstName);

  // 构造正确的文件名（含子目录）
  let filename = uploadResult.name;
  if (uploadResult.subfolder) {
    filename = uploadResult.subfolder.replace(/\\/g, '/') + "/" + filename;
  }

  setStatus("提交工作流…");
  const wf = await loadWorkflowJSON();
  const wf2 = replaceImageInWorkflow(wf, filename);

  const resp = await http(baseURL + "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf2 })
  });
  const j = await resp.json();
  const promptId = j.prompt_id || j.promptId || j.id;
  if (!promptId) throw new Error("未获得 prompt_id");

  const base64Str = await waitForResult(baseURL, promptId);
  setStatus("收到结果");
  return base64Str;
}

/** ---------- UI setup & click handler ---------- **/
let uiInited = false;
function setupUI() {
  if (uiInited) return;
  uiInited = true;

  const removeBtn = $("removeBtn");
  const replaceCheck = $("replaceCheck"); // 现在表示“使用蒙版”

  // init switch state（“使用蒙版”开关，默认开启）
  loadSettings().then(s => {
    if (!replaceCheck) return;
    const hasUseMask = s && Object.prototype.hasOwnProperty.call(s, "useMask");
    const useMask = hasUseMask ? !!s.useMask : true; // 默认 true
    replaceCheck.checked = useMask;
  });
  replaceCheck?.addEventListener("change", async () => {
    await saveSettings({ useMask: !!replaceCheck.checked });
  });

  removeBtn.addEventListener("click", async () => {
    showResultTip("");
    setProgress(3, "准备中…");
    removeBtn.disabled = true;
    try {
      const doc = app.activeDocument;
      if (!doc) throw new Error("没有打开的文档");
      const [targetLayer] = doc.activeLayers || [];
      if (!targetLayer) throw new Error("未选择图层");
      const baseURL = await getComfyBaseURL();

      setProgress(12, "获取图层像素…");
      const { fileEntry, anchor } = await getLayerInputFilePreferImaging(targetLayer);

      setProgress(45, "上传到 ComfyUI 并执行…");
      const base64Result = await runComfyWorkflow(baseURL, fileEntry, "ps_remove_bg_input.png");

      const useMask = replaceCheck ? !!replaceCheck.checked : true;
      setProgress(90, "智能合成蒙版…");
      await applySmartMask(targetLayer, base64Result, useMask);

      endProgress("完成");
      showResultTip("已插入抠图结果");
    } catch (err) {
      console.error("[浮图] 错误：", err);
      endProgress("出错");
      showResultTip((err && err.message) ? err.message : String(err));
    } finally {
      removeBtn.disabled = false;
    }
  });
}


