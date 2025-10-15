/* LayerFlow: fixed build */
const photoshop = require('photoshop');
const uxp = require('uxp');
const { app, core, action } = photoshop;
const batchPlay = action.batchPlay;
const fs = uxp.storage.localFileSystem;
const { entrypoints } = uxp;

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
    try { bar.scrollIntoView({ block: 'nearest' }); } catch (_) {}
  }
  if (btn && typeof v === 'number') { btn.textContent = `处理中 ${v|0}%…`; btn.disabled = true; }
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
  } catch (e) {}
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
    try { it.layer.visible = false; } catch (_) {}
  }
  // Show target and all its ancestors
  let node = targetLayer;
  while (node) {
    try { node.visible = true; } catch (_) {}
    node = node.parent;
  }

  // Return restore function
  return () => {
    for (const it of all) {
      try { it.layer.visible = it.visible; } catch (_) {}
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
  for (let i=0;i<len;i++) bytes[i] = binary.charCodeAt(i); return bytes.buffer;
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

/** 命名：原名_futu / _futu_2 / _futu_3 ... **/
function computeNextRmbgName(baseName, siblingLayers) {
  const m = (baseName||'').match(/^(.*?)(?:_futu(?:_(\d+))?)?$/i); const stem = (m && m[1].length) ? m[1] : baseName;
  const tag = stem + '_futu'; let maxN = 0; const re = new RegExp('^' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:_(\\d+))?$', 'i');
  try { for (const l of (siblingLayers||[])) { const mm = re.exec(l.name||''); if (mm) { const n = mm[1] ? parseInt(mm[1],10) : 1; if (!isNaN(n) && n > maxN) maxN = n; } } } catch (_) {}
  if (maxN <= 0) return tag; if (maxN === 1) return tag + '_2'; return tag + '_' + (maxN + 1);
}

/** Imaging 优先；失败则回退旧方案 **/
async function getLayerInputFilePreferImaging(targetLayer) {
  try { const r = await exportLayerViaImagingPng(targetLayer); r.via='IMAGING'; return r; }
  catch (e) { const r2 = await exportLayerBoundsToPNG(targetLayer); r2.via='TMP'; return r2; }
}
/** ---------- Insert result above (new: translate-only + overwrite) ---------- **/

/** ---------- Insert result above (translate-only), then overwrite or name; rasterize if smart object ---------- **/
async function insertAndAlignResult(targetLayer, bytes, replaceOriginal, anchor) {
  const tmp = await fs.getTemporaryFolder();
  const file = await tmp.createFile("ps_futu_result.png", { overwrite: true });
  await file.write(bytes, { format: uxp.storage.formats.binary });

  await core.executeAsModal(async () => {
    const token = await fs.createSessionToken(file);
    await batchPlay([{
      _obj: "placeEvent",
      null: { _path: token, _kind: "local" },
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSCorner0" },
      offset: { _obj: "offset",
        horizontal: { _unit: "pixelsUnit", _value: 0 },
        vertical:   { _unit: "pixelsUnit", _value: 0 } },
      linked: false
    }], { synchronousExecution: true, modalBehavior: "execute" });

    const doc = app.activeDocument;
    const placed = doc.activeLayers && doc.activeLayers[0];
    if (!placed) return;

    // 默认放到原图层上方（便于可视检查）；覆写时会再移动到原图层下方
    try {
      const { ElementPlacement } = require('photoshop').constants;
      placed.move(targetLayer, ElementPlacement.PLACEBEFORE);
    } catch (_) {}

    // [MODIFIED ALIGNMENT LOGIC]
    // The old logic aligned pixel bounds. The new logic aligns the layer's frame.
    // It assumes Photoshop centers the placed image, then calculates the translation
    // needed to move the frame to the original anchor position.
    try {
      const docWidth = doc.width;
      const docHeight = doc.height;
      const layerWidth = anchor.width;
      const layerHeight = anchor.height;

      // Calculate the top-left position of the centered layer
      const centeredLeft = (docWidth / 2) - (layerWidth / 2);
      const centeredTop = (docHeight / 2) - (layerHeight / 2);

      // Get the target top-left position from the anchor
      const targetLeft = (anchor && anchor.left) ? Number(anchor.left) : 0;
      const targetTop = (anchor && anchor.top) ? Number(anchor.top) : 0;

      // Calculate the delta and translate the layer
      const dx = targetLeft - centeredLeft;
      const dy = targetTop - centeredTop;

      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
        await placed.translate(dx, dy);
      }
    } catch (e) {
      console.error("LayerFlow alignment failed:", e);
    }

    //栅格化：将放置层转为像素层（去除智能对象属性）
    try {
      const { RasterizeType } = require('photoshop').constants;
      await placed.rasterize(RasterizeType.ENTIRELAYER);
    } catch (_) {}

    const originalName = (targetLayer && targetLayer.name) || "Layer";

    if (replaceOriginal) {
      // 覆写：移到原图层下方，重命名为原名，删除原图层
      try {
        const { ElementPlacement } = require('photoshop').constants;
        placed.move(targetLayer, ElementPlacement.PLACEAFTER);
      } catch (_) {}
      try { placed.name = originalName; } catch (_) {}
      try { await targetLayer.delete(); } catch (_) {}
    } else {
      // 命名：原名_futu / _2 / _3 ...
      try {
        const parent = targetLayer && targetLayer.parent;
        const siblings = parent ? (parent.layers || []) : (doc.layers || []);
        const nextName = computeNextRmbgName(originalName, siblings);
        placed.name = nextName;
      } catch (_) {}
    }
  }, { commandName: "插入抠图结果并对齐" });
}

/** ---------- ComfyUI workflow helpers ---------- **/

async function uploadToComfy(baseURL, fileEntry, dstName) {
  const arrBuf = await fileEntry.read({ format: uxp.storage.formats.binary });
  const blob = new Blob([arrBuf], { type: "image/png" });
  const form = new FormData();
  form.append("image", blob, dstName);
  // ComfyUI: POST /upload/image
  const resp = await fetch(baseURL + "/upload/image", { method: "POST", body: form });
  if (!resp.ok) throw new Error("上传到 ComfyUI 失败: " + resp.status);
  // --- MODIFICATION START ---
  // Return the JSON response from ComfyUI
  return await resp.json();
  // --- MODIFICATION END ---
}

async function loadWorkflowJSON() {
  const plugin = await fs.getPluginFolder();
  // Prefer workflow.json; fallback to any other json (except manifest)
  const names = ["workflow.json"];
  for (const name of names) {
    try { return JSON.parse(await (await plugin.getEntry(name)).read()); } catch (e) {}
  }
  // heuristic: first .json except manifest
  const entries = await plugin.getEntries();
  for (const e of entries) {
    if (e.name.toLowerCase().endsWith(".json") && e.name !== "manifest.json") {
      try { return JSON.parse(await e.read()); } catch (e) {}
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

async function waitForResult(baseURL, promptId, timeoutMs=120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // 首先，检查历史记录中是否已有结果
    const resp = await fetch(`${baseURL}/history/${promptId}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data && data[promptId] && data[promptId].outputs) {
        const outputs = data[promptId].outputs;
        // 尝试找到第一个图像输出
        for (const k of Object.keys(outputs)) {
          const o = outputs[k];
          const imgs = (o && o.images) || [];
          if (imgs.length) {
            const img = imgs[0];
            const url = `${baseURL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${encodeURIComponent(img.type || "output")}`;
            const resImg = await fetch(url);
            const buf = await resImg.arrayBuffer();
            return new Uint8Array(buf);
          }
        }
      }
    }

    // 如果还没有结果，则更新队列信息
    try {
      const queueResp = await fetch(`${baseURL}/queue`);
      if (queueResp.ok) {
        const queueData = await queueResp.json();
        const pendingCount = (queueData.queue_pending || []).length;
        const runningCount = (queueData.queue_running || []).length;
        const totalInQueue = pendingCount + runningCount;
        if (totalInQueue > 0) {
          setStatus(`等待 ComfyUI 处理… (队列: ${totalInQueue})`);
        } else {
          setStatus("等待 ComfyUI 处理…");
        }
      }
    } catch(e) {
      // 如果队列检查失败，只需保持上一个消息，不要中断轮询
      console.warn("无法获取 ComfyUI 队列状态。", e);
    }

    await new Promise(r => setTimeout(r, 1200));
  }
  throw new Error("等待 ComfyUI 结果超时");
}

async function runComfyWorkflow(baseURL, fileEntry, dstName) {
  // --- MODIFICATION START ---
  setStatus("上传输入到 ComfyUI…");
  const uploadResult = await uploadToComfy(baseURL, fileEntry, dstName);
  
  // Construct the correct filename, including the subfolder if it exists
  let filename = uploadResult.name;
  if (uploadResult.subfolder) {
    // ComfyUI uses forward slashes for paths
    filename = uploadResult.subfolder.replace(/\\/g, '/') + "/" + filename;
  }
  
  setStatus("提交工作流…");
  const wf = await loadWorkflowJSON();
  // Use the correct filename (with subfolder) to replace in the workflow
  const wf2 = replaceImageInWorkflow(wf, filename);
  // --- MODIFICATION END ---
  
  const resp = await fetch(baseURL + "/prompt", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ prompt: wf2 })});
  if (!resp.ok) throw new Error("提交工作流失败: " + resp.status);
  const j = await resp.json();
  const promptId = j.prompt_id || j.promptId || j.id;
  if (!promptId) throw new Error("未获得 prompt_id");

  const bytes = await waitForResult(baseURL, promptId);
  setStatus("收到结果");
  return bytes;
}

/** ---------- UI setup & click handler ---------- **/
function setupUI() {
  const removeBtn = $("removeBtn");
  const replaceCheck = $("replaceCheck");

  // init switch state
  loadSettings().then(s => { if (replaceCheck) replaceCheck.checked = !!s.replaceOriginal; });
  replaceCheck?.addEventListener("change", async () => {
    await saveSettings({ replaceOriginal: !!replaceCheck.checked });
  });

  removeBtn.addEventListener("click", async () => {
  showResultTip(""); setProgress(3, "准备中…"); removeBtn.disabled = true;
  try {
    const doc = app.activeDocument; if (!doc) throw new Error("没有打开的文档");
    const [targetLayer] = doc.activeLayers || []; if (!targetLayer) throw new Error("未选择图层");
    const baseURL = await getComfyBaseURL();
    setProgress(12, "获取图层像素…"); const { fileEntry, anchor } = await getLayerInputFilePreferImaging(targetLayer);
    setProgress(45, "上传到 ComfyUI 并执行…"); const resultBytes = await runComfyWorkflow(baseURL, fileEntry, 'ps_remove_bg_input.png');
    setProgress(90, "回贴结果并对齐…"); await insertAndAlignResult(targetLayer, resultBytes, !!(replaceCheck && replaceCheck.checked), anchor);
    endProgress("完成"); showResultTip("已插入抠图结果");
  } catch (err) {
    console.error("[浮图] 错误：", err); endProgress("出错"); showResultTip((err && err.message) ? err.message : String(err));
  } finally { removeBtn.disabled = false; }
});
}