/**
 * ===================================================================
 * 波波酪梨 GA4 追蹤模組  analytics.js  v1.0
 * ===================================================================
 *
 * 設計原則（秒殺場景專用）：
 *   1. 絕對不能拖慢或中斷下單流程 —— 所有對外 API 都包 try/catch，
 *      任何內部錯誤都只寫 console，不往外拋。
 *   2. gtag 尚未載入（網速慢 / 被廣告阻擋器擋掉）時，事件進佇列，
 *      載入後補送；佇列有上限，不會無限膨脹。
 *   3. purchase 事件以 orderKey 為 transaction_id，並用
 *      localStorage 做去重 —— 客人重整頁面、Firebase 補救訂單
 *      重送，都不會重複計算營收。
 *   4. 前端只負責「即時」，完整性交給後端 Measurement Protocol。
 *
 * 使用方式：在 script.js 之前載入
 *   <script src="analytics.js"></script>
 *   <script src="script.js"></script>
 *
 * 全域 API：window.PBTrack
 * ===================================================================
 */

(function (global) {
  'use strict';

  /* ============================================================
   *  設定區 —— 部署前只要改這裡
   * ============================================================ */
  var CONFIG = {
    // GA4 資料串流的評估 ID，格式 G-XXXXXXXXXX
    MEASUREMENT_ID: 'G-99EP460CDY',

    CURRENCY: 'TWD',

    // true 時所有事件會印在 console，方便你自己驗證
    // 正式上線請改回 false
    DEBUG: false,

    // 去重用的 localStorage key 與保留筆數
    DEDUP_KEY: 'pb_ga4_sent_orders',
    DEDUP_MAX: 50,

    // gtag 尚未就緒時的事件佇列上限
    QUEUE_MAX: 30
  };

  /* ============================================================
   *  內部狀態
   * ============================================================ */
  var _queue = [];           // gtag 未就緒時的暫存
  var _flushed = false;      // 佇列是否已排空
  var _clientId = null;      // GA4 client_id（給後端補送用）
  var _sessionId = null;     // GA4 session_id（給後端補送用）
  var _sentOrders = null;    // 已送出的 orderKey 集合（記憶體層）
  var _attemptNo = 0;        // 本次送單嘗試次數

  /* ============================================================
   *  基礎工具
   * ============================================================ */

  function log() {
    if (!CONFIG.DEBUG) return;
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('%c[PBTrack]', 'color:#7a8b6f;font-weight:bold');
      console.log.apply(console, args);
    } catch (e) { /* 忽略 */ }
  }

  function warn(msg, err) {
    try { console.warn('[PBTrack] ' + msg, err || ''); } catch (e) { /* 忽略 */ }
  }

  /** 把任何函式包成「絕對不會往外拋錯」的版本 */
  function safe(fn, label) {
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (err) {
        warn('事件 ' + label + ' 執行失敗（已忽略，不影響下單）', err);
        return null;
      }
    };
  }

  function gtagReady() {
    return typeof global.gtag === 'function';
  }

  /** 送出事件；gtag 未就緒則進佇列 */
  function send(name, params) {
    params = params || {};

    // 全域附帶維度：讓你可以在報表裡切 LINE / 一般瀏覽器
    params.browser_env = detectEnv();

    if (!gtagReady()) {
      if (_queue.length < CONFIG.QUEUE_MAX) {
        _queue.push({ name: name, params: params });
        log('佇列暫存（gtag 未就緒）:', name);
      } else {
        warn('佇列已滿，丟棄事件 ' + name);
      }
      return;
    }

    global.gtag('event', name, params);
    log('送出:', name, params);
  }

  function flushQueue() {
    if (_flushed || !gtagReady() || _queue.length === 0) return;
    log('補送佇列中的 ' + _queue.length + ' 筆事件');
    var pending = _queue.slice();
    _queue = [];
    _flushed = true;
    pending.forEach(function (e) {
      try { global.gtag('event', e.name, e.params); } catch (err) { warn('補送失敗', err); }
    });
  }

  /* ============================================================
   *  環境偵測 —— LINE in-app 瀏覽器辨識
   *  （LINE webview 會剝除 referrer，且 storage 行為不穩定，
   *    報表上必須能把它切出來單獨看）
   * ============================================================ */
  function detectEnv() {
    try {
      var ua = (navigator.userAgent || '').toLowerCase();
      if (ua.indexOf('line/') !== -1 || ua.indexOf(' line') !== -1) return 'line_inapp';
      if (ua.indexOf('fban') !== -1 || ua.indexOf('fbav') !== -1) return 'facebook_inapp';
      if (ua.indexOf('instagram') !== -1) return 'instagram_inapp';
      return 'browser';
    } catch (e) {
      return 'unknown';
    }
  }

  /* ============================================================
   *  去重機制
   *  記憶體 Set（同分頁）+ localStorage（跨分頁 / 跨重整）雙層
   * ============================================================ */

  function loadSentOrders() {
    if (_sentOrders) return _sentOrders;
    _sentOrders = {};
    try {
      var raw = global.localStorage.getItem(CONFIG.DEDUP_KEY);
      if (raw) {
        JSON.parse(raw).forEach(function (k) { _sentOrders[k] = true; });
      }
    } catch (e) {
      // 無痕模式 / storage 被封鎖 —— 降級成只有記憶體層，可接受
      warn('localStorage 不可用，去重降級為單分頁層級');
    }
    return _sentOrders;
  }

  function markOrderSent(orderKey) {
    var store = loadSentOrders();
    store[orderKey] = true;
    try {
      var keys = Object.keys(store);
      if (keys.length > CONFIG.DEDUP_MAX) {
        keys = keys.slice(keys.length - CONFIG.DEDUP_MAX);
        var trimmed = {};
        keys.forEach(function (k) { trimmed[k] = true; });
        _sentOrders = store = trimmed;
      }
      global.localStorage.setItem(CONFIG.DEDUP_KEY, JSON.stringify(keys));
    } catch (e) { /* 降級：記憶體層仍有效 */ }
  }

  function alreadySent(orderKey) {
    return !!loadSentOrders()[orderKey];
  }

  /* ============================================================
   *  商品資料正規化
   *  接受多種欄位命名，轉成 GA4 標準 items 陣列
   * ============================================================ */
  function pick(obj, names, fallback) {
    for (var i = 0; i < names.length; i++) {
      if (obj[names[i]] !== undefined && obj[names[i]] !== null && obj[names[i]] !== '') {
        return obj[names[i]];
      }
    }
    return fallback;
  }

  function normalizeItem(raw, index) {
    if (!raw) return null;
    if (typeof raw === 'string') {
      return { item_id: raw, item_name: raw, index: index };
    }
    var name = pick(raw, ['item_name', 'name', 'productName', '品名', '品種'], '未命名商品');
    var id = pick(raw, ['item_id', 'id', 'sku', 'code', '編號'], name);
    var price = Number(pick(raw, ['price', 'unitPrice', 'unit_price', '單價'], 0)) || 0;
    var qty = Number(pick(raw, ['quantity', 'qty', 'count', 'amount', '數量'], 1)) || 1;

    var item = {
      item_id: String(id),
      item_name: String(name),
      price: price,
      quantity: qty,
      index: index
    };

    var variety = pick(raw, ['variety', 'spec', 'size', '規格'], null);
    if (variety) item.item_variant = String(variety);

    return item;
  }

  function normalizeItems(list) {
    if (!list) return [];
    if (!Array.isArray(list)) list = [list];
    return list.map(normalizeItem).filter(Boolean);
  }

  function sumValue(items) {
    return items.reduce(function (s, it) {
      return s + (Number(it.price) || 0) * (Number(it.quantity) || 0);
    }, 0);
  }

  /* ============================================================
   *  client_id / session_id 取得
   *  這兩個值要隨訂單送到 GAS，後端補送 purchase 時才能
   *  歸到同一位使用者、同一次工作階段
   * ============================================================ */

  function captureIds() {
    if (!gtagReady()) return;
    try {
      global.gtag('get', CONFIG.MEASUREMENT_ID, 'client_id', function (v) {
        if (v) { _clientId = v; log('client_id =', v); }
      });
      global.gtag('get', CONFIG.MEASUREMENT_ID, 'session_id', function (v) {
        if (v) { _sessionId = v; log('session_id =', v); }
      });
    } catch (e) {
      warn('取得 client_id 失敗', e);
    }
  }

  /** cookie 備援解析（gtag get 失效時使用） */
  function parseIdsFromCookie() {
    try {
      var cookies = document.cookie.split(';');
      for (var i = 0; i < cookies.length; i++) {
        var c = cookies[i].trim();
        // _ga=GA1.1.<client_id_part1>.<part2>
        if (!_clientId && c.indexOf('_ga=') === 0) {
          var p = c.substring(4).split('.');
          if (p.length >= 4) _clientId = p[2] + '.' + p[3];
        }
        // _ga_XXXXXXX=GS1.1.<session_id>.<session_num>...
        if (!_sessionId && c.indexOf('_ga_') === 0) {
          var v = c.split('=')[1] || '';
          var q = v.split('.');
          if (q.length >= 3) _sessionId = q[2];
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ============================================================
   *  對外 API
   * ============================================================ */

  var PBTrack = {

    /** 版本標記，方便你在 console 確認部署版本 */
    version: '1.0',

    /* ---------- 初始化 ---------- */

    init: safe(function () {
      flushQueue();
      captureIds();
      setTimeout(function () {
        if (!_clientId || !_sessionId) parseIdsFromCookie();
        flushQueue();
      }, 1200);
      log('模組啟動，環境 =', detectEnv());
    }, 'init'),

    /** 取得要塞進送單 payload 的識別碼（後端補送用） */
    getIds: safe(function () {
      if (!_clientId || !_sessionId) parseIdsFromCookie();
      return {
        gaClientId: _clientId || '',
        gaSessionId: _sessionId || '',
        gaEnv: detectEnv()
      };
    }, 'getIds'),

    /* ---------- 標準電商事件 ---------- */

    /** 商品列表曝光。items = 當期上架的所有品項 */
    viewItemList: safe(function (items, listName) {
      var norm = normalizeItems(items);
      if (norm.length === 0) return;
      send('view_item_list', {
        item_list_name: listName || '當期供應',
        items: norm
      });
    }, 'view_item_list'),

    /** 點開單一商品 */
    viewItem: safe(function (item) {
      var norm = normalizeItems(item);
      if (norm.length === 0) return;
      send('view_item', {
        currency: CONFIG.CURRENCY,
        value: sumValue(norm),
        items: norm
      });
    }, 'view_item'),

    /** 加入購物車 */
    addToCart: safe(function (item, quantity) {
      var norm = normalizeItems(item);
      if (norm.length === 0) return;
      if (quantity) norm[0].quantity = Number(quantity) || norm[0].quantity;
      send('add_to_cart', {
        currency: CONFIG.CURRENCY,
        value: sumValue(norm),
        items: norm
      });
    }, 'add_to_cart'),

    /** 移除購物車項目 */
    removeFromCart: safe(function (item) {
      var norm = normalizeItems(item);
      if (norm.length === 0) return;
      send('remove_from_cart', {
        currency: CONFIG.CURRENCY,
        value: sumValue(norm),
        items: norm
      });
    }, 'remove_from_cart'),

    /** 開始填訂購表單 —— 漏斗最重要的起點 */
    beginCheckout: safe(function (cartItems) {
      var norm = normalizeItems(cartItems);
      send('begin_checkout', {
        currency: CONFIG.CURRENCY,
        value: sumValue(norm),
        items: norm
      });
    }, 'begin_checkout'),

    /** 選定配送方式（宅配 / 7-11 等） */
    addShippingInfo: safe(function (cartItems, shippingTier) {
      var norm = normalizeItems(cartItems);
      send('add_shipping_info', {
        currency: CONFIG.CURRENCY,
        value: sumValue(norm),
        shipping_tier: String(shippingTier || '未指定'),
        items: norm
      });
    }, 'add_shipping_info'),

    /**
     * 訂單成立 —— 全站最重要的事件
     * order = {
     *   orderKey  : 訂單編號（必填，作為 transaction_id 去重依據）
     *   total     : 總金額（請用後端回傳的金額，不要用前端算的）
     *   shipping  : 運費
     *   items     : 商品陣列
     *   source    : 'frontend' | 'recovery'（選填，標記來源）
     * }
     */
    purchase: safe(function (order) {
      if (!order || !order.orderKey) {
        warn('purchase 缺少 orderKey，已略過');
        return false;
      }
      var key = String(order.orderKey);

      if (alreadySent(key)) {
        log('訂單 ' + key + ' 已送過 purchase，略過（去重生效）');
        return false;
      }

      var norm = normalizeItems(order.items);
      var value = Number(order.total);
      if (!value || isNaN(value)) value = sumValue(norm);

      send('purchase', {
        transaction_id: key,
        currency: CONFIG.CURRENCY,
        value: value,
        shipping: Number(order.shipping) || 0,
        items: norm,
        order_source: order.source || 'frontend'
      });

      markOrderSent(key);
      return true;
    }, 'purchase'),

    /* ---------- 秒殺營運事件（自訂） ---------- */

    /** 頁面就緒、客人開始等待開賣 */
    salePageReady: safe(function (meta) {
      meta = meta || {};
      _attemptNo = 0;
      send('sale_page_ready', {
        release_at: meta.releaseAt || '',
        stock_total: Number(meta.stockTotal) || 0,
        order_switch: meta.orderSwitch === undefined ? '' : String(meta.orderSwitch)
      });
    }, 'sale_page_ready'),

    /** 倒數歸零、按鈕解鎖的那一刻 */
    saleOpen: safe(function (meta) {
      meta = meta || {};
      send('sale_open', {
        stock_total: Number(meta.stockTotal) || 0
      });
    }, 'sale_open'),

    /** 按下送出（每按一次都送，attempt_no 會自動遞增） */
    submitAttempt: safe(function (meta) {
      meta = meta || {};
      _attemptNo += 1;
      send('order_submit_attempt', {
        attempt_no: _attemptNo,
        cart_value: Number(meta.total) || 0,
        item_count: Number(meta.itemCount) || 0
      });
      return _attemptNo;
    }, 'order_submit_attempt'),

    /**
     * 送單失敗
     * reason 建議固定用這幾個值，方便報表分組：
     *   'lock_timeout'  鎖等待逾時
     *   'network'       網路 / GAS 逾時
     *   'rejected'      後端拒單（庫存不足、重複訂單等）
     *   'sold_out'      售罄
     *   'validation'    表單驗證未過
     *   'unknown'       其他
     */
    submitFail: safe(function (reason, detail) {
      send('order_submit_fail', {
        fail_reason: String(reason || 'unknown'),
        fail_detail: String(detail || '').slice(0, 100),
        attempt_no: _attemptNo
      });
    }, 'order_submit_fail'),

    /**
     * 由 Firebase receipt 救回的訂單
     * 呼叫這個之後請「同時」呼叫 purchase()，
     * 去重機制會自動避免重複計算營收
     */
    orderRecovered: safe(function (meta) {
      meta = meta || {};
      send('order_recovered', {
        transaction_id: String(meta.orderKey || ''),
        attempt_no: _attemptNo,
        recovery_wait_ms: Number(meta.waitMs) || 0
      });
    }, 'order_recovered'),

    /** 售罄 */
    soldOut: safe(function (meta) {
      meta = meta || {};
      send('sold_out', {
        variety: String(meta.variety || '全品項'),
        seconds_since_open: Number(meta.secondsSinceOpen) || 0
      });
    }, 'sold_out'),

    /** 客人點了「等 3 秒再按一次」的重試提示 */
    retryPrompted: safe(function (reason) {
      send('retry_prompted', {
        fail_reason: String(reason || 'unknown'),
        attempt_no: _attemptNo
      });
    }, 'retry_prompted'),

    /* ---------- 除錯輔助 ---------- */

    /** 在 console 執行 PBTrack.debug(true) 可即時打開日誌 */
    debug: safe(function (on) {
      CONFIG.DEBUG = (on !== false);
      log('DEBUG =', CONFIG.DEBUG, '| clientId =', _clientId, '| sessionId =', _sessionId);
      return { clientId: _clientId, sessionId: _sessionId, env: detectEnv(), queued: _queue.length };
    }, 'debug'),

    /** 清掉去重紀錄（測試用，正式環境不要呼叫） */
    resetDedup: safe(function () {
      _sentOrders = {};
      try { global.localStorage.removeItem(CONFIG.DEDUP_KEY); } catch (e) { /* 忽略 */ }
      log('去重紀錄已清空');
    }, 'resetDedup')
  };

  global.PBTrack = PBTrack;

  // 自動初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', PBTrack.init);
  } else {
    PBTrack.init();
  }

})(window);
