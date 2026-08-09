/*************************************************************
 * 波波酪梨 GA4 追蹤模組 — analytics.js  v2.0
 * 評估 ID：G-99EP460CDY
 *
 * 【為什麼用掛鉤（hook）而不是散進 script.js】
 *
 *   script.js 還在持續演進（目前 v5）。如果把追蹤程式碼散進九個
 *   插入點，每次改版都要重新對齊，而漏掉一處是「靜默失效」——
 *   事件不會報錯，只會安靜地不見，你要到看報表時才發現。
 *
 *   改成從外面包裝既有的全域函式之後：
 *     ・追蹤邏輯全部集中在這一個檔案
 *     ・script.js 只需要改一處（GA 識別碼塞進送單 payload）
 *     ・要停用就把 index.html 的那行 <script> 註解掉
 *
 * 【三條鐵則】
 *   1. 絕不弄壞下單。所有掛鉤都是「先呼叫原函式、拿到結果、
 *      再做追蹤」，追蹤那段包在 try/catch 裡。
 *   2. 絕不進入關鍵路徑。不攔截 fetch、不在送單前後加任何等待。
 *   3. purchase 以 orderKey 為 transaction_id，
 *      localStorage + 記憶體雙層去重。
 *
 * 【載入位置】index.html 的 </body> 之前，script.js 的「上面」：
 *   <script src="analytics.js?v=2.0"></script>
 *   <script src="script.js"></script>
 *************************************************************/

(function (global) {
  'use strict';

  /* ==========================================================
   *  設定
   * ========================================================== */
  var CONFIG = {
    MEASUREMENT_ID: 'G-99EP460CDY',
    CURRENCY: 'TWD',

    // 改 true 會把每個事件印在 console。
    // 也可以在 console 直接執行 PBTrack.debug(true)，不用改檔案。
    DEBUG: false,

    DEDUP_KEY: 'pb_ga4_sent_orders',
    DEDUP_MAX: 50,
    QUEUE_MAX: 30
  };

  /* ==========================================================
   *  內部狀態
   * ========================================================== */
  var _queue = [];
  var _clientId = null;
  var _sessionId = null;
  var _sentOrders = null;
  var _attemptNo = 0;
  var _submitInFlight = false;   // 送單進行中（判斷 alert 是不是送單失敗）
  var _listSent = false;
  var _checkoutSent = false;
  var _pageReadySent = false;
  var _wasReleased = null;
  var _wasSoldOut = null;
  var _pendingRecovered = false; // 這筆是不是 Firebase 收據救回來的
  var _hooksInstalled = false;

  /* ==========================================================
   *  基礎工具
   * ========================================================== */

  function log() {
    if (!CONFIG.DEBUG) return;
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift('%c[PBTrack]', 'color:#6F8A54;font-weight:bold');
      console.log.apply(console, a);
    } catch (e) { /* 忽略 */ }
  }

  function warn(msg, err) {
    try { console.warn('[PBTrack] ' + msg, err || ''); } catch (e) { /* 忽略 */ }
  }

  function safe(fn, label) {
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (err) {
        warn('事件 ' + label + ' 失敗（已忽略，不影響下單）', err);
        return null;
      }
    };
  }

  function gtagReady() {
    return typeof global.gtag === 'function';
  }

  function send(name, params) {
    params = params || {};
    params.browser_env = detectEnv();

    if (!gtagReady()) {
      if (_queue.length < CONFIG.QUEUE_MAX) {
        _queue.push({ name: name, params: params });
        log('佇列暫存（gtag 未就緒）:', name);
      }
      return;
    }
    global.gtag('event', name, params);
    log('送出:', name, params);
  }

  function flushQueue() {
    if (!gtagReady() || _queue.length === 0) return;
    var pending = _queue.slice();
    _queue = [];
    log('補送佇列中的 ' + pending.length + ' 筆事件');
    pending.forEach(function (e) {
      try { global.gtag('event', e.name, e.params); } catch (err) { warn('補送失敗', err); }
    });
  }

  /* ==========================================================
   *  環境辨識
   *
   *  LINE 的 in-app 瀏覽器會剝除 referrer，storage 行為也不穩定
   *  （client_id 可能每次都是新的 → 使用者數被高估）。
   *  每個事件都帶這個維度，報表才切得出來。
   * ========================================================== */
  function detectEnv() {
    try {
      var ua = (navigator.userAgent || '').toLowerCase();
      if (ua.indexOf('line/') !== -1 || ua.indexOf(' line') !== -1) return 'line_inapp';
      if (ua.indexOf('fban') !== -1 || ua.indexOf('fbav') !== -1) return 'facebook_inapp';
      if (ua.indexOf('instagram') !== -1) return 'instagram_inapp';
      return 'browser';
    } catch (e) { return 'unknown'; }
  }

  /* ==========================================================
   *  purchase 去重（記憶體 + localStorage 雙層）
   *
   *  單靠記憶體不夠：客人重整頁面、或 Firebase 收據把訂單救回來時
   *  會再走一次成功頁，那正是最容易重複計算營收的路徑。
   * ========================================================== */

  function loadSent() {
    if (_sentOrders) return _sentOrders;
    _sentOrders = {};
    try {
      var raw = global.localStorage.getItem(CONFIG.DEDUP_KEY);
      if (raw) JSON.parse(raw).forEach(function (k) { _sentOrders[k] = true; });
    } catch (e) {
      warn('localStorage 不可用（無痕模式？），去重降級為單分頁層級');
    }
    return _sentOrders;
  }

  function markSent(orderKey) {
    var store = loadSent();
    store[orderKey] = true;
    try {
      var keys = Object.keys(store);
      if (keys.length > CONFIG.DEDUP_MAX) {
        keys = keys.slice(keys.length - CONFIG.DEDUP_MAX);
        var trimmed = {};
        keys.forEach(function (k) { trimmed[k] = true; });
        _sentOrders = trimmed;
      }
      global.localStorage.setItem(CONFIG.DEDUP_KEY, JSON.stringify(keys));
    } catch (e) { /* 記憶體層仍有效 */ }
  }

  function alreadySent(orderKey) {
    return !!loadSent()[orderKey];
  }

  /* ==========================================================
   *  資料轉換 —— 配合 script.js 的實際結構
   *
   *  cart 的形狀：
   *    { '當季酪梨(隨機出貨)【優級】-3': {displayName, weight, qty, subtotal} }
   *
   *  單價刻意用 subtotal / qty 反推，不去查 價格表 ——
   *  價格表要透過 stockKeyMap 反查，而那是 const、外部拿不到。
   *  用 subtotal 反推結果一樣正確，而且少一層依賴。
   * ========================================================== */

  function cartToItems(cart) {
    var items = [];
    if (!cart) return items;
    Object.keys(cart).forEach(function (key, i) {
      var it = cart[key];
      if (!it || !it.qty) return;
      var qty = Number(it.qty) || 0;
      var unit = qty > 0 ? (Number(it.subtotal) || 0) / qty : 0;
      items.push({
        item_id: String(key),
        item_name: String(it.displayName || key),
        item_variant: (it.weight != null ? it.weight + '斤' : ''),
        price: Math.round(unit * 100) / 100,
        quantity: qty,
        index: i
      });
    });
    return items;
  }

  /** 從 stockMap + 價格表 組出「當期供應」清單（非產季的不列入） */
  function catalogItems() {
    var out = [];
    try {
      var pm = global.價格表 || {};
      var stock = (global.APP_CONFIG && global.APP_CONFIG.stockMap) || {};
      Object.keys(stock).forEach(function (k, i) {
        var m = String(k).match(/^(.+)-(\d+(?:\.\d+)?)$/);
        if (!m) return;
        var unit = Number(pm[m[1]]) || 0;
        if (unit <= 0) return;
        out.push({
          item_id: k,
          item_name: m[1],
          item_variant: m[2] + '斤',
          price: unit * Number(m[2]),
          quantity: 1,
          index: i
        });
      });
    } catch (e) { /* 忽略 */ }
    return out;
  }

  function totalStock() {
    try {
      var s = (global.APP_CONFIG && global.APP_CONFIG.stockMap) || {};
      return Object.keys(s).reduce(function (a, k) { return a + (Number(s[k]) || 0); }, 0);
    } catch (e) { return -1; }
  }

  /* ==========================================================
   *  client_id / session_id
   *  這兩個值要隨訂單送進 GAS，後端補送 purchase 時才能歸到
   *  同一位使用者、同一次工作階段（否則會變成孤兒流量）。
   * ========================================================== */

  function captureIds() {
    if (!gtagReady()) return;
    try {
      global.gtag('get', CONFIG.MEASUREMENT_ID, 'client_id', function (v) {
        if (v) { _clientId = v; log('client_id =', v); }
      });
      global.gtag('get', CONFIG.MEASUREMENT_ID, 'session_id', function (v) {
        if (v) { _sessionId = v; log('session_id =', v); }
      });
    } catch (e) { warn('取得 client_id 失敗', e); }
  }

  /** cookie 備援（gtag get 在某些 in-app 瀏覽器會靜默失敗） */
  function parseIdsFromCookie() {
    try {
      document.cookie.split(';').forEach(function (raw) {
        var c = raw.trim();
        if (!_clientId && c.indexOf('_ga=') === 0) {
          var p = c.substring(4).split('.');
          if (p.length >= 4) _clientId = p[2] + '.' + p[3];
        }
        if (!_sessionId && c.indexOf('_ga_') === 0) {
          var q = (c.split('=')[1] || '').split('.');
          if (q.length >= 3) _sessionId = q[2];
        }
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ==========================================================
   *  對外 API
   * ========================================================== */

  var PBTrack = {

    version: '2.0',

    /**
     * 送單 payload 要帶的識別碼。
     * 這是唯一需要你在 script.js 手動加的東西（見部署說明第 3 步）。
     */
    getIds: safe(function () {
      if (!_clientId || !_sessionId) parseIdsFromCookie();
      return {
        gaClientId: _clientId || '',
        gaSessionId: _sessionId || '',
        gaEnv: detectEnv()
      };
    }, 'getIds'),

    /* ---------- 標準電商事件 ---------- */

    viewItemList: safe(function () {
      var items = catalogItems();
      if (items.length === 0) return;
      send('view_item_list', { item_list_name: '當期供應', items: items });
    }, 'view_item_list'),

    addToCart: safe(function (item) {
      if (!item) return;
      send('add_to_cart', {
        currency: CONFIG.CURRENCY,
        value: (Number(item.price) || 0) * (Number(item.quantity) || 0),
        items: [item]
      });
    }, 'add_to_cart'),

    removeFromCart: safe(function (item) {
      if (!item) return;
      send('remove_from_cart', {
        currency: CONFIG.CURRENCY,
        value: (Number(item.price) || 0) * (Number(item.quantity) || 0),
        items: [item]
      });
    }, 'remove_from_cart'),

    beginCheckout: safe(function () {
      send('begin_checkout', {
        currency: CONFIG.CURRENCY,
        value: Number(global.finalSubtotal) || 0,
        items: cartToItems(global.cart)
      });
    }, 'begin_checkout'),

    addShippingInfo: safe(function (method) {
      var 名稱 = { post: '中華郵政', '711': '7-11超商', blackcat: '黑貓宅急便' };
      send('add_shipping_info', {
        currency: CONFIG.CURRENCY,
        value: Number(global.finalSubtotal) || 0,
        shipping_tier: 名稱[method] || String(method || '未指定'),
        items: cartToItems(global.cart)
      });
    }, 'add_shipping_info'),

    /**
     * 訂單成立。
     * order = { orderKey, total, subtotal, shippingFee, cart, shippingMethod, source }
     */
    purchase: safe(function (order) {
      if (!order || !order.orderKey) {
        warn('purchase 缺少 orderKey，已略過');
        return false;
      }

      // 這筆是收據救回來的？（旗標由「套用收據並前往成功頁」掛鉤設定）
      if (_pendingRecovered) {
        order.source = 'recovery';
        _pendingRecovered = false;
      }

      var key = String(order.orderKey);
      if (alreadySent(key)) {
        log('訂單 ' + key + ' 已送過 purchase，略過（去重生效）');
        return false;
      }

      var 名稱 = { post: '中華郵政', '711': '7-11超商', blackcat: '黑貓宅急便' };

      send('purchase', {
        transaction_id: key,
        currency: CONFIG.CURRENCY,
        value: Number(order.total) || 0,
        shipping: Number(order.shippingFee) || 0,
        items: cartToItems(order.cart),
        shipping_tier: 名稱[order.shippingMethod] || '',
        order_source: order.source || 'frontend'
      });

      markSent(key);
      return true;
    }, 'purchase'),

    /* ---------- 秒殺營運事件 ---------- */

    salePageReady: safe(function () {
      _attemptNo = 0;

      // 順手建立售罄基準。不在這裡建的話，要等第一次 applyControl
      // 才有比較對象 —— 而那一次推播如果剛好就是「歸零」的那一次，
      // sold_out 會被當成「初始狀態」而漏掉。
      var t0 = totalStock();
      if (t0 >= 0) _wasSoldOut = (t0 === 0);

      send('sale_page_ready', {
        stock_total: totalStock(),
        is_released: (typeof global.isReleasedNow === 'function')
          ? String(global.isReleasedNow()) : 'unknown',
        firebase_live: String(!!global.firebaseLive)
      });
    }, 'sale_page_ready'),

    saleOpen: safe(function () {
      send('sale_open', { stock_total: totalStock() });
    }, 'sale_open'),

    submitAttempt: safe(function () {
      _attemptNo += 1;
      send('order_submit_attempt', {
        attempt_no: _attemptNo,
        cart_value: Number(global.finalTotal) || 0,
        item_count: global.cart ? Object.keys(global.cart).length : 0
      });
      return _attemptNo;
    }, 'order_submit_attempt'),

    /**
     * 送單失敗。reason 用固定字串方便報表分組：
     *   lock_timeout        鎖等待逾時（「系統目前非常忙碌」）
     *   timeout_unconfirmed 送出後無法確認，Firebase 收據也還沒查到
     *   stock_precheck      前端庫存預檢查擋下
     *   sold_out            庫存不足
     *   order_closed        已暫停接單
     *   shipping_closed     該配送方式已關閉
     *   not_released        尚未開賣
     *   weight_limit        超過限重
     *   config_broken       價格設定壞掉
     *   unknown             其他
     */
    submitFail: safe(function (reason, detail) {
      send('order_submit_fail', {
        fail_reason: String(reason || 'unknown'),
        fail_detail: String(detail || '').slice(0, 100),
        attempt_no: _attemptNo
      });
    }, 'order_submit_fail'),

    orderRecovered: safe(function (orderKey, source) {
      send('order_recovered', {
        transaction_id: String(orderKey || ''),
        attempt_no: _attemptNo,
        recovery_source: source || 'unknown'
      });
    }, 'order_recovered'),

    soldOut: safe(function () {
      send('sold_out', { attempt_no: _attemptNo });
    }, 'sold_out'),

    retryPrompted: safe(function () {
      send('retry_prompted', { attempt_no: _attemptNo });
    }, 'retry_prompted'),

    /**
     * 頁面步驟。你的網站是純 SPA（goToStep 只切 display，網址完全不變），
     * 一次造訪只會有一個 page_view —— 沒有這個事件的話，
     * GA4 完全看不到客人走到哪一步就離開了。
     */
    funnelStep: safe(function (step) {
      var 名稱 = { 1: '公告', 2: '品種介紹', 3: '價目表', 4: '訂購表單', 5: '完成頁' };
      send('funnel_step', {
        step_number: Number(step) || 0,
        step_name: 名稱[step] || String(step)
      });
    }, 'funnel_step'),

    /* ---------- 除錯 ---------- */

    debug: safe(function (on) {
      CONFIG.DEBUG = (on !== false);
      var info = {
        version: PBTrack.version,
        clientId: _clientId,
        sessionId: _sessionId,
        env: detectEnv(),
        queued: _queue.length,
        hooksInstalled: _hooksInstalled,
        sentOrders: Object.keys(loadSent())
      };
      console.log('[PBTrack] 狀態', info);
      return info;
    }, 'debug'),

    /** 清掉去重紀錄（測試用，正式環境不要呼叫） */
    resetDedup: safe(function () {
      _sentOrders = {};
      try { global.localStorage.removeItem(CONFIG.DEDUP_KEY); } catch (e) { /* 忽略 */ }
      log('去重紀錄已清空');
    }, 'resetDedup')
  };

  global.PBTrack = PBTrack;


  /*************************************************************
   *  掛鉤區
   *
   *  以下全部是「包裝 script.js 的既有全域函式」。
   *  每一個都是：先呼叫原函式拿結果 → 再追蹤 → 回傳原結果。
   *  追蹤那段包 try/catch，這裡任何錯誤都不會影響下單。
   *************************************************************/

  function wrap(name, before, after) {
    var orig = global[name];
    if (typeof orig !== 'function') {
      warn('找不到函式 ' + name + '，該項追蹤不會運作');
      return false;
    }
    global[name] = function () {
      var ctx = {};
      var args = arguments;
      if (before) {
        try { before(ctx, args); } catch (e) { warn(name + ' before hook', e); }
      }

      var result = orig.apply(this, args);

      if (after) {
        // 原函式若回傳 Promise（submitOrder 是 async），要等它結束再追蹤
        if (result && typeof result.then === 'function') {
          return result.then(function (v) {
            try { after(ctx, args, v); } catch (e) { warn(name + ' after hook', e); }
            return v;
          }, function (err) {
            try { after(ctx, args, undefined); } catch (e) { /* 忽略 */ }
            throw err;
          });
        }
        try { after(ctx, args, result); } catch (e) { warn(name + ' after hook', e); }
      }
      return result;
    };
    return true;
  }

  /* 失敗訊息比對表。
   * 只在「送單進行中」才比對，所以不會誤抓平常挑商品的提示。
   * 文案哪天改了，最壞情況是落到 unknown，不會壞掉。 */
  var FAIL_PATTERNS = [
    { re: /系統目前非常忙碌/,       reason: 'lock_timeout' },
    { re: /還在確認您的訂單/,       reason: 'timeout_unconfirmed' },
    { re: /部分品項庫存剛好有異動/, reason: 'stock_precheck' },
    { re: /庫存不足|庫存只剩/,      reason: 'sold_out' },
    { re: /暫停接單/,               reason: 'order_closed' },
    { re: /暫停服務/,               reason: 'shipping_closed' },
    { re: /尚未開賣/,               reason: 'not_released' },
    { re: /限重/,                   reason: 'weight_limit' },
    { re: /系統設定正在維護中/,     reason: 'config_broken' }
  ];

  function installHooks() {
    if (_hooksInstalled) return;
    _hooksInstalled = true;

    /* ── 1. goToStep：漏斗步驟 + 成功頁的 purchase ───────────────
     *
     * purchase 統一在這裡送。兩條成功路徑（正常送單成功、
     * Firebase 收據救回）最後都會走到 goToStep(5)，
     * 所以放一個點就涵蓋全部，不會漏也不會重複。
     */
    wrap('goToStep', null, function (ctx, args) {
      var step = Number(args[0]);
      PBTrack.funnelStep(step);

      if ((step === 3 || step === 4) && !_listSent) {
        _listSent = true;
        PBTrack.viewItemList();
      }

      if (step === 5) {
        var o = global.currentOrderSummary;
        if (o && o.orderKey) {
          PBTrack.purchase({
            orderKey: o.orderKey,
            total: o.total,
            subtotal: o.subtotal,
            shippingFee: o.shippingFee,
            cart: o.cart,
            shippingMethod: o.shippingMethod
          });
        } else {
          warn('走到成功頁但找不到 currentOrderSummary.orderKey，purchase 未送出');
        }
      }
    });

    /* ── 2. updateCart：加入 / 移除購物車 ─────────────────────── */
    wrap('updateCart',
      function (ctx, args) {
        var key = args[0];
        var c = global.cart || {};
        ctx.key = key;
        ctx.before = c[key]
          ? { qty: c[key].qty, subtotal: c[key].subtotal,
              displayName: c[key].displayName, weight: c[key].weight }
          : null;
      },
      function (ctx, args) {
        var c = global.cart || {};
        var beforeQty = ctx.before ? ctx.before.qty : 0;
        var nowItem = c[ctx.key];
        var afterQty = nowItem ? nowItem.qty : 0;
        var delta = afterQty - beforeQty;

        // 被限重或庫存擋掉時數量沒真的變，不算一次加入購物車
        if (delta === 0) return;

        var src = nowItem || ctx.before;
        var unit = (src && src.qty) ? (Number(src.subtotal) || 0) / src.qty : 0;
        var item = {
          item_id: String(ctx.key),
          item_name: String((src && src.displayName) || args[3] || ctx.key),
          item_variant: (args[2] != null ? args[2] + '斤' : ''),
          price: Math.round(unit * 100) / 100,
          quantity: Math.abs(delta)
        };

        if (delta > 0) PBTrack.addToCart(item);
        else PBTrack.removeFromCart(item);
      });

    /* ── 3. handleShippingChange：選擇配送方式 ─────────────────── */
    wrap('handleShippingChange', null, function () {
      var el = document.getElementById('shipping-method');
      if (el && el.value) PBTrack.addShippingInfo(el.value);
    });

    /* ── 4. submitOrder：送出嘗試 + 標記送單進行中 ───────────────
     *
     * _submitInFlight 是失敗判定的關鍵：只有送單期間跳出的提示
     * 才算 order_submit_fail，平常挑商品的提示不會被誤判。
     */
    wrap('submitOrder',
      function () {
        _submitInFlight = true;
        PBTrack.submitAttempt();
      },
      function () {
        _submitInFlight = false;
      });

    /* ── 5. customAlert：把失敗提示轉成 order_submit_fail ─────── */
    wrap('customAlert', function (ctx, args) {
      if (!_submitInFlight) return;
      var msg = String(args[0] || '');
      if (!msg) return;

      for (var i = 0; i < FAIL_PATTERNS.length; i++) {
        if (FAIL_PATTERNS[i].re.test(msg)) {
          PBTrack.submitFail(FAIL_PATTERNS[i].reason, msg.slice(0, 60));
          if (FAIL_PATTERNS[i].reason === 'timeout_unconfirmed') PBTrack.retryPrompted();
          return;
        }
      }
      PBTrack.submitFail('unknown', msg.slice(0, 60));
    });

    /* ── 6. 套用收據並前往成功頁：Firebase 救回的訂單 ─────────────
     *
     * 這個事件價值最高 —— 它量化的是壓測時看到的「客戶端顯示失敗、
     * 伺服器其實成功」那 25%，而且是在真實流量下量的。
     */
    wrap('套用收據並前往成功頁', function (ctx, args) {
      var key = global.currentOrderKey ||
                (global.currentOrderSummary && global.currentOrderSummary.orderKey) || '';
      PBTrack.orderRecovered(key, _submitInFlight ? 'timeout_recovery' : 'retry_precheck');
      _pendingRecovered = true;   // 讓接下來的 goToStep(5) 知道這筆是救回來的
      log('收據救回訂單', key, args[0]);
    });

    /* ── 7. begin_checkout：客人開始填收件資料 ───────────────────
     *
     * 你的流程是「選配送 → 選規格 → 填資料 → 送出」，
     * 真正的「開始結帳」是他把手放到姓名欄的那一刻，
     * 而不是進入第 4 頁（進第 4 頁時他連配送方式都還沒選）。
     */
    ['cust-name', 'cust-phone'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('focus', function () {
        if (_checkoutSent) return;
        _checkoutSent = true;
        PBTrack.beginCheckout();
      });
    });

    /* ── 8. applyControl：售罄偵測 ─────────────────────────────── */
    wrap('applyControl', null, function () {
      var t = totalStock();
      if (t < 0) return;
      var soldOut = (t === 0);
      if (_wasSoldOut === null) { _wasSoldOut = soldOut; return; }
      if (soldOut && !_wasSoldOut) PBTrack.soldOut();
      _wasSoldOut = soldOut;
    });

    log('掛鉤安裝完成');
  }


  /*************************************************************
   *  啟動
   *************************************************************/

  // 開賣瞬間偵測。用自己的 ticker 而不是掛鉤 script.js 的 ——
  // 那個 setInterval 是匿名的，掛不上去。
  function startReleaseWatcher() {
    if (typeof global.isReleasedNow !== 'function') return;
    try {
      _wasReleased = global.isReleasedNow();
    } catch (e) { return; }

    if (_wasReleased) return;   // 進站時就已開賣，沒有「開賣瞬間」可抓

    var timer = setInterval(function () {
      try {
        if (global.isReleasedNow() && !_wasReleased) {
          _wasReleased = true;
          PBTrack.saleOpen();
          clearInterval(timer);
        }
      } catch (e) {
        clearInterval(timer);
      }
    }, 1000);
  }

  function boot() {
    flushQueue();
    captureIds();

    setTimeout(function () {
      if (!_clientId || !_sessionId) parseIdsFromCookie();
      flushQueue();
    }, 1500);

    installHooks();

    // 等 script.js 的 window.onload 跑完（configLoaded 變 true）再送
    // sale_page_ready，這樣庫存與開賣狀態才是有意義的數字。
    //
    // 先立刻檢查一次：頁面若是從 bfcache 返回，configLoaded 可能
    // 早就是 true 了，沒必要再空等半秒。
    if (global.configLoaded) {
      _pageReadySent = true;
      PBTrack.salePageReady();
      startReleaseWatcher();
      return;
    }

    var tries = 0;
    var readyTimer = setInterval(function () {
      tries++;
      if (global.configLoaded) {
        clearInterval(readyTimer);
        if (!_pageReadySent) { _pageReadySent = true; PBTrack.salePageReady(); }
        startReleaseWatcher();
      } else if (tries > 60) {   // 30 秒還沒好就放棄，不要一直空轉
        clearInterval(readyTimer);
        warn('等待 configLoaded 逾時，sale_page_ready 未送出');
      }
    }, 500);
  }

  /* ⚠️ 一定要用 DOMContentLoaded。
   *
   * 這個檔案在 script.js「之前」載入（因為 script.js 要呼叫
   * PBTrack.getIds），所以此刻 script.js 的函式還不存在，掛不了鉤。
   * DOMContentLoaded 時兩個檔案都已解析完成，全域函式都在了。
   *
   * 也刻意不用 window.onload = —— script.js 用的是賦值寫法，
   * 誰後執行誰就會蓋掉對方。addEventListener 兩邊都能活。
   */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window);
