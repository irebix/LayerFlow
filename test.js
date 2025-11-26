/* LayerFlow: Fixed Build (Pako + UPNG Version) */
const photoshop = require('photoshop');
const uxp = require('uxp');
const { app, core, action } = photoshop;
const { imaging } = photoshop;
const fs = uxp.storage.localFileSystem;

/** 
 * ---------- 库加载逻辑 (Shim) ---------- 
 * 这里我们将 Pako 适配给 UPNG 使用，解决 "UZIP not found" 问题
 */
let UPNG = null;
try {
    // 1. 加载压缩核心库 pako
    const pako = require('./lib/pako.min.js');
    global.pako = pako; // UPNG.js 需要直接访问 pako

    // 2. 创建 UPNG 所需的 UZIP 接口 (UPNG 默认依赖 UZIP.js，我们用 pako 模拟它)
    const UZIP = {
        deflateRaw: (data) => {
            // 修改点 1：使用 strategy: 1 (Z_FILTERED)
            // 这专门针对 PNG 这种经过滤镜处理的数据进行优化，通常比默认模式更小
            return pako.deflate(data, {
                level: 6,
                raw: true,
                strategy: 1
            });
        }
    };

    // 3. 将 UZIP 挂载到全局，因为 UPNG.js 可能会在全局查找它
    global.UZIP = UZIP;

    // 4. 加载并修复 UPNG
    UPNG = require('./lib/UPNG.js');

} catch (e) {
    console.warn("依赖加载失败:", e);
    console.warn("请确保 pako.min.js 和 UPNG.js (已添加 module.exports) 都在插件根目录。");
}


function $(id) { return document.getElementById(id); }

/** 
 * 使用 UPNG + Pako 进行高压缩比无损编码 
 * 结果体积：约 300KB - 800KB
 */
function encodeImageViaUPNG(pixelData, width, height) {
    if (!UPNG || typeof UPNG.encode !== 'function') {
        throw new Error("UPNG 库未正确加载。请检查是否下载了 pako.min.js 并修改了 UPNG.js。");
    }

    // 修改点 2：清洗透明区域的 RGB 噪点
    // 这一步对于抠图场景至关重要，能大幅减小体积
    const len = pixelData.byteLength;
    for (let i = 0; i < len; i += 4) {
        // 如果 Alpha 通道 (i+3) 是 0 (完全透明)
        if (pixelData[i + 3] === 0) {
            pixelData[i] = 0;     // R 清零
            pixelData[i + 1] = 0; // G 清零
            pixelData[i + 2] = 0; // B 清零
        }
    }

    // 参数0：无损色彩；参数[]：禁止色彩量化(保持原始颜色)
    const pngBuffer = UPNG.encode([pixelData], width, height, 0);
    return pngBuffer;
}

/** ---------- Test Function ---------- **/
async function testSmartExport() {
    const doc = app.activeDocument;
    if (!doc) return alert("请先打开文档");
    const targetLayer = doc.activeLayers[0];
    if (!targetLayer) return alert("请选择一个图层");

    try {
        const b = targetLayer.boundsNoEffects || targetLayer.bounds;
        const sourceBounds = {
            left: Number(b.left), top: Number(b.top),
            right: Number(b.right), bottom: Number(b.bottom)
        };
        const width = Math.floor(sourceBounds.right - sourceBounds.left);
        const height = Math.floor(sourceBounds.bottom - sourceBounds.top);

        if (width <= 0 || height <= 0) throw new Error("图层尺寸无效");

        let pixelDataBuffer;

        // 1. 获取 RAW 数据
        await core.executeAsModal(async () => {
            const imageObj = await imaging.getPixels({
                documentID: doc.id,
                layerID: targetLayer.id,
                sourceBounds: sourceBounds,
                colorSpace: 'RGB',
                componentSize: 8,
                includeAlpha: true,
                applyAlpha: false
            });
            pixelDataBuffer = await imageObj.imageData.getData();
            imageObj.imageData.dispose();
        }, { commandName: '读取像素' });

        // 2. 编码 (压缩)
        let finalBuffer;
        if (UPNG) {
            finalBuffer = encodeImageViaUPNG(pixelDataBuffer, width, height);
        } else {
            throw new Error("缺少依赖库 (pako/UPNG)，无法压缩。请下载文件并重试。");
        }

        // 3. 保存
        const folder = await fs.getFolder();
        const file = await folder.createFile("test_compressed.png", { overwrite: true });
        await file.write(finalBuffer, { format: uxp.storage.formats.binary });

        const sizeKB = (finalBuffer.byteLength / 1024).toFixed(2);
        const msg = `导出成功！\n文件: ${file.nativePath}\n大小: ${sizeKB} KB\n(无损+压缩+降噪)`;
        console.log(msg);
        await app.showAlert(msg);

    } catch (e) {
        await app.showAlert("错误: " + e.message);
        console.error(e);
    }
}

/** ---------- Panel Setup ---------- **/
const { entrypoints } = uxp;
function mountToPanelRoot(root) {
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
function setupUI() {
    const removeBtn = $("removeBtn");
    if (removeBtn) {
        removeBtn.textContent = "测试压缩导出";
        removeBtn.addEventListener("click", async () => {
            removeBtn.disabled = true;
            removeBtn.textContent = "处理中...";
            await testSmartExport();
            removeBtn.disabled = false;
            removeBtn.textContent = "测试压缩导出";
        });
    }
}