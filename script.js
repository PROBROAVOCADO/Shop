/*************************************************************
 * 波波酪梨 線上訂購系統 — 前端 script.js
 * 版本：2026-08 Firebase 控制節點版 (v5) + v7 樣式改版配套
 *
 * 【v5 主要改動】共四項
 *
 *  🔴 1. 重試時先查收據，不再被自己的成功訂單鎖死
 *
 *     舊版的死路：第一次送出其實成功了（但 Google 回傳 HTML 錯誤頁，
 *     客人看到「無法確認」），庫存已經扣掉。客人依照提示再按一次時：
 *       → 先跑庫存預檢查 → 發現庫存不足（被自己買走的）
 *       → 提示 + trimCartToStock() 把購物車清空
 *       → 再按 → 「購物車還是空的」
 *       → 客人卡死，但訂單其實成立了
 *
 *     秒殺尾聲最容易踩到 —— 那正是「最後一份剛好被自己買走」的時候。
 *
 *     修法：只要 currentOrderKey 還在（代表這是重試），送出前先查一次
 *     Firebase 收據。查到就直接帶去成功頁，完全跳過庫存預檢查。
 *
 *  🟠 2. 配送方式被臨時關閉時，擋在瀏覽器裡
 *
 *     applySwitchesToDom 只設 option.disabled，但已經選中的值不會被清掉，
 *     送出前也沒有檢查。你緊急關掉黑貓 → 已經選了黑貓的客人一路填完、
 *     送出、被後端打回票，每個人白吃一次 GAS 執行數。
 *     updateOrderPageStopState 早就處理了全站停售，這裡補上同樣的邏輯。
 *
 *  🟠 3. 移除 7-11 離島阻擋
 *
 *     門市是自由輸入欄位，客人可能填店名、也可能只填店號 ——
 *     填店號的完全比對不到，所以這道判斷天生就有漏網。
 *     既然只能是輔助、不可能是最終防線，做成會擋下訂單的硬檢查
 *     就不划算（誤判的客人當場流失，而且前後端兩份清單要人工同步）。
 *     未來若要做，會改成「後台可控文案的軟提示」，不擋送出。
 *
 *     註：isIslandAddress / 離島縣市 / 離島鄉鎮 全部保留 ——
 *     那是宅配與郵寄的離島運費計算，跟這件事無關。
 *
 *  🟡 4. 社群連結在網址被清空時會正確隱藏（舊版只有 show 沒有 hide）
 *
 * 【v4 主要改動】
 *  A1  Firebase 推播加上 dataAt 新鮮度比對，舊資料一律丟棄
 *      （秒殺尾聲最容易出現亂序推播，客人會看到已售完的品項還有貨）
 *  A2  成功頁金額改用後端實際成交金額，保證跟試算表與 PDF 一致
 *      設定輪詢改為套用整份設定，價格不再凍在載入那一刻
 *  A5  上架時間全部改吃後端算好的絕對時間戳（後端已改成明確時區）
 *  D1  applyReleaseStatus 不再重設 lastKnown，開賣狀態轉換只由 ticker 負責
 *      （舊版快照輪詢與 ticker 搶著決定，開賣那一秒有機率不解鎖）
 *  D3  送單期間收到的推播先暫存，送完再套用，不再中途改動購物車
 *
 * 【v7 樣式改版配套】共四處，都只動外觀不動邏輯
 *  ・applyConfigToPage   新增「規格選擇備註」，文字由試算表控制
 *  ・showLoadingScreen   配色換成 v7 品牌色票（原本寫死舊版亮綠漸層）
 *  ・showLoadingError    同上
 *  ・updateFloatingCart  空購物車文字的寫死灰色改用品牌色
 *
 * 📝 資料來源分工（依「變動速度」而非「資料種類」）
 *   即時層 → Firebase control 節點：庫存、上架時間、訂單開關、配送開關
 *   靜態層 → GitHub 快照：品種、圖片、公告、匯款、價格運費表，兼冷啟動與備援
 *   權威層 → GAS：下單當下的最終覆核，錢與庫存只認這一層
 *************************************************************/

// 🔒 orderKey 一進來就從網址移除。
//    GA4 的 page_location 會記錄完整查詢字串，而 orders/{uuid} 現在含
//    姓名與電話 —— 讓 orderKey 流進分析報表等於把個資的鑰匙散出去。
//    必須在 analytics.js 的 DOMContentLoaded 掛鉤之前執行。
var 進站訂單Key = '';
try {
  var _m = location.search.match(/[?&]order=([0-9a-fA-F-]{36})/);
  if (_m) {
    進站訂單Key = _m[1];
    history.replaceState(null, '', location.pathname);
  }
} catch (e) {}

// ========================================
// ⭐ 連線設定
// ========================================
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwbkKqipfPrimFs7-d6ZorySDv0g5yhq_vbGGp2xmWZm2diNsblTfMjwP8kz-Hx9iRDTQ/exec';
const CONFIG_JSON_URL  = 'https://probroavocado.com/data/config.json';
const PAY_WORKER_URL = 'https://probro-payuni-crypto.probroavocado.workers.dev';
const FIREBASE_PAYMENTS_PATH = 'payments';
const ADDRESS_JSON_URL = 'https://probroavocado.com/data/address.json';

// 🔥 Firebase 即時控制節點（唯讀，這個網址本來就是公開資訊）
const FIREBASE_DB_URL = 'https://probro-stock-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_CONTROL_PATH = 'control';
const FIREBASE_ORDERS_PATH  = 'orders';

const POLL_MS_FAST = 8000;    // Firebase 沒連上時：靠輪詢快照，8 秒一次
const POLL_MS_SLOW = 60000;   // Firebase 正常時：即時層走推播，快照只需慢慢確認靜態內容
const SNAPSHOT_STALE_MIN = 60;// 快照超過幾分鐘沒更新就顯示柔性提示

// ⏳ 載入畫面的「最短」顯示時間（不是固定等待）。
// 如果實際載入比它久，不會額外多等；比它快才補到這個秒數。
// 用意有兩個：一是讓載入動畫真的被看見，二是趁這段時間把該暖的都暖完。
const MIN_LOADING_MS = 2000;


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

// 🩺 控制節點最後一次被後端更新的時間。
// 這是比快照更準的健康指標：保底維護每 15 分鐘會無條件推一次控制節點，
// 所以只要它停了，就代表觸發器真的掛了 —— 而快照現在「內容沒變就不發布」，
// 快照舊不代表系統壞掉，不能再拿它當判斷依據。
var lastControlUpdatedAt = 0;

// 🔑 D3：送單期間是否有累積尚未反映到畫面的更新。
// 注意這裡只延後「畫面」，資料（stockMap / 開關 / 上架時間）永遠即時更新，
// 否則送單前的庫存預檢查會拿到舊資料，白白多打一次 GAS。
var uiNeedsRefresh = false;

// 📦 裝箱狀態
var splitShipping = false;   // 客人是否勾選「分開寄出」
var 合併方案 = null;         // 最省的裝箱結果
var 分開方案 = null;         // 每件一箱的結果
var finalBoxCount = 0;

// 🏝️ 台灣離島判定（只用於運費計算）
//
// ⚠️ v5 說明：7-11 的離島門市關鍵字阻擋已經整組移除。
// 門市是自由輸入欄位，客人可能填「馬公門市」、也可能只填店號 ——
// 填店號的完全比對不到，所以那道判斷天生就有漏網，
// 永遠只能是輔助而非最終防線。做成會擋下訂單的硬檢查不划算。
// 下面這兩份清單是宅配/郵寄的離島運費判定，跟那件事無關，保留。
const 離島縣市 = ['澎湖縣', '金門縣', '連江縣'];
const 離島鄉鎮 = ['綠島鄉', '蘭嶼鄉', '琉球鄉'];

// 🕐 上架狀態（後端提供絕對時間戳，前端自行倒數）
const RELEASE = { at: null, display: '', lastKnown: true };
var serverClockOffset = 0; // 伺服器時間 - 本機時間

// 🚦 開關狀態（即時層）
var orderSwitch = '開';
var shippingSwitch = { post: '', '711': '', blackcat: '' };

// 💳 付款模式。'payuni' = 線上金流；'bank' = 退回舊的匯款資訊。
//    讀不到時預設 payuni（正常營運是新流程，這是安全的那一邊）。
//    冷啟動由快照提供，Firebase 一連上就以推播為準 —— 跟 orderSwitch 同一個機制。
var paymentMode = 'payuni';
 
// 目前成功頁正在顯示哪一筆訂單，以及它的付款狀態監聽
var currentPayOrderKey = null;
var payStatusRef = null;

// 🩺 健康判斷用（v6 修正誤報）
const 控制節點寬限MS = 20000;   // 進站後這段時間內不做健康判斷
var 站台啟動時間 = Date.now();
var 控制節點補撈中 = false;
var 控制節點讀取失敗 = false;

/*************************************************************
 * 📦 裝箱模組（code.gs 與 script.js 共用，必須完全相同）
 *
 * 為什麼目標函式是「總運費」而不是「箱數」：
 *   運費是級距制不是連續的，塞越滿不一定越便宜。
 *   例：4 個 3 斤走宅配（上限 10）
 *     9斤 + 3斤 → 2 箱，大級距 + 小級距
 *     6斤 + 6斤 → 2 箱，小級距 + 小級距  ← 一樣箱數，但便宜
 *   標準的 FFD 演算法會給出上面那個。所以直接以錢為目標，
 *   不用箱數當代理指標，之後你調運費也不會突然算錯。
 *
 * 決定性：weights 由重到輕排序、枚舉順序固定、只在「嚴格更好」時
 *   才替換最佳解 → 同一個購物車永遠得到同一個答案。
 *************************************************************/

const 裝箱單位數上限 = 20;      // 超過就不做最佳化（保險）
const 裝箱狀態數上限 = 50000;   // 這個才是真正跟運算量成正比的指標

// units: [{ w: 3, label: '當季【優】 3斤' }, ...]
// feeOf: function(箱重) -> 運費
// 回傳 null = 有單一品項就超過單箱上限（這個配送方式寄不了）
function 計算裝箱(units, limit, feeOf) {
  const list = (units || []).filter(x => x && Number(x.w) > 0).slice();
  if (list.length === 0) return { boxes: [], fee: 0, degraded: false };

  // 固定排序 → 品項貼回箱子時結果可重現
  list.sort((a, b) => (b.w - a.w) ||
    (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));

  const weights = [];
  const countOf = {};
  list.forEach(x => {
    const w = Number(x.w);
    if (countOf[w] === undefined) { countOf[w] = 0; weights.push(w); }
    countOf[w]++;
  });
  weights.sort((a, b) => b - a);
  const counts = weights.map(w => countOf[w]);

  if (weights[0] > limit) return null;

  const 單位數 = list.length;
  const 狀態數 = counts.reduce((a, c) => a * (c + 1), 1);
  const degraded = (單位數 > 裝箱單位數上限) || (狀態數 > 裝箱狀態數上限);

  const plan = degraded
    ? 貪婪裝箱_(weights, counts, limit)
    : 最佳裝箱_(weights, counts, limit, feeOf).plan;

  // 把實際品項貼回箱子（重量相同的品項互換不影響運費）
  const pool = {};
  weights.forEach(w => { pool[w] = []; });
  list.forEach(x => pool[Number(x.w)].push(x));

  const boxes = plan.map(comp => {
    const box = { weight: 0, items: [] };
    weights.forEach((w, i) => {
      for (let k = 0; k < comp[i]; k++) {
        const it = pool[w].shift();
        if (it) { box.items.push(it); box.weight += w; }
      }
    });
    return box;
  });

  let fee = 0;
  boxes.forEach(b => { fee += feeOf(b.weight); });
  return { boxes: boxes, fee: fee, degraded: degraded };
}

// 每個單位各自成箱（客人選「分開寄出」時用）
function 每件一箱(units, feeOf) {
  const list = (units || []).slice().sort((a, b) => (b.w - a.w) ||
    (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));
  const boxes = list.map(u => ({ weight: u.w, items: [u] }));
  let fee = 0;
  boxes.forEach(b => { fee += feeOf(b.weight); });
  return { boxes: boxes, fee: fee, degraded: false };
}

// DP + 記憶化。狀態是「各重量還剩幾件」的計數向量，不是排列。
function 最佳裝箱_(weights, counts, limit, feeOf) {
  const memo = {};

  const solve = (state) => {
    const key = state.join(',');
    if (memo[key]) return memo[key];

    let hi = -1;
    for (let i = 0; i < state.length; i++) { if (state[i] > 0) { hi = i; break; } }
    if (hi === -1) return (memo[key] = { fee: 0, n: 0, plan: [] });

    // 🔑 剩下最重的那一件一定放進「這一箱」。這是正規化：
    //    不做的話同一組裝法會用不同順序被重複計算好幾遍。
    let best = null;
    const comp = new Array(state.length).fill(0);
    comp[hi] = 1;

    const 枚舉 = (idx, used) => {
      if (idx >= state.length) {
        const next = state.slice();
        for (let i = 0; i < comp.length; i++) next[i] -= comp[i];
        const sub = solve(next);
        const fee = feeOf(used) + sub.fee;
        const n = 1 + sub.n;
        if (!best || fee < best.fee || (fee === best.fee && n < best.n)) {
          best = { fee: fee, n: n, plan: [comp.slice()].concat(sub.plan) };
        }
        return;
      }
      const 已固定 = (idx === hi) ? 1 : 0;
      const 可放 = state[idx] - 已固定;
      for (let k = 0; k <= 可放; k++) {
        const w = used + k * weights[idx];
        if (w > limit) break;   // 同一 idx 內 k 遞增，超過就不必再試
        comp[idx] = 已固定 + k;
        枚舉(idx + 1, w);
      }
      comp[idx] = 已固定;
    };

    枚舉(0, weights[hi]);
    return (memo[key] = best);
  };

  return solve(counts.slice());
}

// 降級用：由重到輕 first-fit
function 貪婪裝箱_(weights, counts, limit) {
  const 待裝 = [];
  weights.forEach((w, i) => { for (let k = 0; k < counts[i]; k++) 待裝.push(i); });

  const boxes = [];
  待裝.forEach(i => {
    const w = weights[i];
    let box = null;
    for (let b = 0; b < boxes.length; b++) {
      if (boxes[b].weight + w <= limit) { box = boxes[b]; break; }
    }
    if (!box) {
      box = { comp: new Array(weights.length).fill(0), weight: 0 };
      boxes.push(box);
    }
    box.comp[i]++;
    box.weight += w;
  });
  return boxes.map(b => b.comp);
}

function 建立運費函式(method, isIsland) {
  if (method === '711')  return function () { return 運費表['711運費']; };
  if (method === 'post') return function (w) {
    return isIsland ? (w < 7 ? 運費表.郵寄離島小 : 運費表.郵寄離島大)
                    : (w < 7 ? 運費表.郵寄小 : 運費表.郵寄大);
  };
  if (method === 'blackcat') return function (w) {
    return isIsland ? (w < 7 ? 運費表.黑貓離島小 : 運費表.黑貓離島大)
                    : (w < 7 ? 運費表.黑貓小 : 運費表.黑貓大);
  };
  return null;
}

// 依 商品分類 的固定順序展開成單位清單 → 裝箱結果可重現
function 購物車單位清單() {
  const units = [];
  商品分類.forEach(cat => {
    cat.weights.forEach(w => {
      const key = stockKeyOf(cat.name, w);
      const qty = (cart[key] && cart[key].qty) || 0;
      const label = (cat.縮寫 || cat.name) + ' ' + w + '斤';
      for (let i = 0; i < qty; i++) units.push({ w: w, label: label });
    });
  });
  return units;
}

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

/* ========================================
   📦 單一真相來源（E1 / E2）

   商品規格、單價欄位、配送限重、運費欄位，全部在這一區定義一次，
   其餘的表格都由它衍生。以前這些散在四、五個地方，
   改一個品項要動好幾處，改漏了前後端就會算出不同金額。

   ⚠️ 這一區的內容要跟 code.gs 的「單一真相來源」保持一致。
   兩邊一個在瀏覽器、一個在 GAS，沒辦法共用程式碼，只能人工同步。
   ======================================== */

// 顯示名稱：試算表用的標籤 vs 客人看到的名稱
const displayNameMap = {
  '平克頓/哈斯【優級】': '平克頓/哈斯 (隨機出貨)【優級】',
  '平克頓/哈斯【次級】': '平克頓/哈斯 (隨機出貨)【次級】',
  '當季酪梨(隨機出貨)【優級】': '當季酪梨(隨機出貨)【優級】',
  '當季酪梨(隨機出貨)【次級】': '當季酪梨(隨機出貨)【次級】'
};

const 商品分類 = [
  { name: '當季酪梨(隨機出貨)【優級】', 縮寫: '當季【優】', weights: [3, 5, 7, 10], priceKey: '當季酪梨( 隨機出貨 )【優級】單價' },
  { name: '當季酪梨(隨機出貨)【次級】', 縮寫: '當季【次】', weights: [3, 5, 7, 10], priceKey: '當季酪梨( 隨機出貨 )【次級】單價' },
  { name: '平克頓/哈斯【優級】',        縮寫: '平克【優】', weights: [1, 2, 3],     priceKey: '平克頓/哈斯【優級】單價' },
  { name: '平克頓/哈斯【次級】',        縮寫: '平克【次】', weights: [1, 2, 3],     priceKey: '平克頓/哈斯【次級】單價' }
];

const 配送方式定義 = {
  post:     { 名稱: '中華郵政',   顯示名: '中華郵政配送',   限重: 10, 開關欄位: '中華郵政配送' },
  '711':    { 名稱: '7-11',       顯示名: '7-11超商配送',    限重: 7,  開關欄位: '7-11超取配送' },
  blackcat: { 名稱: '黑貓宅急便', 顯示名: '黑貓宅急便配送', 限重: 10, 開關欄位: '黑貓配送' }
};

// 運費：內部名稱 → 試算表欄位名稱
const 運費欄位定義 = {
  郵寄小:     '郵寄七斤(不含)以下',
  郵寄大:     '郵寄七斤(包含)以上',
  '711運費':  '711運費',
  黑貓小:     '黑貓配送七斤(不含)以下',
  黑貓大:     '黑貓配送七斤(包含)以上',
  郵寄離島小: '郵寄離島七斤(不含)以下',
  郵寄離島大: '郵寄離島七斤(包含)以上',
  黑貓離島小: '黑貓配送離島七斤(不含)以下',
  黑貓離島大: '黑貓配送離島七斤(包含)以上'
};

// ---------- 以下全部由上面衍生，不要手動維護 ----------
const 限重表 = {};
const 配送名稱 = {};
const 配送顯示名 = {};
Object.keys(配送方式定義).forEach(k => {
  限重表[k]     = 配送方式定義[k].限重;
  配送名稱[k]   = 配送方式定義[k].名稱;
  配送顯示名[k] = 配送方式定義[k].顯示名;
});

// 客人看到的名稱 → 價格表的 key（updateCart 用）
const stockKeyMap = {};
商品分類.forEach(cat => {
  stockKeyMap[displayNameMap[cat.name] || cat.name] = cat.name;
});

function stockKeyOf(catName, weight) {
  return normKey(catName + '-' + weight);
}

// 🔑 v6 (#9)：統一的查價入口。
//    顯示名 → 試算表標籤 → normKey → 價格表。
//    以前這段邏輯在 updateCart 與 refreshCartUI 各寫一次，
//    改 key 規則時很容易只改到一邊。
function 查單價(displayName) {
  const 標籤 = stockKeyMap[displayName] || displayName;
  return Number(價格表[normKey(標籤)]) || 0;
}

// 從「訂購與運費」設定讀出三個配送開關
function 讀取配送開關(訂購設定) {
  const out = {};
  Object.keys(配送方式定義).forEach(k => {
    out[k] = cfgGet(訂購設定, 配送方式定義[k].開關欄位);
  });
  return out;
}


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

// 🧾 查詢這筆訂單的「收據」。
//
// 壓力測試量到的實況：60 併發時，60 筆裡有 20 筆伺服器其實成功了，
// 客戶端卻因為 Google 回傳 HTML 錯誤頁而以為失敗 —— 三分之一的成功訂單，
// 客人看到的是「無法確認結果」。
//
// 下單成功時後端會把收據寫進 Firebase，所以這裡直接查 Firebase 就好。
// 刻意不回頭問 GAS：那個時間點 GAS 正是最塞的，
// 二十個人同時回去查只會讓壅塞更嚴重，等於自己人踩自己人。
async function fetchOrderReceipt(orderKey) {
  if (!orderKey) return null;
  try {
    const res = await fetch(
      `${FIREBASE_DB_URL}/${FIREBASE_ORDERS_PATH}/${encodeURIComponent(orderKey)}.json`,
      { cache: 'no-store' }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return (json && json.row) ? json : null;
  } catch (err) {
    return null;
  }
}

// 送單沒收到回應時，等一下再查幾次。
// 訂單有可能還在 GAS 的佇列裡排隊，所以要給它一點時間。
// 間隔帶隨機值，避免所有客人在同一秒一起查。
async function waitForOrderReceipt(orderKey, onProgress) {
  const 間隔 = [3000, 5000, 8000, 12000];
  for (let i = 0; i < 間隔.length; i++) {
    await new Promise(r => setTimeout(r, 間隔[i] + Math.random() * 1500));
    if (onProgress) onProgress(i + 1, 間隔.length);
    const receipt = await fetchOrderReceipt(orderKey);
    if (receipt) return receipt;
  }
  return null;
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
  const loadStartedAt = Date.now();
  showLoadingScreen(true);

  // 🔥 最重要的一項暖機：Firebase 連線「立刻」開始，不等設定載入完。
  //
  // 舊版是 await 完設定才 initFirebaseControl()，等於 WebSocket 握手
  // 要排在設定載入之後才開始，手機上這段握手常常要 300~800ms。
  // 客人看到頁面時 Firebase 可能還沒連上，那幾秒的庫存是舊的 ——
  // 而秒殺最關鍵的就是進站那一瞬間。
  //
  // 現在改成平行進行，兩秒的載入畫面結束時，連線通常早就建立好了。
  window.APP_CONFIG = window.APP_CONFIG || {};
  initFirebaseControl();

  try {
    const [json, addressMap] = await Promise.all([
      fetchConfigWithRetry(3, 1500),
      fetchAddressMap()
    ]);

    const cfg = json.data;

    // 🔑 載入設定的期間，Firebase 可能已經推來更新的即時資料。
    // 那份一定比快照新，不能被快照蓋回去。
    const 已有即時資料 = lastControlDataAt > 0;
    const 保留庫存 = 已有即時資料 ? window.APP_CONFIG.stockMap : null;

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

    // 冷啟動：只有在還沒收到任何即時資料時，才用快照填即時層。
    if (!已有即時資料) {
      applyReleaseStatus(cfg['上架狀態']);
      applySwitches(cfgGet(cfg['首頁'], '訂單開關') || '開', 讀取配送開關(cfg['訂購']));
      paymentMode = String(cfgGet(cfg['首頁'], '付款模式') || 'payuni').trim();
    }

    // 🔑 D1：初始化時設定一次基準，之後 lastKnown 只由 ticker 更新。
    RELEASE.lastKnown = isReleasedNow();

    applySnapshotStamp(json);
    applyConfigToPage(cfg);
    applyStaticTables(cfg['訂購'] || {});

    // 庫存 key 統一去空格
    if (保留庫存) {
      window.APP_CONFIG.stockMap = 保留庫存;
    } else {
      window.APP_CONFIG.stockMap = {};
      const rawStock = window.APP_CONFIG.stockData || {};
      Object.keys(rawStock).forEach(k => {
        window.APP_CONFIG.stockMap[normKey(k)] = Math.max(0, Number(rawStock[k]) || 0);
      });
    }

    renderOrderCardImages(window.APP_CONFIG.orderConfig);

    renderProductList();
    renderVarieties();
    renderPriceMenu();
    initAddressSelector();
    initShippingAddressToggle();
    updateReleaseBanner();
    applySwitchesToDom();

    configLoaded = true;
    startStockAutoRefresh();
    startReleaseTicker();
    initVisibilityRefresh();

    // 載入期間收到的推播，這時候才有畫面可以套
    flushPendingControl();

    // 🔗 從網址進來的（付款完成返回、或客人開了保存的訂單連結）
    const 已進成功頁 = await 從網址載入訂單();

    // 🔔 沒有的話，檢查有沒有未完成付款的訂單要提醒
    if (!已進成功頁) 檢查未付款訂單();
    
    // 🖼️ 趁剩下的載入時間把後面幾頁的圖片先抓回來（不阻塞）。
    // 客人翻到品種頁、訂購頁、成功頁時就不會再等圖。
    preloadLaterImages(cfg);

    // ⏳ 補滿最短載入時間。實際載入若已超過就不會多等。
    const 已花時間 = Date.now() - loadStartedAt;
    if (已花時間 < MIN_LOADING_MS) {
      await new Promise(r => setTimeout(r, MIN_LOADING_MS - 已花時間));
    }

  } catch (err) {
    console.error('初始化失敗：', err);
    showLoadingError();
    return; // 已經換掉整個 body，不要再去動載入畫面
  } finally {
    showLoadingScreen(false);
  }
};

// 🖼️ 預先抓取後續頁面會用到的圖片。
// 用 new Image() 而不是 fetch：瀏覽器會直接放進圖片快取，
// 之後 <img src> 指過去是零延遲，而且不會佔用 fetch 的連線配額。
function preloadLaterImages(cfg) {
  const urls = [];

  (cfg['品種'] || []).forEach(v => {
    const u = resolveImageUrl(v.img, 900);
    if (u) urls.push(u);
  });

  const 訂購 = cfg['訂購'] || {};
  [cfgGet(訂購, '訂購頁插圖ID_1'), cfgGet(訂購, '訂購頁插圖ID_2')].forEach(id => {
    const u = resolveImageUrl(id, 600);
    if (u) urls.push(u);
  });

  const qrId = cfgGet(cfg['匯款'], 'LINE_PAY圖片ID');
  const qrUrl = resolveImageUrl(qrId, 500);
  if (qrUrl) urls.push(qrUrl);

  // 最多預抓 8 張，避免在行動網路上浪費客人的流量
  urls.slice(0, 8).forEach(u => {
    const img = new Image();
    img.decoding = 'async';
    img.src = u;
  });
}

// 👀 分頁重新回到前景時強制對一次資料。
//
// 這對你的模式特別重要：客人常常 19:50 就把頁面開好、切去別的 App，
// 20:00 才切回來。手機在背景時瀏覽器會凍結 timer、也可能斷開 WebSocket，
// 切回來的那一刻畫面有可能是幾分鐘前的。
function initVisibilityRefresh() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (isSubmitting) return;
    refreshRealtime();      // 即時層：庫存 / 開賣時間 / 開關
    updateReleaseBanner();  // 倒數立刻校正，不等下一秒 tick
  });

  // iOS Safari 從上一頁返回時是走 bfcache，不會觸發 visibilitychange
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !isSubmitting) refreshRealtime();
  });
}

// 把「價格表 / 運費表」從設定物件重新建出來。
// 🔑 A2：獨立成函式，讓背景輪詢也能重新套用，
// 不再像舊版那樣凍在 window.onload 那一刻。
function applyStaticTables(data) {
  window.APP_CONFIG.orderConfig = data || {};

  // 由「單一真相來源」衍生，不再重複列舉欄位名稱
  // 🔑 v6 (#9)：key 一律 normKey，跟後端 v8 對齊。
  //    目前商品名稱剛好都沒有空格所以兩邊對得上，
  //    但哪天標籤裡多打一個空格，兩邊會安靜地算出不同答案。
  價格表 = {};
  商品分類.forEach(cat => { 價格表[normKey(cat.name)] = cfgNum(data, cat.priceKey); });

  運費表 = {};
  Object.keys(運費欄位定義).forEach(k => { 運費表[k] = cfgNum(data, 運費欄位定義[k]); });

  // ⚠️ 這裡要區分兩種「單價 = 0」，它們數值上完全一樣但意義相反：
  //
  //   ① 試算表 key 被改壞（多打/少打空格）→ cfgGet 查不到欄位，回傳 undefined
  //      這種要鎖住訂購入口，否則前後端會「一致地」都算成 0 元，
  //      後端覆核完全失效，客人會下到 0 元訂單。
  //
  //   ② 這一級真的非產季，B 欄就是填 0 → 欄位存在，值是 0
  //      這是正常營運狀態，要顯示「非產季」而不是「系統維護中」。
  //
  // 所以判斷依據是「欄位找不找得到」，不是「值大不大於 0」。
  // 舊版用 `有效價格數 === 0` 判斷，會把整季休耕誤判成系統故障。
  const 找不到的欄位 = 商品分類
    .filter(cat => cfgGet(data, cat.priceKey) === undefined)
    .map(cat => cat.priceKey);

  window.APP_CONFIG.priceConfigBroken = (找不到的欄位.length === 商品分類.length);

  if (window.APP_CONFIG.priceConfigBroken) {
    console.error('所有單價欄位都讀不到，已鎖定訂購入口。請檢查試算表「3-訂購與運費」A 欄的參數名稱', 找不到的欄位);
  } else if (找不到的欄位.length > 0) {
    // 只壞了一部分：那幾項會安靜地變成「非產季」，不鎖入口但要留下線索。
    // 這種局部故障最難發現 —— 畫面看起來完全正常，只是少賣了幾個品項。
    console.warn('以下單價欄位讀不到，這些品項會顯示為非產季：', 找不到的欄位);
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
  shippingSwitch = {};
  Object.keys(配送方式定義).forEach(k => {
    shippingSwitch[k] = String((newShipping && newShipping[k]) || '').trim();
  });
  applySwitchesToDom();
}

function applySwitchesToDom() {
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
  updateOrderPageStopState();
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

// 🛑 緊急煞車在訂購頁的呈現。
//
// 舊版只有首頁那顆進入按鈕會變灰，已經走到訂購頁的客人畫面上
// 完全看不出來已經停售 —— 他會填完整張表、按下送出，才被後端打回票。
// 而秒殺時最積極的那群人正好全部都在這一頁，等於煞車對他們無效，
// 每個人還會白白吃掉一次 GAS 執行數。
function updateOrderPageStopState() {
  const page = document.getElementById('step4-order-form');
  if (!page) return;

  const 停售 = (orderSwitch === '關') ||
               !!(window.APP_CONFIG && window.APP_CONFIG.priceConfigBroken);

  // 橫幅用 JS 動態建立，index.html 不需要改
  let banner = document.getElementById('order-stop-banner');
  if (停售) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'order-stop-banner';
      banner.className = 'stale-warning';
      banner.style.marginBottom = '18px';
      page.insertBefore(banner, page.firstChild);
    }
    banner.textContent = (window.APP_CONFIG && window.APP_CONFIG.priceConfigBroken)
      ? '⚠️ 系統設定維護中，暫時無法送出訂單，造成不便敬請見諒。'
      : '🚫 目前已暫停接單，感謝您的體諒 🌱　現在無法送出訂單。';
    banner.style.display = 'block';
  } else if (banner) {
    banner.style.display = 'none';
  }

  const submitBtn = document.getElementById('submit-btn');
  if (submitBtn && !isSubmitting) {
    submitBtn.disabled = 停售;
    submitBtn.classList.toggle('is-disabled', 停售);
    submitBtn.innerText = 停售 ? '🚫 暫停接單中' : '✅ 確認訂購';
  }
}


// ========================================
// 🕐 上架狀態 / 開賣倒數
// ========================================

// 🔑 D1 修正的核心。
// 舊版這個函式最後有一行 `RELEASE.lastKnown = isReleasedNow()`，
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
    `<div class="release-banner-hint">時間一到將自動開放</div>`;
}


// ========================================
// 🩺 系統健康檢查
//
// ⚠️ 這裡的判斷依據換過了，原因很重要：
//
// 後端現在會做內容比對，設定沒變就不發布快照。所以「快照很舊」
// 只代表你最近沒改試算表，完全不代表系統有問題 ——
// 拿它當依據會讓客人天天看到「庫存資訊可能不是最新的」的假警報。
//
// 真正的健康指標是 Firebase 控制節點的 updatedAt：
// 保底維護每 15 分鐘會無條件推一次（而且不產生任何 commit），
// 它停了才代表觸發器掛了、或 GAS 出事了。
// ========================================
function applySnapshotStamp(json) {
  const el = document.getElementById('stale-warning');
  if (!el) return;

  // Firebase 連線中 → 庫存與開關本來就是即時的，不需要嚇客人
  if (firebaseLive) { el.style.display = 'none'; return; }

  // 🩺 唯一有效的健康指標是控制節點的 updatedAt。
  //
  // 舊版在拿不到它時會退回去看快照時間，那是錯的：
  // 快照「內容沒變就不發布」，所以休耕期或你單純沒改試算表的日子，
  // 快照本來就會很舊 —— 客人進站第一眼就看到「庫存可能不是最新的」，
  // 而系統其實完全健康。那句話在秒殺當下會直接勸退人。
  if (!lastControlUpdatedAt) {
    if (控制節點讀取失敗) {
      el.style.display = 'block';
      el.textContent = '⚠️ 庫存資訊可能不是最新的，下單前建議與我們確認';
      return;
    }
    // 剛進站，Firebase 可能還在握手（手機上常要 300~800ms）→ 寬限期內不判斷
    if (Date.now() - 站台啟動時間 < 控制節點寬限MS) {
      el.style.display = 'none';
      return;
    }
    // 寬限期過了還是沒收到推播 → 主動用 REST 撈一次。
    // 撈到就有基準可判斷；撈不到才是真的有問題。
    if (!控制節點補撈中) {
      控制節點補撈中 = true;
      fetchControlViaRest()
        .then(c => { applyControl(c); })
        .catch(() => { 控制節點讀取失敗 = true; })
        .then(() => { 控制節點補撈中 = false; });
    }
    el.style.display = 'none';
    return;
  }

  const ageMin = (serverNow() - lastControlUpdatedAt) / 60000;
  if (ageMin > SNAPSHOT_STALE_MIN) {
    el.style.display = 'block';
    el.textContent = '⚠️ 庫存資訊可能不是最新的，下單前建議與我們確認';
    console.warn('控制節點已超過 ' + Math.round(ageMin) + ' 分鐘沒有更新');
  } else {
    el.style.display = 'none';
  }
}


// ========================================
// 🖼️ 填入頁面靜態文字
//
// 這個函式在冷啟動與每次快照輪詢時都會被呼叫，所以裡面的每一項
// 都必須是「重複執行也不會出問題」的寫法。
// ========================================
function applyConfigToPage(cfg) {
  const h = cfg['首頁'] || {};
  const 訂購 = cfg['訂購'] || {};

  const mainTitle = document.getElementById('main-title');
  if (mainTitle) mainTitle.textContent = cfgGet(h, '網頁大標題') || '波波酪梨';

  document.title = cfgGet(h, '分頁標題') || '波波酪梨｜線上訂購';

  // 🔗 v5：補上 else 分支。
  // 舊版只有「有網址才顯示」，沒有「沒網址就隱藏」——
  // 你在試算表裡把某個社群連結清空後，輪詢時那顆按鈕不會消失，
  // 客人點下去會跳到 href="#"（等於原地重整，購物車還會被清掉）。
  const socialMap = {
    'social-line': cfgGet(h, 'LINE連結'),
    'social-ig':   cfgGet(h, 'IG連結'),
    'social-fb':   cfgGet(h, 'FB連結')
  };
  Object.keys(socialMap).forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const url = (socialMap[id] || '').toString().trim();
    if (url) {
      el.href = url;
      el.style.display = 'flex';
    } else {
      el.style.display = 'none';
    }
  });

  const annTitle = document.getElementById('announcement-title');
  if (annTitle) annTitle.textContent = cfgGet(h, '公告區標題') || '最新公告';

  const annContent = document.getElementById('announcement-content');
  if (annContent) annContent.innerHTML = String(cfgGet(h, '公告內容') || '').replace(/\n/g, '<br>');

  const varietyTitle = document.getElementById('variety-title');
  if (varietyTitle) varietyTitle.textContent = cfgGet(h, '品種分頁大標題') || '我們的當季酪梨';

  const orderTitle = document.getElementById('order-title');
  if (orderTitle) orderTitle.textContent = cfgGet(h, '訂購分頁大標題') || '訂購資訊';

  // 📝 訂購頁的兩則提示小字，文字都由試算表「3-訂購與運費」控制：
  //      #shipping-note ← 配送方式備註
  //      #spec-note     ← 規格選擇備註
  //    沒填內容就整塊隱藏，避免留下一段莫名的空白。
  //
  //    用 textContent 不用 innerHTML —— 試算表的內容是你自己打的沒錯，
  //    但那份表未來可能會共用給別人編輯，不給它塞 HTML 的機會比較安全。
  //    換行由 CSS 的 white-space: pre-line 處理，試算表裡按 Alt+Enter 就會換行。
  const 設定提示 = (id, text) => {
    const el = document.getElementById(id);
    if (!el) return;
    const t = String(text || '').trim();
    el.textContent = t;
    el.style.display = t ? 'block' : 'none';
  };
  設定提示('shipping-note', cfgGet(訂購, '配送方式備註'));
  設定提示('spec-note',     cfgGet(訂購, '規格選擇備註'));

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
//
// ⚠️ 這一區的樣式是寫死在 JS 字串裡的，style.css 影響不到它。
//    改站台配色時記得連這裡一起改，否則客人進站會先看到舊配色，
//    兩秒後才切成新的 —— 那是整個品牌給人的第一印象。
//
// ⚠️ 顏色刻意寫死而不用 var()：載入畫面有可能在 style.css
//    還沒下載完就先出現，那時候 CSS 變數是空的。
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
            40% { transform: translateY(-26px) scale(1.08); }
            60% { transform: translateY(-12px) scale(1.04); }
          }
          @keyframes fadeInUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
          @keyframes dotPulse { 0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1.2); } }
          #loading-screen {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: linear-gradient(170deg, #FAF7EF 0%, #EDE8DA 55%, #E0E6D2 100%);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            z-index: 99999; transition: opacity 0.5s ease;
            overflow: hidden;
          }
          /* 🏞️ 載入畫面底部的山丘，跟頁尾用同一組造型，維持一致 */
          #loading-screen::after {
            content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 130px;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 720 130' preserveAspectRatio='none'%3E%3Cpath d='M0,130 L0,74 C80,26 165,96 250,88 C332,80 386,40 470,52 C556,64 622,20 720,58 L720,130 Z' fill='%23E6EBD6'/%3E%3Cpath d='M0,130 L0,100 C110,68 195,112 300,104 C420,95 505,74 604,86 C662,93 692,104 720,98 L720,130 Z' fill='%23D6DFC4'/%3E%3C/svg%3E");
            background-size: 100% 100%; background-repeat: no-repeat;
          }
          .avo-bounce {
            font-size: 4.2rem; position: relative; z-index: 1;
            animation: avoBounce 1.1s cubic-bezier(0.4,0,0.2,1) infinite;
            filter: drop-shadow(0 8px 6px rgba(122,100,73,0.18));
          }
          .loading-brand {
            font-family: "Noto Serif TC", "Source Han Serif TC", "Songti TC", serif;
            position: relative; z-index: 1;
            margin-top: 22px; font-size: 1.35rem; font-weight: 600;
            color: #3E4C33; letter-spacing: 6px; text-indent: 6px;
            animation: fadeInUp 0.8s ease both;
          }
          .loading-sub {
            position: relative; z-index: 1;
            margin-top: 8px; font-size: 0.7rem; color: #9A7E5D;
            letter-spacing: 3px; text-transform: uppercase; opacity: 0.85;
            animation: fadeInUp 0.8s ease 0.2s both;
          }
          .loading-dots { position: relative; z-index: 1; display: flex; gap: 7px; margin-top: 26px; animation: fadeInUp 0.8s ease 0.4s both; }
          .loading-dots span { width: 7px; height: 7px; background: #9A7E5D; border-radius: 50%; animation: dotPulse 1.2s ease infinite; }
          .loading-dots span:nth-child(2) { animation-delay: 0.2s; }
          .loading-dots span:nth-child(3) { animation-delay: 0.4s; }
          .loading-msg {
            position: relative; z-index: 1;
            margin-top: 24px; font-size: 0.85rem; color: #4B5540; letter-spacing: 1px;
            opacity: 0.9; min-height: 1.2em; transition: opacity 0.25s ease;
            text-align: center; padding: 0 20px;
          }
          .loading-msg.is-fading { opacity: 0; }
          .loading-net {
            position: relative; z-index: 1;
            margin-top: 14px; font-size: 0.7rem; letter-spacing: 1.5px; color: #9A7E5D;
            opacity: 0; transition: opacity 0.4s ease; min-height: 1em;
          }
          .loading-net.is-on { opacity: 0.9; }
          @media (prefers-reduced-motion: reduce) {
            .avo-bounce, .loading-dots span { animation: none !important; }
          }
        </style>
        <div class="avo-bounce">🥑</div>
        <div class="loading-brand">波波酪梨</div>
        <div class="loading-sub">Pro-Bro Avo. | Earth to Table</div>
        <div class="loading-dots"><span></span><span></span><span></span></div>
        <div class="loading-msg" id="loading-msg"></div>
        <div class="loading-net" id="loading-net"></div>
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

// 🔌 在載入畫面上顯示即時連線狀態。
// 對客人是一句安心的話，對你是最快的診斷工具 ——
// 開賣前自己開一次網站，看到「即時庫存已連線」就知道整條鏈路是通的。
function setLoadingNet(text) {
  const el = document.getElementById('loading-net');
  if (!el) return;
  el.textContent = text;
  el.classList.add('is-on');
}

// ⚠️ 這個函式會整個換掉 <body>，呼叫之後不要再操作任何原本的元素。
//    配色同樣寫死，理由跟 showLoadingScreen 一樣。
function showLoadingError() {
  document.body.innerHTML = `
    <style>
      .load-error-screen {
        position: fixed; inset: 0; background: #EDE8DA;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        text-align: center; padding: 30px;
        font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
        z-index: 99999;
      }
      .load-error-icon { font-size: 3rem; margin-bottom: 16px; animation: loadErrorFloat 2.4s ease-in-out infinite; }
      @keyframes loadErrorFloat { 0%,100% { transform: translateY(0);} 50% { transform: translateY(-8px);} }
      .load-error-title {
        font-family: "Noto Serif TC", "Source Han Serif TC", "Songti TC", serif;
        font-size: 1.25rem; font-weight: 600; color: #3E4C33;
        letter-spacing: 3px; text-indent: 3px; margin-bottom: 12px;
      }
      .load-error-desc {
        font-size: 0.9rem; color: #4B5540; opacity: 0.9; line-height: 1.9;
        margin-bottom: 28px; max-width: 320px;
      }
      .load-error-btn {
        padding: 14px 34px; border-radius: 999px; border: 1px solid #6F8A54;
        background-color: #6F8A54; color: #FAF7EF; font-weight: 600;
        font-size: 0.95rem; letter-spacing: 2px; cursor: pointer;
      }
      .load-error-btn:hover { background-color: #5F7A46; border-color: #5F7A46; }
      @media (prefers-reduced-motion: reduce) { .load-error-icon { animation: none; } }
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
    updateOrderPageStopState(); // 若在瀏覽期間被停售，進來就要看得到
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
        // 🌫️ 點購物車外面就收起來（手機底部面板用）。
    //    遮罩是 #floating-cart 的 ::before，點到它時 target 會是容器本身，
    //    點到面板內容時 target 是子元素 —— 用這個差異判斷。
    //    把手自己有 stopPropagation，不會誤觸發。
    floatingCart.addEventListener('click', (e) => {
      if (e.target !== floatingCart) return;
      if (!window.matchMedia('(max-width: 767px)').matches) return;
      isOpen = false;
      floatingCart.classList.remove('show');
    });
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
  const methodEl = document.getElementById('shipping-method');
  const 單箱上限 = (methodEl && 限重表[methodEl.value]) || Infinity;
  
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

      // 📦 單一規格就超過單箱上限 → 這個配送方式寄不了
      if (w > 單箱上限) {
        html += `
          <div class="price-row">
            <div class="price-col weight">${w} 斤裝 <span>($${displayPrice})</span></div>
            <div class="price-col stock unreleased-badge">此配送方式無法寄送</div>
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

  // 價目表上的運費數字。id 對應到 運費欄位定義 的內部名稱，
  // 欄位名稱不在這裡重複寫，統一由上方的定義區提供。
  const 運費顯示位置 = {
    'ship-post-small':            '郵寄小',
    'ship-post-large':            '郵寄大',
    'ship-711':                   '711運費',
    'ship-blackcat-small':        '黑貓小',
    'ship-blackcat-large':        '黑貓大',
    'ship-post-island-small':     '郵寄離島小',
    'ship-post-island-large':     '郵寄離島大',
    'ship-blackcat-island-small': '黑貓離島小',
    'ship-blackcat-island-large': '黑貓離島大'
  };
  Object.keys(運費顯示位置).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerText = cfgNum(cfg, 運費欄位定義[運費顯示位置[id]]);
  });
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
  const unitPrice = 查單價(displayName);

  if (newQty === 0) delete cart[key];
  else cart[key] = { displayName, weight, qty: newQty, subtotal: unitPrice * weight * newQty };

  // 📦 總重不再有限制：超過單箱上限會自動拆成多箱，每箱各算一次運費。
  //    單一規格超過上限的情況由 renderProductList 停用按鈕擋掉。
  recalcTotalWeight();
  splitShipping = false;   // 購物車一有變動就重置回合併（靜默）
  refreshCartUI();
}

function refreshCartUI() {
  Object.keys(cart).forEach(key => {
    const item = cart[key];
    const unitPrice = 查單價(item.displayName);
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

  // 🔑 購物車被動過就整塊重繪，不只補數字。
  // updateStockDisplay() 只會改文字與按鈕的 disabled 狀態，
  // 品項從「可選購」變成「售罄」時，整列的結構其實需要換掉；
  // 客人關掉提示後看到的會是搶購前的舊版面，數量也對不起來。
  renderProductList();
  renderPriceMenu();
  refreshCartUI();

  customAlert('⚠️ 有品項剛好被其他客人買走，已為您自動調整購物車：\n\n' + 調整.join('\n'));
  return true;
}

function handleShippingChange() {
  const method = document.getElementById('shipping-method').value;

  // 配送方式一變就重置分箱選擇（靜默，不跳提示 —— 勾選框就在畫面上，看得到它彈回去）
  splitShipping = false;

  // 🔑 新配送方式的單箱上限可能比較小，購物車裡塞不下的規格要拿掉。
  //    例：先選宅配買了 10 斤裝，再改成 7-11。
  const limit = 限重表[method];
  if (limit) {
    const 移除 = [];
    Object.keys(cart).forEach(key => {
      if (cart[key].weight > limit) {
        移除.push(`${cart[key].displayName} ${cart[key].weight}斤`);
        delete cart[key];
      }
    });
    if (移除.length > 0) {
      customAlert(`⚠️ 「${配送名稱[method]}」單箱限重 ${limit} 斤，\n` +
                  `以下規格無法寄送，已從購物車移除：\n\n${移除.join('\n')}`);
    }
  }

  recalcTotalWeight();
  renderProductList();
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

  // 📦 裝箱：算出「最省」與「每件一箱」兩套方案，客人選哪套就用哪套
  合併方案 = null;
  分開方案 = null;
  let shippingFee = 0;
  let boxCount = 0;

  const limit = 限重表[method];
  const feeOf = 建立運費函式(method, isIsland);

  if (limit && feeOf && Object.keys(cart).length > 0) {
    const units = 購物車單位清單();
    合併方案 = 計算裝箱(units, limit, feeOf);
    分開方案 = 每件一箱(units, feeOf);

    if (合併方案) {
      const 採用 = splitShipping ? 分開方案 : 合併方案;
      shippingFee = 採用.fee;
      boxCount = 採用.boxes.length;
    }
  }

  finalSubtotal = subtotal;
  finalShippingFee = shippingFee;
  finalTotal = subtotal + shippingFee;
  finalBoxCount = boxCount;
  updateFloatingCart();
}

// ☐ 分開寄出。只由客人主動勾選改變，其餘任何變動都會重置回合併。
function toggleSplitShipping(on) {
  splitShipping = !!on;
  calculateCartTotal();
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
    container.innerHTML = '<div style="text-align:center; color:var(--avo-accent); opacity:0.8; padding:10px 0;">購物車空空如也</div>';
  }

 document.getElementById('floating-subtotal').innerHTML =
    `<span class="label">小計：</span><span class="amount">$${finalSubtotal}</span>`;

  // 📦 運費後面帶箱數。沒有它的話，「合併 / 不合併」這句話對客人沒有意義。
  const 箱數字 = finalBoxCount > 0 ? `（${finalBoxCount} 箱）` : '';
  document.getElementById('floating-shipping').innerHTML =
    `<span class="label">運費：</span><span class="amount">$${finalShippingFee}<span class="box-count">${箱數字}</span></span>`;

  document.getElementById('floating-total').innerHTML =
    `<span class="label">總計：</span><span class="amount">$${finalTotal}</span>`;

  renderSplitOption();

  const barSummary = document.getElementById('cart-bar-summary');
  if (barSummary) {
    const 件數 = visibleItems.reduce((n, i) => n + i.qty, 0);
    barSummary.textContent = 件數 > 0 ? `${件數} 項　$${finalTotal}` : '尚未選購';
    barSummary.classList.toggle('is-empty', 件數 === 0);
  }
}

/*************************************************************
 * ☐ 分開寄出選項
 *
 * 只在「合併確實比較便宜」而且「箱數差 ≤ 2」時才出現。
 * 差距太大（例如 5 個 1 斤裝，合併 1 箱 vs 分開 5 箱）就隱藏 ——
 * 那已經不是選擇而是陷阱，沒有人會選，擺著只會讓人困惑。
 *
 * 用否定式文案：預設不勾就是最省，客人什麼都不用做就是最好的結果。
 *************************************************************/
function renderSplitOption() {
  const box = document.getElementById('cart-merge-option');
  if (!box) return;

  if (!合併方案 || !分開方案 || 合併方案.boxes.length === 0) {
    box.style.display = 'none'; box.innerHTML = ''; return;
  }

  if (合併方案.degraded) {
    box.style.display = 'block';
    box.innerHTML = '<div class="cart-split-note">品項較多，運費以標準方式計算。' +
                    '若需要指定分箱方式，請在備註說明。</div>';
    return;
  }

  const 省下 = 分開方案.fee - 合併方案.fee;
  const 箱差 = 分開方案.boxes.length - 合併方案.boxes.length;

  if (省下 <= 0 || 箱差 <= 0 || 箱差 > 2) {
    box.style.display = 'none'; box.innerHTML = ''; return;
  }

  box.style.display = 'block';
  box.innerHTML =
    `<label class="cart-split-label">
       <input type="checkbox" id="cart-split-check" ${splitShipping ? 'checked' : ''}
              onchange="toggleSplitShipping(this.checked)">
       <span>分開寄出，共 ${分開方案.boxes.length} 箱（運費 $${分開方案.fee}）</span>
     </label>`;
}

// ========================================
// 🥑 品種頁
// ========================================
function renderVarieties() {
  const container = document.getElementById('varieties-container');
  if (!container) return;

  const data = window.allVarieties || (window.APP_CONFIG && window.APP_CONFIG.varieties) || [];
  if (data.length === 0) {
    container.innerHTML = '<p class="loading-note">目前尚無當季品種資訊。🥑</p>';
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

// ⚠️ v5：這裡原本會為 7-11 動態插入一則「離島不配送」的提示。
// 隨著離島阻擋一起移除了 —— 那則提示的意義建立在「送出會被擋」之上，
// 現在不擋了，留著會讓客人以為填了也沒用而直接離開。
// 未來若要加，會做成後台可控文案（跟 #shipping-note / #spec-note 同一套機制）。
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
      applySwitches(cfgGet(json.data['首頁'], '訂單開關') || '開', 讀取配送開關(json.data['訂購']));
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
      setLoadingNet(connected ? '🔥 即時庫存已連線' : '📡 使用備援連線中');
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
//
// 🔑 這裡的設計原則：「資料永遠即時更新，只有畫面延後」。
//
// 上一版把資料和畫面綁在一起延後，結果是送單期間 stockMap 完全凍住，
// verifyStockBeforeSubmit() 拿到的是按下按鈕那一瞬間的舊庫存 →
// 前端預檢查通過 → 白打一次 GAS → 被後端擋下來。
// 這在秒殺時特別糟：最積極的客人全部落在這條路徑上。
//
// 現在資料照常更新，只有「重繪畫面 / 修剪購物車 / 跳提示」這些
// 會干擾客人操作的動作被延後到送單結束。
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

  let stockMap;
  try {
    stockMap = JSON.parse(control.json);
  } catch (parseErr) {
    console.warn('控制節點庫存格式解析失敗', parseErr);
    return;
  }

  if (dataAt) lastControlDataAt = dataAt;

  // 🩺 記下後端最後一次推播的時間，用來判斷系統是否還活著
  const updatedAt = Number(control.updatedAt || 0);
  if (updatedAt > lastControlUpdatedAt) lastControlUpdatedAt = updatedAt;
  控制節點讀取失敗 = false;   // 🩺 撈到了就清掉失敗旗標
  
  // ---------- 資料層：無論如何都立刻更新 ----------
  const 舊開賣狀態 = isReleasedNow();

  applyReleaseStatus({
    releaseAt: control.releaseAt === undefined ? null : control.releaseAt,
    releaseDisplay: control.releaseDisplay || ''
  });

  orderSwitch = String(control.orderSwitch || '開').trim();
  paymentMode = String(control.paymentMode || 'payuni').trim();
  shippingSwitch = {
    post:     String((control.shipping && control.shipping.post) || '').trim(),
    '711':    String((control.shipping && control.shipping['711']) || '').trim(),
    blackcat: String((control.shipping && control.shipping.blackcat) || '').trim()
  };

  const newStockMap = {};
  Object.keys(stockMap || {}).forEach(k => {
    newStockMap[normKey(k)] = Math.max(0, Number(stockMap[k]) || 0);
  });
  window.APP_CONFIG.stockMap = newStockMap;

  // ---------- 畫面層：送單期間、或設定還沒載入完，都先延後 ----------
  // 資料已經收下了（stockMap / 開關 / 上架時間都是最新的），
  // 只是還沒有畫面可以套。載入完成時 flushPendingControl() 會補上。
  if (isSubmitting || !configLoaded) {
    uiNeedsRefresh = true;
    return;
  }

  refreshUiFromControl(舊開賣狀態);
}

// 把最新資料反映到畫面上。送單期間不呼叫，送完由 收尾() 補呼叫。
function refreshUiFromControl(舊開賣狀態) {
  // 開賣狀態如果因為你臨時改時間而翻轉，這裡先重繪一次；
  // 持續的狀態轉換仍然交給 ticker 負責（D1）。
  if (typeof 舊開賣狀態 === 'boolean' && isReleasedNow() !== 舊開賣狀態) {
    renderProductList();
    renderPriceMenu();
  }
  updateReleaseBanner();

  applySwitchesToDom();
  trimCartToStock();
  updateStockDisplay();
  calculateCartTotal();

  // Firebase 活著時不需要快照過期提示
  const staleEl = document.getElementById('stale-warning');
  if (staleEl && firebaseLive) staleEl.style.display = 'none';
}

// 把送單期間累積的畫面更新一次補上（送單流程結束時呼叫）
function flushPendingControl() {
  if (!uiNeedsRefresh) return;
  uiNeedsRefresh = false;
  refreshUiFromControl();
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

// 🧾 把一份收據套進成功頁需要的狀態，然後帶客人過去。
// 兩個地方會用到（送單前的重試檢查、送單後的逾時救援），抽出來避免走樣。
function 套用收據並前往成功頁(receipt, 收尾) {
  if (receipt && receipt.total !== undefined) {
    finalSubtotal    = Number(receipt.subtotal);
    finalShippingFee = Number(receipt.shippingFee);
    finalTotal       = Number(receipt.total);
    if (currentOrderSummary) {
      currentOrderSummary.subtotal    = finalSubtotal;
      currentOrderSummary.shippingFee = finalShippingFee;
      currentOrderSummary.total       = finalTotal;
      // 📦 舊訂單的收據沒有這個欄位，讀不到就給 0 → 成功頁自動隱藏那一列
      currentOrderSummary.boxCount    = Number(receipt.boxCount) || 0;
    }
  }
  cart = {};
  totalWeight = 0;
  currentOrderKey = null;
  收尾();
  goToStep(5);
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

  // 🛑 緊急煞車。舊版這裡沒有檢查，客人會一路填完才被後端擋下來。
  // 這一道同時保護 GAS：停售後的送出不會變成一次執行。
  if (window.APP_CONFIG && window.APP_CONFIG.priceConfigBroken) {
    customAlert('⚠️ 系統設定正在維護中，暫時無法送出訂單，造成不便敬請見諒。');
    updateOrderPageStopState();
    return;
  }
  if (orderSwitch === '關') {
    customAlert('🚫 不好意思，我們剛剛暫停接單了 🌱\n\n感謝您的支持，開放時會第一時間公告！');
    updateOrderPageStopState();
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

  // 🛑 v5：某個配送方式被臨時關閉的情況。
  //
  // applySwitchesToDom 只會把 <option> 設成 disabled，但「已經選中的值」
  // 不會被清掉 —— 客人在你關掉黑貓之前就選好了，畫面上完全沒有變化，
  // 他會一路填完、按送出、然後被後端打回票。
  // 秒殺時最積極的那群人正好都在這一頁，等於煞車對他們無效，
  // 而且每個人都白吃一次 GAS 執行數。
  if (shippingMethod && shippingSwitch[shippingMethod] !== '開') {
    customAlert(`🚫 不好意思，「${配送名稱[shippingMethod]}」剛剛暫停服務了 🌱\n\n` +
                `請改選其他配送方式，謝謝您的體諒！`);
    if (shippingMethodEl) {
      shippingMethodEl.value = '';
      shippingMethodEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    updateAddressSection();
    calculateCartTotal();
    return;
  }

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
    // 🏝️ v5：離島門市阻擋已移除（見檔案開頭的說明）。
    fullAddress = `7-11 門市：${storeEl.value.trim()}`;
  } else {
    customAlert('☝️請選擇配送方式！');
    return;
  }

  if (fullAddress.length > 120) { customAlert('☝️ 地址長度超過限制，請簡化填寫內容'); return; }

  recalcTotalWeight();

  // 📦 總重限制已移除。這裡只做最後一道保險：單一規格不得超過單箱上限。
  const 單箱上限 = 限重表[shippingMethod];
  const 超重 = Object.values(cart).filter(i => i.weight > 單箱上限);
  if (超重.length > 0) {
    customAlert(`❌ 「${配送名稱[shippingMethod]}」單箱限重 ${單箱上限} 斤，\n` +
                `購物車內有無法寄送的規格，請調整後再送出。`);
    return;
  }

  isSubmitting = true;
  submitBtn.innerText = '確認庫存中...';
  submitBtn.disabled = true;

  const 收尾 = () => {
    isSubmitting = false;
    submitBtn.disabled = false;
    submitBtn.innerText = '✅ 確認訂購';
    flushPendingControl();      // 補上送單期間延後的畫面更新
    updateOrderPageStopState(); // 期間若被停售，按鈕要維持灰色
  };

  // 🔴 v5：重試的話，先查一次收據再說。
  //
  // 修的是這條死路：第一次送出其實成功了（Google 回了 HTML 錯誤頁，
  // 客人看到「無法確認」），庫存已經扣掉。客人依照提示再按一次時 ——
  //
  //   舊版：跑庫存預檢查 → 發現不足（被自己買走的）→ 提示 →
  //         trimCartToStock() 清空購物車 → 再按只會說「購物車是空的」
  //         → 客人卡死，但他的訂單其實成立了
  //
  // 秒殺尾聲最容易踩到，因為那正是「最後一份被自己買走」的時刻。
  //
  // currentOrderKey 還在就代表這是重試（成功後會被清成 null），
  // 所以這道查詢完全不會影響第一次下單的速度。
  if (currentOrderKey) {
    submitBtn.innerText = '確認先前的訂單中...';
    const 先前收據 = await fetchOrderReceipt(currentOrderKey);
    if (先前收據) {
      console.info('重試前查到收據，這筆先前已經成立（第 ' + 先前收據.row + ' 列）');
      套用收據並前往成功頁(先前收據, 收尾);
      return;
    }
    submitBtn.innerText = '確認庫存中...';
  }

  // 送出前先校對一次庫存，避免客人白等 GAS。
  // 因為資料層已經改成永遠即時更新，這裡拿到的一定是最新庫存。
  const stockCheck = await verifyStockBeforeSubmit();
  if (!stockCheck.ok) {
    const lines = stockCheck.shortages.map(s =>
      `「${s.displayName} ${s.weight}斤」目前只剩 ${s.avail} 份（您選了 ${s.need} 份）`);
    // 先講清楚發生什麼事，再講我們幫他做了什麼。
    // 提示已改成佇列制，兩則都會依序看到，不會互相蓋掉。
    customAlert('⚠️ 不好意思，部分品項庫存剛好有異動：\n\n' + lines.join('\n'));
    收尾();          // 先解除 isSubmitting，trimCartToStock 才會發出調整通知
    trimCartToStock();
    return;
  }

  submitBtn.innerText = '處理中...';
  calculateCartTotal();

  // 🔁 同一筆訂單的重試共用同一組 orderKey。
  // 逾時情境下客人如果重按送出，後端會辨識出是同一筆、直接回傳成功，
  // 不會產生第二筆真訂單、也不會重複扣庫存。
  //
  // isRetry 讓後端知道要不要多查一次 Firebase 收據（A4）：
  // 後端的快取是可被驅逐的，尖峰時有機會失效；但只有重試才需要那道
  // 額外查詢，第一次下單不可能重複，就不必付那 150ms。
  const isRetry = !!currentOrderKey;
  if (!currentOrderKey) currentOrderKey = makeOrderKey();

  const orderData = {
    orderKey: currentOrderKey,
    isRetry: isRetry,
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
    district: districtEl ? districtEl.value : '',
    splitShipping: splitShipping
  };

  // 📊 GA4 識別碼（供後端補送 purchase 事件用）。
  //    寫在物件外面而不是用展開語法，相容性最穩。
  //    analytics.js 沒載入時整段跳過，送單完全不受影響。
  if (window.PBTrack) {
    const gaIds = PBTrack.getIds();
    orderData.gaClientId  = gaIds.gaClientId;
    orderData.gaSessionId = gaIds.gaSessionId;
    orderData.gaEnv       = gaIds.gaEnv;
  }

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
      currentOrderSummary.boxCount    = Number(json.totals.boxCount) || 0;   // 📦
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
      // ⚠️ 這是壓力測試裡最常見的情況：伺服器其實成功了，
      // 只是 Google 在壅塞時回傳 HTML 錯誤頁而不是 JSON。
      // 實測 60 併發時，三分之一的成功訂單會走到這裡。
      //
      // 所以先別急著跟客人說失敗 —— 去 Firebase 查收據，
      // 查到就代表訂單真的成立，直接帶他到成功頁。
      submitBtn.innerText = '確認訂單中...';
      const receipt = await waitForOrderReceipt(currentOrderKey, (n, total) => {
        submitBtn.innerText = `確認訂單中 (${n}/${total})...`;
      });

      if (receipt) {
        套用收據並前往成功頁(receipt, 收尾);
        return;
      }

      // 查不到才是真的無法確認。orderKey 刻意保留：
      // 客人再按一次時，後端會從快取辨識出是同一筆並直接回成功，
      // 絕不會變成兩筆訂單。而 v5 起前端還會在送出前先自己查一次收據，
      // 所以就算庫存已經被這筆扣光，他也不會卡在「庫存不足」。
      // 這裡要明確鼓勵他再按一次，而不是讓他自己猜該怎麼辦 ——
      // 猶豫的客人多半就直接放棄了。
      customAlert('⚠️ 系統目前比較忙碌，還在確認您的訂單。\n\n請稍等約一分鐘後「再按一次確認訂購」，\n系統會自動辨識，不會重複下單、也不會重複扣款。\n\n若仍然無法確認，請透過 LINE 或電話與我們聯繫，\n我們會直接為您查詢，謝謝您的耐心 🙏');
      收尾();
      return;
    } else {
      currentOrderKey = null; // 這是明確的失敗（例如庫存不足），下次是新的一筆
      customAlert(err.message || '送單失敗，請稍後再試');
      收尾();
      // 🔑 被後端擋下來通常代表庫存剛剛歸零。
      // 先用手上最新的資料重繪一次（客人立刻看到正確的畫面與購物車），
      // 再去抓一次即時層確認。順序不能反，否則客人會盯著舊畫面等網路。
      renderProductList();
      renderPriceMenu();
      trimCartToStock();
      refreshRealtime();
      return;
    }
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
// ✅ 成功頁（取代舊版 renderSuccessPage）
// ========================================
 
/**
 * ⚠️ 請用這一版取代 script.js 裡原本的 renderSuccessPage。
 *
 * 相對舊版的改動：
 *   ・拿掉匯款資訊與 LINE Pay QR 的填值（改由 渲染付款區塊 依模式決定）
 *   ・新增付款狀態讀取與訂閱
 *   ・金額仍然一律讀 currentOrderSummary，不讀 finalTotal（原因見下方註解）
 */
function renderSuccessPage() {
  if (!currentOrderSummary) return;
  const o = currentOrderSummary;
 
  // 🔑 金額一律讀 currentOrderSummary，不要讀 finalTotal。
  //
  // finalTotal 是「目前購物車」的即時總額，會被 calculateCartTotal() 重算。
  // 下單成功後購物車已經清空，只要那之後有任何一次重算
  // （送單期間收到的 Firebase 推播會在 收尾() 時補套用就會觸發），
  // finalTotal 會變成只剩運費 —— 成功頁顯示 $80 而不是 $330。
  // 訂單成交的金額是一個「快照」，不該再跟著購物車變動。
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val || ''; };
  set('final-amount-display', '$' + (Number(o.total) || 0) + ' 元');
 
  // 📦 箱數。拿不到就整列不顯示 —— 逾時救回的舊收據可能沒有這個欄位，
  //    寧可少一列，也不要印出「共 0 箱」讓客人以為出貨有問題。
  const 箱數 = Number(o.boxCount) || 0;
  const 箱數列 = 箱數 > 0
    ? `<div class="order-summary-row"><span class="label">📦 出貨箱數</span><span class="value">${箱數} 箱</span></div>`
    : '';
 
  const summaryEl = document.getElementById('order-summary-content');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="order-summary-list">
        <div class="order-summary-row"><span class="label">📦 規格細項</span><span class="value js-summary-weight"></span></div>
        ${箱數列}
        <div class="order-summary-row"><span class="label">🚚 配送方式</span><span class="value js-summary-shipping"></span></div>
        <div class="order-summary-row"><span class="label">🏠 收件地址(門市)</span><span class="value js-summary-address"></span></div>
        <div class="order-summary-row"><span class="label">💰 商品小計</span><span class="value">$${Number(o.subtotal) || 0}</span></div>
        <div class="order-summary-row"><span class="label">🚛 運費</span><span class="value">$${Number(o.shippingFee) || 0}</span></div>
      </div>`;
  }
 
  const weightContainer = document.querySelector('.js-summary-weight');
  if (weightContainer) {
    weightContainer.innerHTML = String(o.weight || '').split('，').map(i => `<div>${esc(i)}</div>`).join('');
  }
 
  const shippingEl = document.querySelector('.js-summary-shipping');
  if (shippingEl) shippingEl.textContent = 配送顯示名[o.shippingMethod] || o.shipping || '';
 
  const addressEl = document.querySelector('.js-summary-address');
  if (addressEl) addressEl.textContent = o.address || o.shipping || '';
 
  const msgEl = document.getElementById('success-reminder-msg');
  if (msgEl) {
    const rawMsg = (window.APP_CONFIG && window.APP_CONFIG.successMsg) || '謝謝您的支持！';
    msgEl.innerHTML = `<div class="success-warm-text">${esc(rawMsg)}</div>`;
  }
 
  // 💳 付款區：先用現有資料畫一次，再去 Firebase 撈實際狀態並持續訂閱。
  //    先畫是為了不讓畫面空白 —— 網路慢的時候那一秒很明顯。
  currentPayOrderKey = o.orderKey || null;
  渲染付款區塊(null);
 
  if (currentPayOrderKey && paymentMode === 'payuni') {
    查詢付款狀態(currentPayOrderKey).then(pay => {
      if (currentPayOrderKey === o.orderKey) 渲染付款區塊(pay);
    });
    訂閱付款狀態(currentPayOrderKey);
  }
}


// ========================================
// 🔗 從網址進入成功頁
// ========================================
 
/**
 * 處理 ?order={UUID}。兩種情況會走到這裡：
 *   ・客人從 PAYUNi 付款完成後被導回來
 *   ・客人自己開了保存起來的訂單連結
 *
 * 資料從 Firebase 收據撈，所以就算是換裝置、隔天再開也讀得到
 * （收據保留 72 小時）。
 */
async function 從網址載入訂單() {
  // orderKey 在檔案最頂端就已經從網址取出並清除（避免流進 GA4 的 page_location），
  // 所以這裡直接用那個變數，不要再讀 location.search —— 那時候已經是空的了。
  const key = 進站訂單Key;
  if (!key) return false;

  const receipt = await fetchOrderReceipt(key);
  if (!receipt) {
    customAlert('⚠️ 查不到這筆訂單，可能已超過保留期限。\n\n若有疑問請透過 LINE 與我們聯繫。');
    return false;
  }

  currentOrderSummary = {
    orderKey: key,
    subtotal: Number(receipt.subtotal) || 0,
    shippingFee: Number(receipt.shippingFee) || 0,
    total: Number(receipt.total) || 0,
    boxCount: Number(receipt.boxCount) || 0,
    weight: String(receipt.items || '').replace(/、/g, '，'),
    shipping: receipt.shipping || '',
    address: '',   // 收據不含地址（個資），這一列會顯示空白
    shippingMethod: ''
  };

  goToStep(5);
  return true;
}

// ========================================
// 🔧 通用工具
// ========================================
// 🔔 提示佇列（D2）
// 舊版是直接覆寫訊息文字，後一則會把前一則吃掉。
// 最常見的災情：送單被擋下時，「庫存不足」和「已為您自動調整購物車」
// 幾乎同時發出，客人只看得到其中一則，於是不知道購物車已經被改過了。
const alertQueue = [];
let alertShowing = false;

function customAlert(msg) {
  const text = String(msg == null ? '' : msg);
  if (!text) return;

  // 同一則訊息連續出現就不重複排隊（例如短時間內多次推播）
  if (alertQueue.length && alertQueue[alertQueue.length - 1] === text) return;

  alertQueue.push(text);
  if (!alertShowing) showNextAlert();
}

function showNextAlert() {
  const overlay = document.getElementById('custom-alert-overlay');
  const msgText = document.getElementById('alert-message');
  if (!overlay || !msgText) { alertQueue.length = 0; alertShowing = false; return; }

  if (alertQueue.length === 0) {
    alertShowing = false;
    overlay.style.display = 'none';
    return;
  }

  alertShowing = true;
  msgText.innerText = alertQueue.shift();
  overlay.style.display = 'flex';

  // 還有排隊中的訊息時，按鈕提示還有下一則
  const btn = overlay.querySelector('.btn-primary');
  if (btn) btn.innerText = alertQueue.length > 0 ? `確定（還有 ${alertQueue.length} 則）` : '確定';
}

function closeAlert() {
  showNextAlert(); // 顯示下一則；沒有了就自然關閉
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

// 📋 一鍵複製匯款帳號
//
// 資料直接讀 window.APP_CONFIG.bankAcc（來自試算表「4-匯款資訊」的匯款帳號），
// 所以你改後台就會跟著變，這裡不需要維護第二份。
//
// ⚠️ navigator.clipboard 需要 HTTPS（你的站是），但 LINE 內建瀏覽器
//    偶爾會拒絕授權，所以保留舊的 execCommand 作為後備。
//    兩條路都失敗時一定要講出來 —— 靜默失敗的話客人會以為複製好了，
//    貼到銀行 App 才發現是空白，那時候他已經離開這個頁面了。
async function 複製匯款帳號() {
  const btn = document.getElementById('copy-account-btn');
  const 帳號 = String((window.APP_CONFIG && window.APP_CONFIG.bankAcc) || '').trim();

  if (!帳號) {
    customAlert('⚠️ 目前讀不到匯款帳號，請重新整理頁面，\n或直接透過 LINE 與我們聯繫。');
    return;
  }

  let ok = false;
  try {
    await navigator.clipboard.writeText(帳號);
    ok = true;
  } catch (err) {
    try {
      const ta = document.createElement('textarea');
      ta.value = 帳號;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, 帳號.length);   // iOS 需要這一行才選得到
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e2) { ok = false; }
  }

  if (!ok) {
    customAlert('⚠️ 這個瀏覽器不支援自動複製，請長按帳號手動選取：\n\n' + 帳號);
    return;
  }

  if (btn) {
    btn.textContent = '✓ 已複製';
    btn.classList.add('is-done');
    clearTimeout(btn._resetTimer);
    btn._resetTimer = setTimeout(() => {
      btn.textContent = '複製';
      btn.classList.remove('is-done');
    }, 2000);
  }
}

function handleLineJump() {
  const targetUrl = String(cfgGet(window.paymentConfig, '跳轉按鈕連結') || '').trim();
  if (targetUrl.startsWith('http')) window.open(targetUrl, '_blank');
  else customAlert('✨ 感謝您的訂購！\n請手動回報匯款唷～ ✨');
}

// ========================================
// 💾 未完成訂單的本地記錄
// ========================================
 
const PENDING_ORDER_KEY = 'probro_pending_order';
 
/**
 * 記住這筆訂單，客人下次進站時提醒他還沒付款。
 *
 * ⚠️ 這是「加分」不是「保證」。localStorage 在換裝置、清快取、
 *    無痕模式、以及 LINE 內建瀏覽器與系統瀏覽器之間都不共用。
 *    失效的後果只是不跳提示 —— 不會出錯、不影響下單與付款，
 *    客人還是可以從訂單連結或聯繫我們處理。
 *    所以絕對不要在畫面上承諾「我們會幫你記住」。
 */
function 記住未付款訂單(orderKey, total) {
  if (!orderKey) return;
  try {
    localStorage.setItem(PENDING_ORDER_KEY, JSON.stringify({
      key: orderKey,
      total: Number(total) || 0,
      at: Date.now()
    }));
  } catch (e) { /* 無痕模式或空間不足，忽略 */ }
}
 
function 清除未付款訂單(orderKey) {
  try {
    const raw = localStorage.getItem(PENDING_ORDER_KEY);
    if (!raw) return;
    if (orderKey) {
      const rec = JSON.parse(raw);
      if (rec && rec.key !== orderKey) return;   // 不是同一筆就別動
    }
    localStorage.removeItem(PENDING_ORDER_KEY);
  } catch (e) { /* 忽略 */ }
}
 
function 讀取未付款訂單() {
  try {
    const raw = localStorage.getItem(PENDING_ORDER_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || !rec.key) return null;
    // 超過三天就不再提醒 —— 那時候訂單早就被取消了，
    // 還跳出來只會讓客人以為訂單還在。
    if (Date.now() - Number(rec.at || 0) > 3 * 86400000) {
      清除未付款訂單();
      return null;
    }
    return rec;
  } catch (e) { return null; }
}
 
/**
 * 進站時檢查有沒有未完成付款的訂單。
 * 會先去 Firebase 確認狀態 —— 已付款或已取消就不該再提醒。
 */
async function 檢查未付款訂單() {
  if (paymentMode !== 'payuni') return;
 
  const rec = 讀取未付款訂單();
  if (!rec) return;
 
  const pay = await 查詢付款狀態(rec.key);
  if (pay && (pay.tradeStatus === '1' || pay.status === '已付款')) {
    清除未付款訂單(rec.key);
    return;
  }
 
  const banner = document.getElementById('pending-order-banner');
  if (!banner) return;
 
  banner.innerHTML =
    '<div class="pending-banner-text">🥑 您有一筆訂單尚未完成付款' +
    (rec.total > 0 ? '　<strong>NT$ ' + rec.total + '</strong>' : '') +
    '</div>' +
    '<a class="pending-banner-btn" href="' + 付款連結(rec.key) + '">前往付款</a>' +
    '<button class="pending-banner-close" onclick="關閉未付款提示()" aria-label="關閉">✕</button>';
  banner.style.display = 'flex';
}
 
// 客人主動關掉就這一次不再打擾他。刻意不清除 localStorage ——
// 他下次進站還是會看到，因為那筆訂單確實還沒付款。
function 關閉未付款提示() {
  const banner = document.getElementById('pending-order-banner');
  if (banner) banner.style.display = 'none';
}
 
 
// ========================================
// 💳 付款狀態
// ========================================
 
function 付款連結(orderKey) {
  return PAY_WORKER_URL.replace(/\/+$/, '') + '/pay?k=' + encodeURIComponent(orderKey);
}
 
/**
 * 讀一次付款狀態。
 *
 * 回傳值有三種，呼叫端要分得出來：
 *   物件  → 有付款紀錄
 *   null  → 確實沒有這筆（正常，代表客人還沒進到金流）
 *   false → 查詢失敗（權限、網路、伺服器錯誤）
 *
 * ⚠️ 這裡曾經把三種情況全部回 null，結果是：
 *    Firebase 規則沒開 payments 讀取權限時，前端拿到 Permission denied
 *    卻被當成「還沒付款」—— ATM 虛擬帳號不顯示、已付款的訂單一直跳橫幅，
 *    而 console 一片乾淨，完全看不出原因。查了半小時才找到。
 *    失敗一定要能被區分出來，而且要在 console 留下痕跡。
 */
async function 查詢付款狀態(orderKey) {
  if (!orderKey) return null;

  const url = FIREBASE_DB_URL + '/' + FIREBASE_PAYMENTS_PATH + '/' +
              encodeURIComponent(orderKey) + '.json';

  try {
    const res = await fetch(url, { cache: 'no-store' });

    if (!res.ok) {
      const 內文 = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403 || 內文.indexOf('Permission denied') > -1) {
        console.error(
          '[付款狀態] ❌ Firebase 拒絕讀取 payments 節點。\n' +
          '　 這通常是資料庫規則沒有開放 payments/$orderKey 的讀取權限。\n' +
          '　 症狀：虛擬帳號不顯示、已付款仍跳未付款橫幅。\n' +
          '　 訂單：' + orderKey
        );
      } else {
        console.error('[付款狀態] ❌ 查詢失敗 HTTP ' + res.status + '：' + 內文.substring(0, 120));
      }
      return false;   // ⚠️ 不是 null —— 讓呼叫端知道「查不到」不等於「沒付款」
    }

    return await res.json();

  } catch (e) {
    console.error('[付款狀態] ❌ 連線失敗（可能是網路中斷）：' + e.message);
    return false;
  }
}
 
/**
 * 訂閱這筆訂單的付款狀態。
 *
 * 🔑 這是整個成功頁最有價值的一段：客人在別的分頁完成 ATM 轉帳、
 *    或用 LINE Pay 付完款回來時，這一頁會「自己」變成已付款，
 *    不需要他重新整理。少了這個，客人會盯著「待付款」懷疑自己是不是白付了。
 */
function 訂閱付款狀態(orderKey) {
  停止訂閱付款狀態();
  if (!orderKey || typeof firebase === 'undefined') return;
 
  try {
    payStatusRef = firebase.database().ref(FIREBASE_PAYMENTS_PATH + '/' + orderKey);
    payStatusRef.on('value', snap => {
      // 只在還停在成功頁、而且是同一筆訂單時才重繪
      if (currentPayOrderKey !== orderKey) return;
      渲染付款區塊(snap.val());
    }, () => { /* 訂閱失敗就靠進頁時那次讀取，不影響功能 */ });
  } catch (e) { /* SDK 沒載入就跳過 */ }
}
 
function 停止訂閱付款狀態() {
  if (payStatusRef) {
    try { payStatusRef.off(); } catch (e) { /* 忽略 */ }
    payStatusRef = null;
  }
}
 
 
// ========================================
// 🎨 付款區塊渲染
// ========================================
 
function 設定狀態列(current) {
  const steps = document.querySelectorAll('#pay-steps .pay-step');
  if (!steps.length) return;
  steps.forEach((el, i) => {
    el.classList.toggle('is-done', i < current);
    el.classList.toggle('is-current', i === current);
  });
}
 
function 設定付款標題(title, sub) {
  const t = document.getElementById('pay-title');
  const s = document.getElementById('pay-subtitle');
  if (t) t.textContent = title;
  if (s) s.textContent = sub;
}

/**
 * 依付款狀態渲染中間那張卡片。共五種樣貌：
 *   bank      → 舊的匯款資訊（逃生開關切到 bank 時）
 *   已付款    → 完成
 *   已取消    → 訂單已取消
 *   已取號    → 顯示虛擬帳號 / 繳費代碼
 *   未付款    → 前往付款按鈕
 */
function 渲染付款區塊(pay) {
  const box = document.getElementById('pay-action-content');
  if (!box) return;
 
  const orderKey = currentPayOrderKey;
 
  // 🛟 逃生開關：切到 bank 就完全走舊流程，一行程式碼都不用改。
  if (paymentMode !== 'payuni') {
    渲染匯款資訊(box);
    設定付款標題('已收到您的訂單', 'ORDER RECEIVED');
    設定狀態列(1);
    return;
  }
 
  if (!orderKey) {
    box.innerHTML = '<p class="pay-lead">訂單已建立，如需付款請透過 LINE 與我們聯繫。</p>';
    return;
  }
 
  const 已付款 = pay && (pay.tradeStatus === '1' || pay.status === '已付款');
  const 已取消 = pay && (pay.status === '已取消' || pay.status === '已退款');
 
  // ---------- 已付款 ----------
  if (已付款) {
    清除未付款訂單(orderKey);
    設定付款標題('付款完成', 'PAYMENT COMPLETED');
    設定狀態列(2);
    box.innerHTML =
      '<span class="pay-done-icon">🥑</span>' +
      '<p class="pay-lead">我們已收到您的付款，將盡快為您安排出貨。<br>感謝您的支持！</p>';
    return;
  }
 
  // ---------- 已取消 ----------
  if (已取消) {
    設定付款標題('訂單已取消', 'ORDER CANCELLED');
    設定狀態列(0);
    box.innerHTML =
      '<p class="pay-lead">這筆訂單已經取消。<br>如需重新訂購，請回到訂購頁面。</p>';
    return;
  }
 
  // ---------- 已取號（ATM / 超商代碼），尚未繳費 ----------
  const 是延遲付款 = pay && pay.payNo &&
    (pay.paymentMethod === 'ATM' || pay.paymentMethod === 'CVS');
 
  if (是延遲付款) {
    const isAtm = pay.paymentMethod === 'ATM';
    設定付款標題(isAtm ? '請完成轉帳' : '請至超商繳費', 'AWAITING PAYMENT');
    設定狀態列(1);
 
    box.innerHTML =
      '<div class="pay-field">' +
        '<p class="pay-field-label">' + (isAtm ? '虛擬帳號' : '繳費代碼') + '</p>' +
        '<p class="pay-field-value">' + esc(pay.payNo) + '</p>' +
        '<button type="button" class="btn-copy" onclick="複製付款帳號(\'' + esc(pay.payNo) + '\', this)">複製</button>' +
      '</div>' +
      (pay.expireDate
        ? '<div class="pay-field"><p class="pay-field-label">繳費期限</p>' +
          '<p class="pay-field-value" style="font-size:1.05rem">' + esc(pay.expireDate) + '</p></div>'
        : '') +
      '<p class="pay-lead" style="margin:18px 0 0">✨ 完成付款後，才會為您排入出貨序列</p>' +
      保存連結區塊(orderKey) +
      '<p class="pay-tail-note">若您中途離開，可以隨時回到這裡查看，訂單不會消失。</p>';
    return;
  }
 
  // ---------- 尚未付款 ----------
  設定付款標題('訂單已建立', 'ORDER CREATED');
  設定狀態列(1);
  記住未付款訂單(orderKey, (currentOrderSummary && currentOrderSummary.total) || 0);
 
  box.innerHTML =
    '<p class="pay-lead">✨ 完成付款後，才會為您排入出貨序列</p>' +
    '<a class="btn-primary" href="' + 付款連結(orderKey) + '">前往付款</a>' +
    保存連結區塊(orderKey) +
    '<p class="pay-tail-note">若您中途離開，可以隨時回到這裡重新付款，訂單不會消失。</p>';
}
 
function 保存連結區塊(orderKey) {
  return '<div class="pay-save">' +
    '<button type="button" class="btn-secondary" onclick="複製訂單連結(\'' + orderKey + '\', this)">保存訂單連結</button>' +
    '<p class="pay-save-note">建議複製起來傳給自己，隨時可以查看訂單與完成付款</p>' +
    '</div>';
}
 
// 這些字串會進 innerHTML，一律跳脫。
//
// ⚠️ 這個函式被 renderSuccessPage 與 渲染匯款資訊 兩處呼叫，
//    少了它整個成功頁會在第一行就丟 ReferenceError 而完全不渲染。
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** 逃生開關切到 bank 時，渲染舊的匯款資訊。
 *
 *  ⚠️ 三項刻意包在「同一張卡」裡而不是各自成框。
 *     銀行、帳號、戶名是一組要一起看的資訊 —— 客人是照著這三行
 *     填進網銀 App 的，拆成三個虛線框反而讓視線一直被打斷。
 *     只有帳號需要放大（那是唯一要逐字輸入的東西）。
 */
function 渲染匯款資訊(box) {
  const c = window.APP_CONFIG || {};
  const acc = String(c.bankAcc || '');
  box.innerHTML =
    '<div class="pay-field pay-bank">' +
      '<div class="pay-bank-row">' +
        '<span class="pay-bank-label">匯款銀行</span>' +
        '<span class="pay-bank-value">' + esc(c.bankName || '') + '</span>' +
      '</div>' +
      '<div class="pay-bank-row is-main">' +
        '<span class="pay-bank-label">匯款帳號</span>' +
        '<span class="pay-bank-value pay-bank-acc">' + esc(acc) + '</span>' +
      '</div>' +
      '<div class="pay-bank-row">' +
        '<span class="pay-bank-label">戶名</span>' +
        '<span class="pay-bank-value">' + esc(c.bankUser || '') + '</span>' +
      '</div>' +
      '<button type="button" class="btn-copy pay-bank-copy" ' +
        'onclick="複製付款帳號(\'' + esc(acc) + '\', this)">複製帳號</button>' +
    '</div>' +
    '<p class="pay-lead" style="margin:18px 0 0">✨ 完成匯款後，才會為您排入出貨序列</p>';
}
 
// ========================================
// 📋 複製工具
// ========================================
 
async function 複製文字_(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    // LINE 內建瀏覽器偶爾會拒絕 clipboard 授權，保留 execCommand 後備
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);   // iOS 需要這一行
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) { return false; }
  }
}
 
function 複製回饋_(btn, label) {
  if (!btn) return;
  const 原文 = btn.textContent;
  btn.textContent = '✓ 已複製';
  btn.classList.add('is-done');
  clearTimeout(btn._resetTimer);
  btn._resetTimer = setTimeout(() => {
    btn.textContent = label || 原文;
    btn.classList.remove('is-done');
  }, 2000);
}
 
async function 複製付款帳號(帳號, btn) {
  if (!帳號) { customAlert('⚠️ 目前讀不到帳號，請重新整理頁面。'); return; }
  const ok = await 複製文字_(帳號);
  if (!ok) {
    // 靜默失敗最糟：客人以為複製好了，貼到銀行 App 才發現是空的，
    // 而那時候他已經離開這個頁面了。
    customAlert('⚠️ 這個瀏覽器不支援自動複製，請長按號碼手動選取：\n\n' + 帳號);
    return;
  }
  複製回饋_(btn, '複製');
}
 
async function 複製訂單連結(orderKey, btn) {
  const url = 付款連結(orderKey);
  const ok = await 複製文字_(url);
  if (!ok) {
    customAlert('⚠️ 這個瀏覽器不支援自動複製，請長按下方網址手動選取：\n\n' + url);
    return;
  }
  複製回饋_(btn, '保存訂單連結');
}
