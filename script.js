/*************************************************************
 * 波波酪梨 script.js ｜ v7 樣式改版配套修改
 *
 * 這個檔案不是新的 script.js，是「要替換掉的四個完整函式」。
 * 在你現有的 script.js 裡找到同名函式，整個換掉即可，其餘不動。
 *
 * 1. applyConfigToPage()   — 新增「規格選擇備註」欄位
 * 2. showLoadingScreen()   — 載入畫面配色改成 v7（原本寫死舊綠色）
 * 3. showLoadingError()    — 錯誤畫面配色同上
 * 4. updateFloatingCart()  — 空購物車文字的寫死灰色改用品牌色
 *************************************************************/


/* ============================================================
   1️⃣ applyConfigToPage
   改動：新增 #spec-note，文字讀自試算表「3-訂購與運費」的
        「規格選擇備註」。順便讓 #shipping-note 沒內容時自動隱藏。
   ============================================================ */
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

  // 📝 兩個提示小字：沒填內容就整塊隱藏，避免留下一段空白。
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
  設定提示('spec-note',     cfgGet(訂購, '規格選擇備註'));   // 🆕

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


/* ============================================================
   2️⃣ showLoadingScreen
   改動：配色全部換成 v7 品牌色票。

   ⚠️ 為什麼這個重要：載入畫面的樣式是寫死在 JS 字串裡的，
      不會被 style.css 影響。原本是 #e9edc9 → #d4e09b 的亮綠漸層，
      客人進站看到亮綠色，兩秒後畫面切成米白 —— 中間那一下很突兀，
      而且那是整個品牌給人的第一印象。

   ⚠️ 這裡的顏色刻意寫死而不用 var()：載入畫面有可能在 style.css
      還沒下載完就先出現，那時候 CSS 變數是空的。
   ============================================================ */
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


/* ============================================================
   3️⃣ showLoadingError
   改動：配色與圓角換成 v7（按鈕改膠囊型，跟站上其他按鈕一致）
   ============================================================ */
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


/* ============================================================
   4️⃣ updateFloatingCart
   改動：只有空購物車那行的寫死灰色 #888 換成品牌暖褐色，其餘完全不變
   ============================================================ */
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

  document.getElementById('floating-subtotal').innerHTML = `<span class="label">小計：</span><span class="amount">$${finalSubtotal}</span>`;
  document.getElementById('floating-shipping').innerHTML = `<span class="label">運費：</span><span class="amount">$${finalShippingFee}</span>`;
  document.getElementById('floating-total').innerHTML = `<span class="label">總計：</span><span class="amount">$${finalTotal}</span>`;
}
