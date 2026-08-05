/*************************************************************
 * 波波酪梨 線上訂購系統 — 前端 script.js
 * 版本：2026-08 Firebase 控制節點版 (v4)
 *
 * 本次主要改動：
 *  A1  Firebase 推播加上 dataAt 新鮮度比對，舊資料一律丟棄
 *      （秒殺尾聲最容易出現亂序推播，客人會看到已售完的品項還有貨）
 *  A2  成功頁金額改用後端實際成交金額，保證跟試算表與 PDF 一致
 *      設定輪詢改為套用整份設定，價格不再凍在載入那一刻
 *  A5  上架時間全部改吃後端算好的絕對時間戳（後端已改成明確時區）
 *  D1  applyReleaseStatus 不再重設 lastKnown，開賣狀態轉換只由 ticker 負責
 *      （舊版快照輪詢與 ticker 搶著決定，開賣那一秒有機率不解鎖）
 *  D3  送單期間收到的推播先暫存，送完再套用，不再中途改動購物車
 *
 * 📝 資料來源分工（依「變動速度」而非「資料種類」）
 *   即時層 → Firebase control 節點：庫存、上架時間、訂單開關、配送開關
 *   靜態層 → GitHub 快照：品種、圖片、公告、匯款、價格運費表，兼冷啟動與備援
 *   權威層 → GAS：下單當下的最終覆核，錢與庫存只認這一層
 *************************************************************/

// ========================================
// ⭐ 連線設定
// ========================================
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwbkKqipfPrimFs7-d6ZorySDv0g5yhq_vbGGp2xmWZm2diNsblTfMjwP8kz-Hx9iRDTQ/exec';
const CONFIG_JSON_URL  = 'https://probroavocado.com/data/config.json';
const ADDRESS_JSON_URL = 'https://probroavocado.com/data/address.json';

// 🔥 Firebase 即時控制節點（唯讀，這個網址本來就是公開資訊）
const FIREBASE_DB_URL = 'https://probro-stock-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_CONTROL_PATH = 'control';

const POLL_MS_FAST = 8000;    // Firebase 沒連上時：靠輪詢快照，8 秒一次
const POLL_MS_SLOW = 60000;   // Firebase 正常時：即時層走推播，快照只需慢慢確認靜態內容
const SNAPSHOT_STALE_MIN = 60;// 快照超過幾分鐘沒更新就顯示柔性提示


// ========================================
// 🌟 核心狀態
// ========================================
var 價格表 = {}, 運費表 = {};
var finalSubtotal = 0, finalShippingFee = 0, finalTotal = 0;
var currentOrderSummary = null;
var cart = {};
var totalWeight = 0;
var isSubmitting = false;
var currentOrderKey = null;      // 同一筆訂單的重試共用同一組，防止重複下單
var lastSnapshotStamp = null;    // 內容比對用
var configLoaded = false;
var firebaseLive = false;        // Firebase 是否連線中（決定即時層資料要信誰）

// 🔑 A1：目前手上這份即時層資料的新鮮度。
// 只接受 dataAt 比它更大的推播，比較舊的一律丟掉。
// 注意這是「資料被讀出來的時間」，不是「推播送達的時間」——
// 網路亂序時，先到的不一定比較新。
var lastControlDataAt = 0;

// 🔑 D3：送單期間收到的推播先存這裡，送完再套用。
// 舊版 Firebase 回呼會直接改動購物車，客人按下送出的當下購物車被動到，
// 雖然送出的 body 已經序列化不受影響，但畫面會跳、體驗很差。
var pendingControl = null;

// 🏝️ 台灣離島判定
const 離島縣市 = ['澎湖縣', '金門縣', '連江縣'];
const 離島鄉鎮 = ['綠島鄉', '蘭嶼鄉', '琉球鄉'];

// 🕐 上架狀態（後端提供絕對時間戳，前端自行倒數）
const RELEASE = { at: null, display: '', lastKnown: true };
var serverClockOffset = 0; // 伺服器時間 - 本機時間

// 🚦 開關狀態（即時層）
var orderSwitch = '開';
var shippingSwitch = { post: '', '711': '', blackcat: '' };


// ========================================
// 🔧 共用小工具
// ========================================

// 設定 key 一律去空格再查，跟後端 normKey 對齊。
// 試算表的 key 例如「當季酪梨( 隨機出貨 )【優級】單價」括號內外都有空格，
// 只要有人不小心動到空白，原本會安靜地變成 undefined → 0 元。
function normKey(k) {
  return String(k == null ? '' : k).replace(/\s+/g, '');
}
function cfgGet(obj, key) {
  if (!obj) return undefined;
  return obj[normKey(key)];
}
function cfgNum(obj, key) {
  return Number(cfgGet(obj, key)) || 0;
}

function isIslandAddress(county, district) {
  if (!county) return false;
  if (離島縣市.includes(county)) return true;
  if (district && 離島鄉鎮.includes(district)) return true;
  return false;
}

function makeOrderKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// 伺服器時間（用 HTTP Date 標頭校時，不信任客人的本機時鐘）
function serverNow() {
  return Date.now() + serverClockOffset;
}
function isReleasedNow() {
  return RELEASE.at === null ? true : serverNow() >= RELEASE.at;
}

// 🖼️ 圖片網址工具
function resolveImageUrl(raw, width) {
  if (!raw) return '';
  const w = width || 800;
  if (/^https?:\/\//i.test(raw)) {
    if (raw.includes('ik.imagekit.io')) {
      return raw + (raw.includes('?') ? '&' : '?') + 'tr=w-' + w;
    }
    return raw;
  }
  return `https://lh3.googleusercontent.com/d/${raw}=w${w}`;
}

// 顯示名稱 → 價格表 key
const stockKeyMap = {
  '平克頓/哈斯 (隨機出貨)【優級】': '平克頓/哈斯【優級】',
  '平克頓/哈斯 (隨機出貨)【次級】': '平克頓/哈斯【次級】',
  '當季酪梨(隨機出貨)【優級】': '當季酪梨(隨機出貨)【優級】',
  '當季酪梨(隨機出貨)【次級】': '當季酪梨(隨機出貨)【次級】'
};

const 商品分類 = [
  { name: '當季酪梨(隨機出貨)【優級】', weights: [3, 5, 7, 10], priceKey: '當季酪梨( 隨機出貨 )【優級】單價' },
  { name: '當季酪梨(隨機出貨)【次級】', weights: [3, 5, 7, 10], priceKey: '當季酪梨( 隨機出貨 )【次級】單價' },
  { name: '平克頓/哈斯【優級】',        weights: [1, 2, 3],     priceKey: '平克頓/哈斯【優級】單價' },
  { name: '平克頓/哈斯【次級】',        weights: [1, 2, 3],     priceKey: '平克頓/哈斯【次級】單價' }
];

const displayNameMap = {
  '平克頓/哈斯【優級】': '平克頓/哈斯 (隨機出貨)【優級】',
  '平克頓/哈斯【次級】': '平克頓/哈斯 (隨機出貨)【次級】',
  '當季酪梨(隨機出貨)【優級】': '當季酪梨(隨機出貨)【優級】',
  '當季酪梨(隨機出貨)【次級】': '當季酪梨(隨機出貨)【次級】'
};

function stockKeyOf(catName, weight) {
  return normKey(catName + '-' + weight);
}

const 限重表 = { post: 10, '711': 7, blackcat: 10 };
const 配送名稱 = { post: '中華郵政', '711': '7-11', blackcat: '黑貓宅急便' };
const 配送顯示名 = { post: '中華郵政配送', '711': '7-11超商配送', blackcat: '黑貓宅急便配送' };


// ========================================
// 📡 抓取快照
// ========================================

// 用標準快取驗證（cache: 'no-cache' = 一定跟伺服器確認，但沒變動時只回 304）。
async function fetchSnapshot(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('快照讀取失敗，狀態碼 ' + res.status);
  const json = await res.json();
  if (!json.success) throw new Error('快照格式不正確');

  // 用回應的 Date 標頭校時：這是 CDN 的當下時間，永遠新鮮、也不受客人本機時鐘影響
  const dateHeader = res.headers.get('date');
  if (dateHeader) {
    const t = Date.parse(dateHeader);
    if (!isNaN(t)) serverClockOffset = t - Date.now();
  } else if (json.serverNow) {
    serverClockOffset = Number(json.serverNow) - Date.now();
  }

  return json;
}

// 🔥 Firebase REST 備援：SDK 連不上時，用一般 HTTPS 抓即時層。
// 這條路徑不佔用 realtime 的同時連線數，成本也極低（單次約 1 KB）。
async function fetchControlViaRest() {
  const res = await fetch(`${FIREBASE_DB_URL}/${FIREBASE_CONTROL_PATH}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error('控制節點讀取失敗，狀態碼 ' + res.status);
  const json = await res.json();
  if (!json || !json.json) throw new Error('控制節點內容為空');
  return json;
}

async function fetchConfigWithRetry(maxAttempts = 3, baseDelayMs = 1500) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchSnapshot(CONFIG_JSON_URL);
    } catch (err) {
      lastError = err;
      console.warn(`第 ${attempt} 次載入失敗`, err);
      if (attempt < maxAttempts) {
        const waitMs = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
        const msgEl = document.getElementById('loading-msg');
        if (msgEl) {
          stopLoadingMessages();
          msgEl.textContent = `連線有點慢，正在重新嘗試 (${attempt}/${maxAttempts - 1})…`;
        }
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  // 🛟 最後的備援：快照整個掛掉時，退回直接打 GAS。
  // 速度慢一點、也吃 GAS 的同時執行數，但至少站是活的。
  console.warn('靜態快照連續失敗，改用 GAS 備援端點');
  try {
    const msgEl = document.getElementById('loading-msg');
    if (msgEl) msgEl.textContent = '正在改用備援線路連線…';
    const res = await fetch(GAS_URL + '?action=getConfig');
    const json = await res.json();
    if (json && json.success) {
      if (json.serverNow) serverClockOffset = Number(json.serverNow) - Date.now();
      return json;
    }
  } catch (err) {
    console.error('GAS 備援端點也失敗', err);
  }

  throw lastError;
}

async function fetchAddressMap(maxAttempts = 3, baseDelayMs = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(ADDRESS_JSON_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('地址對照表讀取失敗，狀態碼 ' + res.status);
      const json = await res.json();
      if (!json.success || !json.data || Object.keys(json.data).length === 0) {
        throw new Error('地址對照表內容為空或格式不正確');
      }
      return json.data;
    } catch (err) {
      console.warn(`地址對照表第 ${attempt} 次載入失敗`, err);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, baseDelayMs * attempt));
    }
  }
  console.error('地址對照表重試 3 次後仍載入失敗，宅配地址下拉選單將無法使用');
  return {};
}


// ========================================
// 🚀 頁面啟動
// ========================================
window.onload = async function () {
  showLoadingScreen(true);

  try {
    const [json, addressMap] = await Promise.all([
      fetchConfigWithRetry(3, 1500),
      fetchAddressMap()
    ]);

    const cfg = json.data;

    window.APP_CONFIG = {
      mainTitle:    cfgGet(cfg['首頁'], '網頁大標題') || '波波酪梨',
      bankName:     cfgGet(cfg['匯款'], '匯款銀行') || '',
      bankAcc:      cfgGet(cfg['匯款'], '匯款帳號') || '',
      bankUser:     cfgGet(cfg['匯款'], '戶名') || '',
      linePayMsg:   cfgGet(cfg['匯款'], 'LINE_PAY公告') || '',
      linePayImgId: cfgGet(cfg['匯款'], 'LINE_PAY圖片ID') || '',
      successMsg:   cfgGet(cfg['匯款'], '成功頁提醒文字') || '',
      stockData:    cfg['庫存'] || {},
      orderConfig:  cfg['訂購'] || {},
      addressMap:   addressMap || {},
      varieties:    cfg['品種'] || []
    };

    window.allVarieties = cfg['品種'] || [];
    window.paymentConfig = cfg['匯款'] || {};

    // 冷啟動：先用快照把即時層填起來，Firebase 連上後會立刻被更新的資料取代。
    // dataAt 用 0，代表「最舊」，所以任何一次推播都會贏過它。
    applyReleaseStatus(cfg['上架狀態']);
    applySwitches(
      cfgGet(cfg['首頁'], '訂單開關') || '開',
      {
        post:     cfgGet(cfg['訂購'], '中華郵政配送'),
        '711':    cfgGet(cfg['訂購'], '7-11超取配送'),
        blackcat: cfgGet(cfg['訂購'], '黑貓配送')
      }
    );

    // 🔑 D1：初始化時設定一次基準，之後 lastKnown 只由 ticker 更新。
    RELEASE.lastKnown = isReleasedNow();

    applySnapshotStamp(json);
    applyConfigToPage(cfg);
    applyStaticTables(cfg['訂購'] || {});

    // 庫存 key 統一去空格
    window.APP_CONFIG.stockMap = {};
    const rawStock = window.APP_CONFIG.stockData || {};
    Object.keys(rawStock).forEach(k => {
      window.APP_CONFIG.stockMap[normKey(k)] = Math.max(0, Number(rawStock[k]) || 0);
    });

    renderOrderCardImages(window.APP_CONFIG.orderConfig);

    renderProductList();
    renderVarieties();
    renderPriceMenu();
    initAddressSelector();
    initShippingAddressToggle();
    updateReleaseBanner();
    updateEnterButton();

    configLoaded = true;
    startStockAutoRefresh();
    initFirebaseControl();
    startReleaseTicker();

  } catch (err) {
    console.error('初始化失敗：', err);
    showLoadingError();
  } finally {
    showLoadingScreen(false);
  }
};

// 把「價格表 / 運費表」從設定物件重新建出來。
// 🔑 A2：獨立成函式，讓背景輪詢也能重新套用，
// 不再像舊版那樣凍在 window.onload 那一刻。
function applyStaticTables(data) {
  window.APP_CONFIG.orderConfig = data || {};

  價格表 = {
    '當季酪梨(隨機出貨)【優級】': cfgNum(data, '當季酪梨( 隨機出貨 )【優級】單價'),
    '當季酪梨(隨機出貨)【次級】': cfgNum(data, '當季酪梨( 隨機出貨 )【次級】單價'),
    '平克頓/哈斯【優級】':        cfgNum(data, '平克頓/哈斯【優級】單價'),
    '平克頓/哈斯【次級】':        cfgNum(data, '平克頓/哈斯【次級】單價')
  };

  運費表 = {
    郵寄小: cfgNum(data, '郵寄七斤(不含)以下'),
    郵寄大: cfgNum(data, '郵寄七斤(包含)以上'),
    '711運費': cfgNum(data, '711運費'),
    黑貓小: cfgNum(data, '黑貓配送七斤(不含)以下'),
    黑貓大: cfgNum(data, '黑貓配送七斤(包含)以上'),
    郵寄離島小: cfgNum(data, '郵寄離島七斤(不含)以下'),
    郵寄離島大: cfgNum(data, '郵寄離島七斤(包含)以上'),
    黑貓離島小: cfgNum(data, '黑貓配送離島七斤(不含)以下'),
    黑貓離島大: cfgNum(data, '黑貓配送離島七斤(包含)以上')
  };

  // ⚠️ 價格全 0 通常代表試算表的 key 被動到（多打/少打空格）。
  // 這種情況下前後端會「一致地」都算成 0 元，後端覆核完全失效，
  // 所以這裡直接把訂購入口鎖住，而不是讓客人下 0 元訂單。
  const 有效價格數 = Object.values(價格表).filter(v => v > 0).length;
  window.APP_CONFIG.priceConfigBroken = (有效價格數 === 0);
  if (window.APP_CONFIG.priceConfigBroken) {
    console.error('價格設定全部為 0，已鎖定訂購入口');
  }
}

function renderOrderCardImages(data) {
  const middleCard = document.getElementById('order-middle-card');
  if (!middleCard) return;

  const img1Id = cfgGet(data, '訂購頁插圖ID_1') || '';
  const img2Id = cfgGet(data, '訂購頁插圖ID_2') || '';
  const cardText = cfgGet(data, '訂購頁插圖文字') || '';
  if (!img1Id && !img2Id && !cardText) return;

  middleCard.style.display = 'block';
  const img1 = document.getElementById('order-card-img1');
  if (img1 && img1Id) img1.src = resolveImageUrl(img1Id, 600);
  const img2 = document.getElementById('order-card-img2');
  if (img2 && img2Id) img2.src = resolveImageUrl(img2Id, 600);

  const textElement = document.getElementById('order-card-text');
  if (textElement && cardText) {
    textElement.innerText = cardText;
    textElement.style.display = 'block';
  }
}


// ========================================
// 🚦 開關（即時層）
// ========================================
function applySwitches(newOrderSwitch, newShipping) {
  orderSwitch = String(newOrderSwitch || '開').trim();
  shippingSwitch = {
    post:     String((newShipping && newShipping.post) || '').trim(),
    '711':    String((newShipping && newShipping['711']) || '').trim(),
    blackcat: String((newShipping && newShipping.blackcat) || '').trim()
  };

  const 設定配送選項 = (id, method, onText, offText) => {
    const el = document.getElementById(id);
    if (!el) return;
    const 開 = shippingSwitch[method] === '開';
    el.disabled = !開;
    el.textContent = 開 ? onText : offText;
  };
  設定配送選項('opt-post', 'post', '📫 中華郵政 (限重10斤內)', '📫 中華郵政（目前不支援）');
  設定配送選項('opt-711', '711', '🏪 7-11 超商取件 (限重7斤內)', '🏪 7-11（目前不支援）');
  設定配送選項('opt-blackcat', 'blackcat', '🐈\u200d⬛ 黑貓宅急便 (限重10斤內)', '🐈\u200d⬛ 黑貓宅急便（目前不支援）');

  updateEnterButton();
}

function updateEnterButton() {
  const btn = document.getElementById('order-enter-btn');
  if (!btn) return;

  const broken = window.APP_CONFIG && window.APP_CONFIG.priceConfigBroken;
  if (broken) {
    btn.classList.add('is-disabled');
    btn.innerText = '⚠️ 系統維護中';
  } else if (orderSwitch === '關') {
    btn.classList.add('is-disabled');
    btn.innerText = '🚫 現在暫停接單';
  } else {
    btn.classList.remove('is-disabled');
    btn.innerText = '✨ 我已同意，前往選購 👉';
  }
}


// ========================================
// 🕐 上架狀態 / 開賣倒數
// ========================================

// 🔑 D1 修正的核心。
// 舊版這個函式最後有一行 `RELEASE.lastKnown = isReleadNow()`，
// 而它會被快照輪詢每 8 秒呼叫一次。結果是：
// 如果輪詢剛好落在開賣的那一秒、且跑在 ticker 之前，
// lastKnown 會被搶先設成 true，ticker 的「狀態變化」偵測就永遠不會觸發
// → 商品不重新渲染、不彈開賣提示，客人卡在「未開賣」畫面直到手動重整。
//
// 現在 lastKnown 只由 ticker 更新，這個函式單純負責寫入時間戳。
function applyReleaseStatus(status) {
  const s = status || {};
  RELEASE.at = (s.releaseAt === null || s.releaseAt === undefined) ? null : Number(s.releaseAt);
  RELEASE.display = s.releaseTimeDisplay || s.releaseDisplay || '';
}

let releaseTickerTimer = null;

function startReleaseTicker() {
  if (releaseTickerTimer) return;
  releaseTickerTimer = setInterval(() => {
    const nowReleased = isReleasedNow();
    updateReleaseBanner();

    if (nowReleased !== RELEASE.lastKnown) {
      RELEASE.lastKnown = nowReleased;
      renderProductList();
      renderPriceMenu();
      if (nowReleased) {
        customAlert('🎉 開賣囉！商品已經可以選購，祝您順利下單～');
        refreshRealtime(); // 立刻抓一次最新庫存
      }
    }
  }, 1000);
}

function updateReleaseBanner() {
  const banner = document.getElementById('release-banner');
  if (!banner) return;

  if (RELEASE.at === null || isReleasedNow()) {
    banner.style.display = 'none';
    return;
  }

  const remain = Math.max(0, RELEASE.at - serverNow());
  const totalSec = Math.floor(remain / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = n => String(n).padStart(2, '0');

  const countdown = d > 0
    ? `${d} 天 ${pad(h)}:${pad(m)}:${pad(s)}`
    : `${pad(h)}:${pad(m)}:${pad(s)}`;

  banner.style.display = 'block';
  banner.innerHTML =
    `<div class="release-banner-title">🕐 ${RELEASE.display} 開賣</div>` +
    `<div class="release-banner-count">距離開賣還有 ${countdown}</div>` +
    `<div class="release-banner-hint">時間一到會自動開放，不需要重新整理</div>`;
}


// ========================================
// 🩺 快照新鮮度
// ========================================
function applySnapshotStamp(json) {
  const ms = Number(json.updatedAtMs || 0);
  const el = document.getElementById('stale-warning');
  if (!el) return;

  // 🔥 Firebase 連線中時，庫存與開關本來就是即時的，
  // 快照舊一點完全不影響客人，不需要嚇他們。
  if (firebaseLive) { el.style.display = 'none'; return; }

  if (!ms) { el.style.display = 'none'; return; }

  const ageMin = (serverNow() - ms) / 60000;
  if (ageMin > SNAPSHOT_STALE_MIN) {
    el.style.display = 'block';
    el.textContent = '⚠️ 庫存資訊可能不是最新的，下單前建議與我們確認';
    console.warn('快照已超過 ' + Math.round(ageMin) + ' 分鐘未更新');
  } else {
    el.style.display = 'none';
  }
}


// ========================================
// 🖼️ 填入頁面靜態文字
// ========================================
function applyConfigToPage(cfg) {
  const h = cfg['首頁'] || {};
  const 訂購 = cfg['訂購'] || {};

  const mainTitle = document.getElementById('main-title');
  if (mainTitle) mainTitle.textContent = cfgGet(h, '網頁大標題') || '波波酪梨';

  document.title = cfgGet(h, '分頁標題') || '波波酪梨｜線上訂購';

  const socialMap = {
    'social-line': cfgGet(h, 'LINE連結'),
    'social-ig':   cfgGet(h, 'IG連結'),
    'social-fb':   cfgGet(h, 'FB連結')
  };
  Object.keys(socialMap).forEach(id => {
    const el = document.getElementById(id);
    const url = (socialMap[id] || '').toString().trim();
    if (el && url) { el.href = url; el.style.display = 'flex'; }
  });

  const annTitle = document.getElementById('announcement-title');
  if (annTitle) annTitle.textContent = cfgGet(h, '公告區標題') || '最新公告';

  const annContent = document.getElementById('announcement-content');
  if (annContent) annContent.innerHTML = String(cfgGet(h, '公告內容') || '').replace(/\n/g, '<br>');

  const varietyTitle = document.getElementById('variety-title');
  if (varietyTitle) varietyTitle.textContent = cfgGet(h, '品種分頁大標題') || '我們的當季酪梨';

  const orderTitle = document.getElementById('order-title');
  if (orderTitle) orderTitle.textContent = cfgGet(h, '訂購分頁大標題') || '訂購資訊';

  const shippingNote = document.getElementById('shipping-note');
  if (shippingNote) shippingNote.textContent = cfgGet(訂購, '配送方式備註') || '';

  const lineBtn = document.getElementById('final-line-btn');
  if (lineBtn) lineBtn.textContent = cfgGet(cfg['匯款'], '跳轉按鈕名稱') || '確認匯款回報';

  const bannerId = cfgGet(h, '網頁頂部橫幅網址') || '';
  if (bannerId) {
    const bannerContainer = document.getElementById('banner-container');
    const bannerImg = document.getElementById('banner-img');
    if (bannerContainer && bannerImg) {
      bannerImg.src = resolveImageUrl(bannerId, 1000);
      bannerContainer.style.display = 'block';
    }
  }
}


// ========================================
// ⏳ 載入畫面
// ========================================
function showLoadingScreen(show) {
  let el = document.getElementById('loading-screen');
  if (show) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'loading-screen';
      el.innerHTML = `
        <style>
          @keyframes avoBounce {
            0%, 100% { transform: translateY(0) scale(1); }
            40% { transform: translateY(-30px) scale(1.1); }
            60% { transform: translateY(-15px) scale(1.05); }
          }
          @keyframes fadeInUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
          @keyframes dotPulse { 0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1.2); } }
          #loading-screen {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: linear-gradient(160deg, #e9edc9 0%, #d4e09b 100%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            z-index: 99999; transition: opacity 0.5s ease;
          }
          .avo-bounce { font-size: 5rem; animation: avoBounce 1s cubic-bezier(0.4,0,0.2,1) infinite; filter: drop-shadow(0 10px 8px rgba(0,0,0,0.15)); }
          .loading-brand { font-family: var(--heading-font); margin-top: 20px; font-size: 1.4rem; font-weight: 500; color: #576e37; letter-spacing: 4px; animation: fadeInUp 0.8s ease both; }
          .loading-sub { margin-top: 6px; font-size: 0.75rem; color: #76944a; letter-spacing: 3px; opacity: 0.8; animation: fadeInUp 0.8s ease 0.2s both; }
          .loading-dots { display: flex; gap: 6px; margin-top: 24px; animation: fadeInUp 0.8s ease 0.4s both; }
          .loading-dots span { width: 8px; height: 8px; background: #76944a; border-radius: 50%; animation: dotPulse 1.2s ease infinite; }
          .loading-dots span:nth-child(2) { animation-delay: 0.2s; }
          .loading-dots span:nth-child(3) { animation-delay: 0.4s; }
          .loading-msg { margin-top: 22px; font-size: 0.85rem; color: #576e37; letter-spacing: 1px; opacity: 0.85; min-height: 1.2em; transition: opacity 0.25s ease; text-align: center; padding: 0 20px; }
          .loading-msg.is-fading { opacity: 0; }
        </style>
        <div class="avo-bounce">🥑</div>
        <div class="loading-brand">波波酪梨</div>
        <div class="loading-sub">Pro-Bro Avo. | Earth to Table</div>
        <div class="loading-dots"><span></span><span></span><span></span></div>
        <div class="loading-msg" id="loading-msg"></div>
      `;
      document.body.appendChild(el);
    }
    el.style.opacity = '1';
    el.style.display = 'flex';
    startLoadingMessages();
  } else {
    stopLoadingMessages();
    if (el) {
      el.style.opacity = '0';
      setTimeout(() => { el.style.display = 'none'; }, 500);
    }
  }
}

const LOADING_MESSAGES = [
  '正在挑選當季酪梨…', '正在確認庫存…', '正在為您整理鮮採清單…', '馬上就好，稍等一下…',
  '正在打包新鮮好味道…', '正在秤重最飽滿的果實…', '正在檢查熟成度…', '正在整理今日出貨清單…',
  '陽光正在醞釀好滋味…', '正在幫酪梨做最後健檢…', '正在準備您的專屬箱子…', '南投的果園正在待命中…',
  '正在確認今日鮮採進度…', '正在挑出最漂亮的那一顆…', '正在規劃最新鮮的路線…', '小農們正在忙碌準備中…',
  '正在核對每一筆訂單細節…', '正在為酪梨穿上防護包裝…', '用心種植，用心送達…', '正在把幸福打包好…'
];
let loadingMsgTimer = null;

function shuffleLoadingMessages() {
  const arr = [...LOADING_MESSAGES];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startLoadingMessages() {
  const msgEl = document.getElementById('loading-msg');
  if (!msgEl || loadingMsgTimer) return;

  let queue = shuffleLoadingMessages();
  let index = 0;
  msgEl.textContent = queue[0];

  loadingMsgTimer = setInterval(() => {
    msgEl.classList.add('is-fading');
    setTimeout(() => {
      index++;
      if (index >= queue.length) { queue = shuffleLoadingMessages(); index = 0; }
      msgEl.textContent = queue[index];
      msgEl.classList.remove('is-fading');
    }, 280);
  }, 1700);
}

function stopLoadingMessages() {
  if (loadingMsgTimer) { clearInterval(loadingMsgTimer); loadingMsgTimer = null; }
}

function showLoadingError() {
  document.body.innerHTML = `
    <style>
      .load-error-screen { position: fixed; inset: 0; background: var(--creamy, #fefae0);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        text-align: center; padding: 30px; font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; z-index: 99999; }
      .load-error-icon { font-size: 3.2rem; margin-bottom: 14px; animation: loadErrorFloat 2.4s ease-in-out infinite; }
      @keyframes loadErrorFloat { 0%,100% { transform: translateY(0);} 50% { transform: translateY(-8px);} }
      .load-error-title { font-family: var(--heading-font, "Huninn", sans-serif); font-size: 1.3rem; font-weight: 500; color: var(--avo-dark, #576e37); margin-bottom: 10px; }
      .load-error-desc { font-size: 0.9rem; color: var(--avo-dark, #576e37); opacity: 0.85; line-height: 1.7; margin-bottom: 26px; max-width: 320px; }
      .load-error-btn { padding: 13px 32px; border-radius: 12px; border: none; background-color: var(--herb-green, #76944a);
        color: white; font-weight: 600; font-size: 0.95rem; letter-spacing: 1px; cursor: pointer; box-shadow: 0 4px 15px rgba(0,0,0,0.08); }
    </style>
    <div class="load-error-screen">
      <div class="load-error-icon">🥑💤</div>
      <div class="load-error-title">酪梨園連線不太順</div>
      <div class="load-error-desc">
        可能是網路暫時不穩定，或伺服器正在忙碌中，<br>
        我們已經自動重試了幾次，但還是沒能連上。<br>
        稍等一下再試一次，通常就會恢復囉！
      </div>
      <button class="load-error-btn" onclick="location.reload()">🔄 重新整理</button>
    </div>
  `;
}


// ========================================
// 🧭 分頁切換
// ========================================
function goToStep(step) {
  document.querySelectorAll('.page-content').forEach(p => { p.style.display = 'none'; });

  const pageMap = {
    1: 'step1-announcement', 2: 'step2-varieties', 3: 'step3-price-list',
    4: 'step4-order-form', 5: 'step5-payment-info'
  };
  const targetPage = document.getElementById(pageMap[step]);
  if (targetPage) targetPage.style.display = 'block';

  if (step === 5) {
    renderSuccessPage();
    setTimeout(() => {
      const card = document.querySelector('#step5-payment-info .info-block');
      if (card) card.classList.add('success-animate');
    }, 100);
    setTimeout(fireConfetti, 200);
  }
  if (step === 3) renderPriceMenu();
  if (step === 4) {
    renderProductList();
    updateAddressSection();
    calculateCartTotal();
  }

  window.scrollTo(0, 0);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#cust-name, #cust-phone, #delivery-address, #order-note').forEach(field => {
    field.addEventListener('blur', () => {
      if (field.value.trim() !== '') {
        field.classList.add('input-completed');
        setTimeout(() => field.classList.remove('input-completed'), 600);
      }
    });
  });

  const floatingCart = document.getElementById('floating-cart');
  const cartHandle = document.getElementById('floating-cart-handle');
  let isOpen = false;
  if (floatingCart && cartHandle) {
    cartHandle.addEventListener('click', (e) => {
      isOpen = !isOpen;
      floatingCart.classList.toggle('show', isOpen);
      e.stopPropagation();
    });
    cartHandle.addEventListener('touchstart', (e) => e.stopPropagation());
  }
});


// ========================================
// 🛒 商品清單
// ========================================
function renderProductList() {
  const container = document.getElementById('product-list-container');
  if (!container) return;

  const cfg = (window.APP_CONFIG && window.APP_CONFIG.orderConfig) || {};
  const stockMap = (window.APP_CONFIG && window.APP_CONFIG.stockMap) || {};
  const released = isReleasedNow();

  let html = '';
  商品分類.forEach(cat => {
    const 單價 = cfgNum(cfg, cat.priceKey);
    const 非產季 = 單價 <= 0;
    const displayName = displayNameMap[cat.name] || cat.name;
    html += `<div class="product-group-label">🥑 ${displayName}</div>`;

    cat.weights.forEach(w => {
      const key = stockKeyOf(cat.name, w);
      const availableStock = stockMap[key] || 0;
      const displayPrice = 單價 * w;
      const currentQty = (cart[key] && cart[key].qty) || 0;
      const remaining = Math.max(0, availableStock - currentQty);

      // 🌱 單價為 0 = 非產季未販售：保留品項讓客人知道有這個品種，但不顯示金額
      if (非產季) {
        html += `
          <div class="price-row">
            <div class="price-col weight">${w} 斤裝</div>
            <div class="price-col stock unreleased-badge">🌱 非產季</div>
          </div>`;
        return;
      }

      if (!released) {
        html += `
          <div class="price-row">
            <div class="price-col weight">${w} 斤裝 <span>($${displayPrice})</span></div>
            <div class="price-col stock unreleased-badge" id="stock-${key}">⏳ 未開賣</div>
          </div>`;
        return;
      }

      html += `
        <div class="price-row">
          <div class="price-col weight">${w} 斤裝 <span>($${displayPrice})</span></div>
          <div class="price-col stock" id="stock-${key}">剩 ${remaining}</div>
          <div class="price-col action">
            <div class="qty-control">
              <button onclick="updateCart('${key}', -1, ${w}, '${displayName}')" class="btn-qty">-</button>
              <span id="qty-${key}" class="qty-num">${currentQty}</span>
              <button id="plus-${key}" onclick="updateCart('${key}', 1, ${w}, '${displayName}')" class="btn-qty" ${remaining <= 0 ? 'disabled' : ''}>+</button>
            </div>
          </div>
        </div>`;
    });
  });

  container.innerHTML = html;
}

function renderPriceMenu() {
  const container = document.getElementById('price-menu-container');
  if (!container) return;

  const cfg = (window.APP_CONFIG && window.APP_CONFIG.orderConfig) || {};
  const released = isReleasedNow();

  const 區塊 = (title, 優級, 次級) => {
    const 列 = cat => {
      const 單價 = cfgNum(cfg, cat.priceKey);

      // 🌱 單價為 0 = 非產季未販售：不顯示金額，只標示狀態
      if (單價 <= 0) {
        return cat.weights.map(w => `<div class="price-row">
          <div class="price-col weight">${w} 斤裝</div>
          <div class="price-col amount">—</div>
          <div class="price-col stock unreleased-badge">🌱 非產季</div>
        </div>`).join('');
      }

      return cat.weights.map(w => {
        const key = stockKeyOf(cat.name, w);
        return `<div class="price-row">
          <div class="price-col weight">${w} 斤裝</div>
          <div class="price-col amount">$${單價 * w}</div>
          <div class="price-col stock" id="pm-stock-${key}">${priceMenuStockText(key, released)}</div>
        </div>`;
      }).join('');
    };

    return `
      <div class="info-block price-info">
        <h3 class="price-title">${title}</h3>
        <div class="product-divider"></div>
        <h4 class="price-subtitle">．優級．</h4>
        <div class="price-divider">✦ ✦ ✦</div>
        ${列(優級)}
        <div style="height:26px;"></div>
        <h4 class="price-subtitle">．次級．</h4>
        <div class="price-divider">✦ ✦ ✦</div>
        ${列(次級)}
      </div>`;
  };

  container.innerHTML =
    區塊('🥑 當季酪梨', 商品分類[0], 商品分類[1]) +
    區塊('🥑 平克頓 & 哈斯', 商品分類[2], 商品分類[3]);

  const 設 = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.innerText = cfgNum(cfg, key);
  };
  設('ship-post-small', '郵寄七斤(不含)以下');
  設('ship-post-large', '郵寄七斤(包含)以上');
  設('ship-711', '711運費');
  設('ship-blackcat-small', '黑貓配送七斤(不含)以下');
  設('ship-blackcat-large', '黑貓配送七斤(包含)以上');
  設('ship-post-island-small', '郵寄離島七斤(不含)以下');
  設('ship-post-island-large', '郵寄離島七斤(包含)以上');
  設('ship-blackcat-island-small', '黑貓配送離島七斤(不含)以下');
  設('ship-blackcat-island-large', '黑貓配送離島七斤(包含)以上');
}

function priceMenuStockText(key, released) {
  const cfg = (window.APP_CONFIG && window.APP_CONFIG.orderConfig) || {};
  const cat = 商品分類.find(c => c.weights.some(w => stockKeyOf(c.name, w) === key));
  if (cat && cfgNum(cfg, cat.priceKey) <= 0) return '🌱 非產季';

  if (!released) return '⏳ 未開賣';

  const stockMap = (window.APP_CONFIG && window.APP_CONFIG.stockMap) || {};
  const count = Math.max(0, (stockMap[key] || 0) - ((cart[key] && cart[key].qty) || 0));
  return count > 0 ? `（剩 ${count} 份）` : '（售罄）';
}


// ========================================
// 🛒 購物車
// ========================================
function updateCart(key, deltaQty, weight, displayName) {
  if (!cart[key] && deltaQty <= 0) return;

  if (!isReleasedNow()) {
    customAlert('⏳ 商品尚未開賣，請稍候一下～');
    return;
  }

  const method = document.getElementById('shipping-method').value;
  if (!method) {
    customAlert('☝️ 請先選擇「1. 配送方式」，\n才能開始挑選規格喔！');
    return;
  }

  const currentQty = (cart[key] && cart[key].qty) || 0;
  const newQty = currentQty + deltaQty;
  if (newQty < 0) return;

  const availableStock = (window.APP_CONFIG.stockMap || {})[key] || 0;
  if (deltaQty > 0 && newQty > availableStock) {
    customAlert(`❌ 庫存只剩 ${availableStock} 份喔！`);
    return;
  }

  const prevQty = currentQty;
  const unitPrice = 價格表[stockKeyMap[displayName] || displayName] || 0;

  if (newQty === 0) delete cart[key];
  else cart[key] = { displayName, weight, qty: newQty, subtotal: unitPrice * weight * newQty };

  recalcTotalWeight();

  const limit = 限重表[method];
  if (limit && totalWeight > limit) {
    customAlert(`❌ ${配送名稱[method]}配送總重不能超過${limit}斤喔！`);
    if (prevQty === 0) delete cart[key];
    else cart[key] = { displayName, weight, qty: prevQty, subtotal: unitPrice * weight * prevQty };
    recalcTotalWeight();
  }

  refreshCartUI();
}

function refreshCartUI() {
  Object.keys(cart).forEach(key => {
    const item = cart[key];
    const unitPrice = 價格表[stockKeyMap[item.displayName] || item.displayName] || 0;
    item.subtotal = unitPrice * item.weight * item.qty;
  });
  updateStockDisplay();
  calculateCartTotal();
  updateFloatingCart();
}

// ⚡ 只更新數字與按鈕狀態，不重建整塊 innerHTML。
function updateStockDisplay() {
  const stockMap = (window.APP_CONFIG && window.APP_CONFIG.stockMap) || {};
  const released = isReleasedNow();

  商品分類.forEach(cat => {
    cat.weights.forEach(w => {
      const key = stockKeyOf(cat.name, w);
      const usedQty = (cart[key] && cart[key].qty) || 0;
      const remaining = Math.max(0, (stockMap[key] || 0) - usedQty);

      const qtyEl = document.getElementById('qty-' + key);
      if (qtyEl) qtyEl.innerText = usedQty;

      const stockEl = document.getElementById('stock-' + key);
      if (stockEl && released) stockEl.innerText = `剩 ${remaining}`;

      const plusBtn = document.getElementById('plus-' + key);
      if (plusBtn) plusBtn.disabled = remaining <= 0;

      const pmEl = document.getElementById('pm-stock-' + key);
      if (pmEl) pmEl.innerText = priceMenuStockText(key, released);
    });
  });
}

// 庫存被別人買走時，自動把購物車修正到還買得到的數量
function trimCartToStock() {
  const stockMap = (window.APP_CONFIG && window.APP_CONFIG.stockMap) || {};
  const 調整 = [];

  Object.keys(cart).forEach(key => {
    const avail = stockMap[key] || 0;
    const item = cart[key];
    if (item.qty > avail) {
      調整.push(`${item.displayName} ${item.weight}斤：${item.qty} → ${avail}`);
      if (avail <= 0) delete cart[key];
      else item.qty = avail;
    }
  });

  if (調整.length === 0) return false;

  recalcTotalWeight();
  refreshCartUI();
  if (!isSubmitting) {
    customAlert('⚠️ 有品項剛好被其他客人買走，已為您自動調整購物車：\n\n' + 調整.join('\n'));
  }
  return true;
}

function handleShippingChange() {
  const method = document.getElementById('shipping-method').value;
  recalcTotalWeight();

  if (Object.keys(cart).length > 0) {
    const limit = 限重表[method];
    if (limit && totalWeight > limit) {
      customAlert(`⚠️ ${配送名稱[method]} 限重 ${limit} 斤，目前已超過！請減少品項。`);
    }
  }

  calculateCartTotal();
  updateAddressSection();
}

function calculateCartTotal() {
  recalcTotalWeight();
  const method = document.getElementById('shipping-method').value;

  let subtotal = 0;
  Object.values(cart).forEach(k => { subtotal += k.subtotal; });

  const countyEl = document.getElementById('county');
  const districtEl = document.getElementById('district');
  const isIsland = (method === 'post' || method === 'blackcat')
    && isIslandAddress(countyEl ? countyEl.value : '', districtEl ? districtEl.value : '');

  const islandHint = document.getElementById('island-shipping-hint');
  if (islandHint) islandHint.style.display = isIsland ? 'block' : 'none';

  let shippingFee = 0;
  if (method === 'post') {
    shippingFee = isIsland
      ? (totalWeight < 7 ? 運費表.郵寄離島小 : 運費表.郵寄離島大)
      : (totalWeight < 7 ? 運費表.郵寄小 : 運費表.郵寄大);
  } else if (method === '711') {
    shippingFee = 運費表['711運費'];
  } else if (method === 'blackcat') {
    shippingFee = isIsland
      ? (totalWeight < 7 ? 運費表.黑貓離島小 : 運費表.黑貓離島大)
      : (totalWeight < 7 ? 運費表.黑貓小 : 運費表.黑貓大);
  }

  finalSubtotal = subtotal;
  finalShippingFee = shippingFee;
  finalTotal = subtotal + shippingFee;
  updateFloatingCart();
}

function recalcTotalWeight() {
  totalWeight = Object.values(cart).reduce((sum, item) => sum + item.qty * item.weight, 0);
}

function updateFloatingCart() {
  const container = document.getElementById('floating-cart-items');
  if (!container) return;

  container.innerHTML = '';
  const visibleItems = Object.values(cart).filter(item => item.qty > 0);

  visibleItems.forEach(item => {
    const div = document.createElement('div');
    div.className = 'floating-cart-item';
    div.innerHTML = `<span class="item-name">${item.displayName} ${item.weight}斤</span>` +
                    `<span class="item-qty">x${item.qty}</span>` +
                    `<span class="item-subtotal">$${item.subtotal}</span>`;
    container.appendChild(div);
  });

  if (visibleItems.length === 0) {
    container.innerHTML = '<div style="text-align:center; color:#888;">購物車空空如也</div>';
  }

  document.getElementById('floating-subtotal').innerHTML = `<span class="label">小計：</span><span class="amount">$${finalSubtotal}</span>`;
  document.getElementById('floating-shipping').innerHTML = `<span class="label">運費：</span><span class="amount">$${finalShippingFee}</span>`;
  document.getElementById('floating-total').innerHTML = `<span class="label">總計：</span><span class="amount">$${finalTotal}</span>`;
}


// ========================================
// 🥑 品種頁
// ========================================
function renderVarieties() {
  const container = document.getElementById('varieties-container');
  if (!container) return;

  const data = window.allVarieties || (window.APP_CONFIG && window.APP_CONFIG.varieties) || [];
  if (data.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--avo-dark); padding:20px;">目前尚無當季品種資訊。🥑</p>';
    return;
  }

  container.innerHTML = data.map(v => {
    const imgSrc = resolveImageUrl(v.img, 900);
    return `
      <div class="info-block">
        ${imgSrc ? `<div class="variety-images"><img src="${imgSrc}" class="avocado-img" loading="lazy" onclick="showLightbox('${imgSrc}')"></div>` : ''}
        <h3 class="variety-title">${v.name}</h3>
        <div class="product-divider"></div>
        <p style="white-space:pre-wrap;">${v.feature || ''}</p>
      </div>`;
  }).join('');
}


// ========================================
// 🏠 地址選單
// ========================================
function initAddressSelector() {
  const countySelect = document.getElementById('county');
  const districtSelect = document.getElementById('district');
  const zipInput = document.getElementById('zipcode');
  if (!countySelect || !districtSelect || !zipInput) return;

  const addressMap = (window.APP_CONFIG && window.APP_CONFIG.addressMap) || {};
  if (Object.keys(addressMap).length === 0) {
    countySelect.innerHTML = '<option value="">⚠️ 地址資料載入失敗，請重新整理再試</option>';
    return;
  }

  countySelect.innerHTML = '<option value="">縣市</option>';
  districtSelect.innerHTML = '<option value="">區域</option>';
  Object.keys(addressMap).forEach(county => countySelect.add(new Option(county, county)));

  countySelect.addEventListener('change', () => {
    districtSelect.innerHTML = '<option value="">區域</option>';
    zipInput.value = '';
    const districts = addressMap[countySelect.value];
    if (districts) {
      Object.keys(districts).forEach(d => districtSelect.add(new Option(d, d)));
      districtSelect.disabled = false;
    } else {
      districtSelect.disabled = true;
    }
    calculateCartTotal();
  });

  districtSelect.addEventListener('change', () => {
    const m = addressMap[countySelect.value];
    zipInput.value = (m && m[districtSelect.value]) || '';
    calculateCartTotal();
  });
}

function initShippingAddressToggle() {
  const shippingEl = document.getElementById('shipping-method');
  if (!shippingEl) return;
  shippingEl.addEventListener('change', handleShippingChange);
  updateAddressSection();
}

function updateAddressSection() {
  const method = document.getElementById('shipping-method').value;
  const postSection = document.getElementById('post-address-section');
  const storeSection = document.getElementById('store-address-section');
  if (!postSection || !storeSection) return;

  postSection.style.display = (method === 'post' || method === 'blackcat') ? 'block' : 'none';
  storeSection.style.display = (method === '711') ? 'block' : 'none';
}


// ========================================
// 🔄 背景更新（靜態層）
// ========================================
let stockRefreshTimer = null;
let currentPollMs = 0;

function setPollInterval(ms) {
  if (currentPollMs === ms && stockRefreshTimer) return;
  if (stockRefreshTimer) clearInterval(stockRefreshTimer);
  currentPollMs = ms;
  stockRefreshTimer = setInterval(refreshFromSnapshot, ms);
}

function startStockAutoRefresh() {
  // 先用快輪詢起步；Firebase 一旦連上就自動降頻
  setPollInterval(POLL_MS_FAST);
}

async function refreshFromSnapshot() {
  if (isSubmitting) return; // 送單當下不要動畫面
  try {
    const json = await fetchSnapshot(CONFIG_JSON_URL);

    // ⚡ 內容比對：沒變就完全不碰 DOM，省下每次的重繪
    const stamp = json.updatedAtMs || json.updatedAt;
    if (stamp && stamp === lastSnapshotStamp) return;
    lastSnapshotStamp = stamp;

    applySnapshotStamp(json);

    // 🔑 A2：靜態層（價格、運費、公告、品種）每次都套用，不再凍在載入那一刻。
    const 舊價格 = JSON.stringify(價格表);
    applyStaticTables(json.data['訂購'] || {});
    window.allVarieties = json.data['品種'] || [];
    window.paymentConfig = json.data['匯款'] || {};
    applyConfigToPage(json.data);

    const 價格有變 = JSON.stringify(價格表) !== 舊價格;
    if (價格有變) {
      refreshCartUI();
      renderPriceMenu();
      renderProductList();
      if (Object.keys(cart).length > 0) {
        customAlert('ℹ️ 商品價格剛剛更新了，已為您重新計算金額，請確認後再送出。');
      }
    }

    // 🔥 Firebase 連線中時，即時層以推播為準。
    // 快照上的庫存與開關可能已經落後 1~2 分鐘，套用它反而會讓數字倒退回舊值。
    if (!firebaseLive) {
      applyReleaseStatus(json.data['上架狀態']);
      applySwitches(
        cfgGet(json.data['首頁'], '訂單開關') || '開',
        {
          post:     cfgGet(json.data['訂購'], '中華郵政配送'),
          '711':    cfgGet(json.data['訂購'], '7-11超取配送'),
          blackcat: cfgGet(json.data['訂購'], '黑貓配送')
        }
      );
      applyLatestStockMap(json.data['庫存'] || {});
    }
  } catch (err) {
    // 背景更新失敗就安靜跳過，下一輪再試
  }
}

// 立刻抓一次即時層（開賣瞬間、送單失敗後使用）
async function refreshRealtime() {
  try {
    const control = await fetchControlViaRest();
    applyControl(control);
  } catch (err) {
    // REST 也失敗就退回快照
    refreshFromSnapshot();
  }
}


// ========================================
// 🔥 Firebase 即時控制節點訂閱
// ========================================
function initFirebaseControl() {
  if (typeof firebase === 'undefined' || !FIREBASE_DB_URL) {
    console.warn('Firebase SDK 未載入，即時層改用輪詢快照');
    return;
  }

  try {
    firebase.initializeApp({ databaseURL: FIREBASE_DB_URL });
    const db = firebase.database();

    // 連線狀態：斷線時自動切回快輪詢，重連後再降頻。
    // .info/connected 是 SDK 的本地狀態，不受安全規則限制。
    db.ref('.info/connected').on('value', snap => {
      const connected = !!snap.val();
      if (connected === firebaseLive) return;

      firebaseLive = connected;
      setPollInterval(connected ? POLL_MS_SLOW : POLL_MS_FAST);
      console.info(connected
        ? '🔥 Firebase 已連線，即時層改為推播'
        : '⚠️ Firebase 連線中斷，即時層暫時改用輪詢');

      // 剛斷線時立刻補抓一次，不要空等一輪
      if (!connected) refreshRealtime();
    });

    // 控制節點推播：庫存 + 上架時間 + 各種開關，單一原子更新
    db.ref(FIREBASE_CONTROL_PATH).on('value', snap => {
      const v = snap.val();
      if (!v) return;
      applyControl(v);
    }, err => {
      console.warn('Firebase 控制節點訂閱失敗，改用輪詢快照', err);
      firebaseLive = false;
      setPollInterval(POLL_MS_FAST);
    });

  } catch (err) {
    console.warn('Firebase 初始化失敗，即時層改用輪詢快照', err);
    firebaseLive = false;
    setPollInterval(POLL_MS_FAST);
  }
}

// 套用一份即時層資料（來自 Firebase 推播或 REST 備援）
function applyControl(control) {
  if (!control || !control.json) return;

  // 🔑 A1：新鮮度比對。
  // dataAt 是「這份資料何時從試算表讀出來」，不是「何時送到」。
  // 網路亂序時先到的不一定比較新，只認 dataAt。
  const dataAt = Number(control.dataAt || 0);
  if (dataAt && dataAt <= lastControlDataAt) {
    console.debug('收到較舊的控制資料，已忽略', dataAt, '<=', lastControlDataAt);
    return;
  }

  // 🔑 D3：送單期間先暫存，送完再套用，避免中途改動購物車讓畫面跳動。
  // 暫存也要比新鮮度：送單期間可能連收到好幾筆，後到的不一定比較新。
  if (isSubmitting) {
    if (!pendingControl || dataAt > Number(pendingControl.dataAt || 0)) {
      pendingControl = control;
    }
    return;
  }

  if (dataAt) lastControlDataAt = dataAt;

  let stockMap;
  try {
    stockMap = JSON.parse(control.json);
  } catch (parseErr) {
    console.warn('控制節點庫存格式解析失敗', parseErr);
    return;
  }

  // 上架時間
  const 舊開賣狀態 = isReleasedNow();
  applyReleaseStatus({
    releaseAt: control.releaseAt === undefined ? null : control.releaseAt,
    releaseDisplay: control.releaseDisplay || ''
  });
  // 如果你臨時改了開賣時間、而且改完當下狀態就不一樣了，
  // 這裡先重繪一次；持續的狀態轉換仍然交給 ticker。
  if (isReleasedNow() !== 舊開賣狀態) {
    renderProductList();
    renderPriceMenu();
  }
  updateReleaseBanner();

  // 開關
  applySwitches(control.orderSwitch, control.shipping);

  // 庫存
  applyLatestStockMap(stockMap);

  // Firebase 活著時不需要快照過期提示
  const staleEl = document.getElementById('stale-warning');
  if (staleEl && firebaseLive) staleEl.style.display = 'none';
}

// 把暫存的推播套用掉（送單流程結束時呼叫）
function flushPendingControl() {
  if (!pendingControl) return;
  const c = pendingControl;
  pendingControl = null;
  applyControl(c);
}

function applyLatestStockMap(rawStock) {
  const newStockMap = {};
  Object.keys(rawStock || {}).forEach(k => {
    newStockMap[normKey(k)] = Math.max(0, Number(rawStock[k]) || 0);
  });
  window.APP_CONFIG.stockMap = newStockMap;

  trimCartToStock();
  updateStockDisplay();
  calculateCartTotal();
}


// ========================================
// 📬 送出訂單
// ========================================
function handleOrderEnter() {
  if (window.APP_CONFIG && window.APP_CONFIG.priceConfigBroken) {
    customAlert('⚠️ 系統設定正在維護中，暫時無法訂購，造成不便敬請見諒。');
    return;
  }
  if (orderSwitch === '關') {
    customAlert('目前為停止採收期，暫停接單中 🌱\n\n我們會於開放時第一時間公告，感謝您的體諒！');
    return;
  }
  goToStep(2);
}

// 電話容錯：客人常常會填 0912-345-678 或帶空格
function normalizePhone(raw) {
  return String(raw || '').replace(/[\s\-()+.]/g, '');
}

async function submitOrder(e) {
  if (e) e.preventDefault();
  if (isSubmitting) return;

  const nEl = document.getElementById('cust-name');
  const pEl = document.getElementById('cust-phone');
  const submitBtn = document.getElementById('submit-btn');
  const countyEl = document.getElementById('county');
  const districtEl = document.getElementById('district');
  const zipcodeEl = document.getElementById('zipcode');
  const addressDetailEl = document.getElementById('delivery-address');
  const storeEl = document.getElementById('store-name');
  const orderNoteEl = document.getElementById('order-note');

  if (!nEl || !pEl || !submitBtn) {
    customAlert('⚠️ 找不到必填欄位，請確認訂購頁已正確顯示！');
    return;
  }

  if (!isReleasedNow()) {
    customAlert(`⏳ 商品尚未開賣（${RELEASE.display} 開放），請稍候～`);
    return;
  }

  if (Object.keys(cart).length === 0 || totalWeight <= 0) {
    customAlert('☝️ 購物車還是空的，請挑選規格！');
    return;
  }

  const n = nEl.value.trim();
  const p = normalizePhone(pEl.value);
  const shippingMethodEl = document.getElementById('shipping-method');
  const shippingMethod = shippingMethodEl ? shippingMethodEl.value : '';

  if (!n || !p) { customAlert('☝️請填寫收件人姓名與電話！'); return; }
  if (n.length > 40) { customAlert('☝️ 姓名長度超過限制，請確認填寫內容'); return; }
  if (!/^09\d{8}$/.test(p)) {
    customAlert('☝️ 請填寫正確的手機號碼格式！\n例如：0912345678\n（超商取貨與宅配都需要手機才能收到通知）');
    return;
  }
  pEl.value = p;

  let fullAddress = '';
  if (shippingMethod === 'post' || shippingMethod === 'blackcat') {
    if (!countyEl.value || !districtEl.value) {
      countyEl.classList.add('address-error');
      districtEl.classList.add('address-error');
      const hint = document.getElementById('address-error-hint');
      if (hint) hint.style.display = 'block';
      countyEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!addressDetailEl.value.trim()) { customAlert('☝️請填寫完整宅配地址！'); return; }

    countyEl.classList.remove('address-error');
    districtEl.classList.remove('address-error');
    const hint = document.getElementById('address-error-hint');
    if (hint) hint.style.display = 'none';

    fullAddress = `${zipcodeEl.value || ''} ${countyEl.value}${districtEl.value}${addressDetailEl.value.trim()}`;
  } else if (shippingMethod === '711') {
    if (!storeEl || !storeEl.value.trim()) {
      customAlert('☝️請填寫 7-11 門市名稱！');
      if (storeEl) storeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    fullAddress = `7-11 門市：${storeEl.value.trim()}`;
  } else {
    customAlert('☝️請選擇配送方式！');
    return;
  }

  if (fullAddress.length > 120) { customAlert('☝️ 地址長度超過限制，請簡化填寫內容'); return; }

  recalcTotalWeight();
  const weightLimit = 限重表[shippingMethod];
  if (weightLimit && totalWeight > weightLimit) {
    customAlert(`❌ 目前購物車總重 ${totalWeight} 斤，已超過「${配送名稱[shippingMethod]}」限重 ${weightLimit} 斤，請調整購買數量或改選其他配送方式！`);
    return;
  }

  isSubmitting = true;
  submitBtn.innerText = '確認庫存中...';
  submitBtn.disabled = true;

  const 收尾 = () => {
    isSubmitting = false;
    submitBtn.disabled = false;
    submitBtn.innerText = '✅ 確認訂購';
    flushPendingControl(); // 把送單期間暫存的推播套用掉
  };

  // 送出前先校對一次庫存，避免客人白等 GAS
  const stockCheck = await verifyStockBeforeSubmit();
  if (!stockCheck.ok) {
    const lines = stockCheck.shortages.map(s =>
      `「${s.displayName} ${s.weight}斤」目前只剩 ${s.avail} 份（您選了 ${s.need} 份）`);
    isSubmitting = false;
    trimCartToStock();
    customAlert('⚠️ 不好意思，部分品項庫存剛好有異動：\n\n' + lines.join('\n') + '\n\n已為您自動調整購物車，請確認後再送出一次');
    收尾();
    return;
  }

  submitBtn.innerText = '處理中...';
  calculateCartTotal();

  // 🔁 同一筆訂單的重試共用同一組 orderKey。
  // 逾時情境下客人如果重按送出，後端會辨識出是同一筆、直接回傳成功，
  // 不會產生第二筆真訂單、也不會重複扣庫存。
  if (!currentOrderKey) currentOrderKey = makeOrderKey();

  const orderData = {
    orderKey: currentOrderKey,
    cart,
    subtotal: finalSubtotal,
    shippingMethod,
    shipping: fullAddress,
    shippingFee: finalShippingFee,
    total: finalTotal,
    name: n,
    phone: p,
    address: fullAddress,
    note: orderNoteEl ? orderNoteEl.value : '',
    weight: Object.values(cart).map(i => `${i.displayName} ${i.weight} 斤 x${i.qty}`).join('，'),
    county: countyEl ? countyEl.value : '',
    district: districtEl ? districtEl.value : ''
  };

  currentOrderSummary = orderData;

  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(orderData)
    });

    // 尖峰擁擠或 Google 端逾時時，有機會回傳一頁 HTML 錯誤頁而不是 JSON。
    // 這種情況下訂單「有可能已經寫入成功」，不能直接跟客人說失敗。
    const rawText = await res.text();
    let json;
    try { json = JSON.parse(rawText); }
    catch (parseErr) { throw new Error('SERVER_TIMEOUT_NON_JSON'); }

    if (!json.success) throw new Error(json.error || '送單失敗');

    // 🔑 A2：成功頁改用後端實際成交的金額。
    // 舊版顯示的是前端自己算的數字，一旦你在客人開著頁面時改了價格，
    // 成功頁跟試算表、PDF 就會對不起來，而且不會有任何人發現。
    if (json.totals) {
      finalSubtotal    = Number(json.totals.subtotal);
      finalShippingFee = Number(json.totals.shippingFee);
      finalTotal       = Number(json.totals.total);
      currentOrderSummary.subtotal    = finalSubtotal;
      currentOrderSummary.shippingFee = finalShippingFee;
      currentOrderSummary.total       = finalTotal;
    }

    // 本地先扣一次，避免回價目表看到舊數字（Firebase 推播通常 1 秒內就會蓋掉它）
    const stockMap = window.APP_CONFIG.stockMap || {};
    Object.keys(cart).forEach(key => {
      if (stockMap[key] !== undefined) stockMap[key] = Math.max(0, stockMap[key] - cart[key].qty);
    });

    cart = {};
    totalWeight = 0;
    currentOrderKey = null; // 這筆已完成，下一筆要用新的識別碼

    收尾();
    goToStep(5);

  } catch (err) {
    if (err.message === 'SERVER_TIMEOUT_NON_JSON') {
      // ⚠️ 這裡刻意「不」清掉 currentOrderKey：
      // 客人如果再按一次，後端會用同一組識別碼辨識出是同一筆，直接回成功。
      customAlert('⚠️ 系統回應較慢，暫時無法確認結果。\n\n您可以「再按一次確認訂購」，系統會自動辨識、不會重複下單。\n若仍然失敗，請透過 LINE 或電話與我們確認，謝謝您的耐心 🙏');
    } else {
      currentOrderKey = null; // 這是明確的失敗（例如庫存不足），下次是新的一筆
      customAlert(err.message || '送單失敗，請稍後再試');
      refreshRealtime();
    }
    收尾();
  }
}

function 比對購物車庫存(latest) {
  const shortages = [];
  Object.keys(cart).forEach(key => {
    const need = cart[key].qty;
    const avail = latest[key] !== undefined ? latest[key] : 0;
    if (avail < need) {
      shortages.push({ displayName: cart[key].displayName, weight: cart[key].weight, need, avail });
    }
  });
  return { ok: shortages.length === 0, shortages };
}

async function verifyStockBeforeSubmit() {
  // 🔥 Firebase 連線中時，畫面上的庫存本來就在 1 秒內同步，
  // 不用再多打一次快照（那份反而還比較舊）。直接拿現有的比對就好。
  //
  // 這一層在秒殺時特別重要：庫存歸零後的送單會被擋在瀏覽器裡，
  // 不會變成一次 GAS 執行 —— 這是保護後端同時執行數最有效的一道。
  if (firebaseLive) {
    return 比對購物車庫存((window.APP_CONFIG && window.APP_CONFIG.stockMap) || {});
  }

  try {
    const control = await fetchControlViaRest();
    const rawStock = JSON.parse(control.json);
    const latest = {};
    Object.keys(rawStock).forEach(k => { latest[normKey(k)] = Math.max(0, Number(rawStock[k]) || 0); });
    window.APP_CONFIG.stockMap = latest;
    return 比對購物車庫存(latest);
  } catch (err) {
    // 校對本身出錯（網路不穩）不要卡住客人，交給 GAS 做最終核對
    return { ok: true };
  }
}


// ========================================
// ✅ 成功頁
// ========================================
function renderSuccessPage() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val || ''; };
  set('bank-val', window.APP_CONFIG.bankName);
  set('account-val', window.APP_CONFIG.bankAcc);
  set('name-val', window.APP_CONFIG.bankUser);
  set('lp-announcement', window.APP_CONFIG.linePayMsg);

  if (window.APP_CONFIG.linePayImgId) {
    const qr = document.getElementById('lp-qrcode');
    if (qr) qr.src = resolveImageUrl(window.APP_CONFIG.linePayImgId, 500);
  }

  set('final-amount-display', '$' + finalTotal + ' 元');

  if (!currentOrderSummary) return;
  const o = currentOrderSummary;

  document.getElementById('order-summary-content').innerHTML = `
    <div class="order-summary-list">
      <div class="order-summary-row"><span class="label">📦 規格細項</span><span class="value js-summary-weight"></span></div>
      <div class="order-summary-row"><span class="label">🚚 配送方式</span><span class="value js-summary-shipping"></span></div>
      <div class="order-summary-row"><span class="label">🏠 收件地址(門市)</span><span class="value js-summary-address"></span></div>
      <div class="order-summary-row"><span class="label">💰 商品小計</span><span class="value">$${o.subtotal}</span></div>
      <div class="order-summary-row"><span class="label">🚛 運費</span><span class="value">$${o.shippingFee}</span></div>
    </div>`;

  const weightContainer = document.querySelector('.js-summary-weight');
  if (weightContainer) {
    weightContainer.innerHTML = String(o.weight || '').split('，').map(i => `<div>${i}</div>`).join('');
  }

  const shippingEl = document.querySelector('.js-summary-shipping');
  if (shippingEl) shippingEl.textContent = 配送顯示名[o.shippingMethod] || '';

  const addressEl = document.querySelector('.js-summary-address');
  if (addressEl) addressEl.textContent = o.shipping || o.address || '';

  const rawMsg = window.APP_CONFIG.successMsg || '謝謝您支持，下單成功！';
  document.getElementById('success-reminder-msg').innerHTML = `<div class="success-warm-text">${rawMsg}</div>`;
}


// ========================================
// 🔧 通用工具
// ========================================
function customAlert(msg) {
  const overlay = document.getElementById('custom-alert-overlay');
  const msgText = document.getElementById('alert-message');
  if (overlay && msgText) { msgText.innerText = msg; overlay.style.display = 'flex'; }
}

function closeAlert() {
  const el = document.getElementById('custom-alert-overlay');
  if (el) el.style.display = 'none';
}

function showLightbox(s) {
  document.getElementById('lightbox-img').src = s;
  document.getElementById('lightbox-overlay').style.display = 'flex';
}

function switchPayment(type) {
  const bg = document.getElementById('switch-bg');
  const optBank = document.getElementById('opt-bank');
  const optLine = document.getElementById('opt-linepay');
  const contentBank = document.getElementById('content-bank');
  const contentLine = document.getElementById('content-linepay');

  const isBank = (type === 'bank');
  bg.style.transform = isBank ? 'translateX(0)' : 'translateX(100%)';
  optBank.classList.toggle('active', isBank);
  optLine.classList.toggle('active', !isBank);
  contentBank.classList.toggle('active', isBank);
  contentLine.classList.toggle('active', !isBank);
}

// confetti 是第三方 CDN 且用 defer 載入，掛掉時原本會丟 ReferenceError
function fireConfetti() {
  if (typeof confetti !== 'function') return;
  const end = Date.now() + 2000;
  (function frame() {
    confetti({ particleCount: 3, angle: 60, spread: 55, origin: { x: 0, y: 0.8 } });
    confetti({ particleCount: 3, angle: 120, spread: 55, origin: { x: 1, y: 0.8 } });
    if (Date.now() < end) requestAnimationFrame(frame);
  }());
}

function handleLineJump() {
  const targetUrl = String(cfgGet(window.paymentConfig, '跳轉按鈕連結') || '').trim();
  if (targetUrl.startsWith('http')) window.open(targetUrl, '_blank');
  else customAlert('✨ 感謝您的訂購！\n請手動回報匯款唷～ ✨');
}
