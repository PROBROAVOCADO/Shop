// ========================================
// ⭐ 請將這裡換成你的 GAS Web App 網址
// ========================================
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwbkKqipfPrimFs7-d6ZorySDv0g5yhq_vbGGp2xmWZm2diNsblTfMjwP8kz-Hx9iRDTQ/exec';

// ========================================
// 🌟 核心變數與狀態
// ========================================
var 價格表 = {}, 運費表 = {};

// 🏝️ 台灣離島判定清單（全境算離島的縣市 + 縣市下特定離島鄉鎮）
// 如認定範圍需調整，改這兩個陣列即可
const 離島縣市 = ['澎湖縣', '金門縣', '連江縣'];
const 離島鄉鎮 = ['綠島鄉', '蘭嶼鄉', '琉球鄉'];

function isIslandAddress(county, district) {
  if (!county) return false;
  if (離島縣市.includes(county)) return true;
  if (district && 離島鄉鎮.includes(district)) return true;
  return false;
}
var finalSubtotal = 0, finalShippingFee = 0, finalTotal = 0;
var isInitialLoad = true;
var currentOrderSummary = null;
var cart = {};
var totalWeight = 0;
var isOpen = false; // 控制浮動購物車是否展開

// 顯示名稱 → stockMap key 的對照表
const stockKeyMap = {
  '平克頓/哈斯 (隨機出貨)【優級】': '平克頓/哈斯【優級】',
  '平克頓/哈斯 (隨機出貨)【次級】': '平克頓/哈斯【次級】',
  '當季酪梨(隨機出貨)【優級】': '當季酪梨(隨機出貨)【優級】',
  '當季酪梨(隨機出貨)【次級】': '當季酪梨(隨機出貨)【次級】'
};

// ========================================
// 🚀 頁面啟動：向 GAS 拿資料，再初始化畫面
// ========================================
window.onload = async function () {

  // 顯示載入中提示
  showLoadingScreen(true);

  try {
    // 向 GAS 取得所有設定資料
    const res = await fetch(GAS_URL + '?action=getConfig');
    const json = await res.json();

    if (!json.success) throw new Error('GAS 回傳失敗');

    const cfg = json.data;

    // 填入 window.APP_CONFIG（和原本 GAS 注入的格式一樣）
    window.APP_CONFIG = {
      mainTitle:     cfg['首頁']['網頁大標題'] || '波波酪梨',
      orderSwitch:   cfg['首頁']['訂單開關'] || '開',
      bankName:      cfg['匯款']['匯款銀行'] || '',
      bankAcc:       cfg['匯款']['匯款帳號'] || '',
      bankUser:      cfg['匯款']['戶名'] || '',
      linePayMsg:    cfg['匯款']['LINE_PAY公告'] || '',
      linePayImgId:  cfg['匯款']['LINE_PAY圖片ID'] || '',
      successMsg:    cfg['匯款']['成功頁提醒文字'] || '',
      stockData:     cfg['庫存'] || {},
      orderConfig:   cfg['訂購'] || {},
      addressMap:    cfg['地址對照'] || {},
      varieties:     cfg['品種'] || []
    };

    window.allVarieties = cfg['品種'] || [];
    window.paymentConfig = cfg['匯款'] || {};

    // 填入頁面靜態文字
    applyConfigToPage(cfg);

    // 初始化 stockMap（統一 key 去空格）
    window.APP_CONFIG.stockMap = {};
    const rawStock = window.APP_CONFIG.stockData || {};
    Object.keys(rawStock).forEach(k => {
      const normalizedKey = k.replace(/\s+/g, '');
      window.APP_CONFIG.stockMap[normalizedKey] = Number(rawStock[k]) || 0;
    });

    const data = window.APP_CONFIG.orderConfig || {};

    // 建立價格表
    價格表 = {
      '當季酪梨(隨機出貨)【優級】': Number(data['當季酪梨( 隨機出貨 )【優級】單價']) || 0,
      '當季酪梨(隨機出貨)【次級】': Number(data['當季酪梨( 隨機出貨 )【次級】單價']) || 0,
      '平克頓/哈斯【優級】': Number(data['平克頓/哈斯【優級】單價']) || 0,
      '平克頓/哈斯【次級】': Number(data['平克頓/哈斯【次級】單價']) || 0
    };

    運費表 = {
      郵寄小: Number(data['郵寄七斤(不含)以下']) || 100,
      郵寄大: Number(data['郵寄七斤(包含)以上']) || 120,
      '711運費': Number(data['711運費']) || 80,
      黑貓小: Number(data['黑貓配送七斤(不含)以下']) || 100,
      黑貓大: Number(data['黑貓配送七斤(包含)以上']) || 120,
      郵寄離島小: Number(data['郵寄離島七斤(不含)以下']) || 150,
      郵寄離島大: Number(data['郵寄離島七斤(包含)以上']) || 180,
      黑貓離島小: Number(data['黑貓配送離島七斤(不含)以下']) || 150,
      黑貓離島大: Number(data['黑貓配送離島七斤(包含)以上']) || 180
    };

    // 訂購頁插圖卡片
    const cardImgId1 = data['訂購頁插圖ID_1'] || '';
    const cardImgId2 = data['訂購頁插圖ID_2'] || '';
    const cardText   = data['訂購頁插圖文字'] || '';
    const middleCard = document.getElementById('order-middle-card');

    setTimeout(() => {
      if (middleCard && (cardImgId1 || cardImgId2 || cardText)) {
        middleCard.style.display = 'block';
        const img1 = document.getElementById('order-card-img1');
        if (img1 && cardImgId1) img1.src = 'https://lh3.googleusercontent.com/d/' + cardImgId1;
        const img2 = document.getElementById('order-card-img2');
        if (img2 && cardImgId2) img2.src = 'https://lh3.googleusercontent.com/d/' + cardImgId2;
        const textElement = document.getElementById('order-card-text');
        if (textElement && cardText) {
          textElement.innerText = cardText;
          textElement.style.display = 'block';
          textElement.style.cssText = 'text-align:center; color:var(--avo-dark); font-size:0.95rem; margin-top:15px; line-height:1.6; font-weight:500; opacity:0.85;';
        }
      }
    }, 0);

    // 渲染 UI
    setTimeout(renderProductList, 0);
    setTimeout(renderVarieties, 0);
    setTimeout(renderPriceMenu, 0);
    setTimeout(initAddressSelector, 0);
    initShippingAddressToggle();

    // 開關狀態
    const btn = document.getElementById('order-enter-btn');
    if (btn && window.APP_CONFIG.orderSwitch === '關') {
      btn.classList.add('is-disabled');
      btn.innerText = '🚫 現在暫停接單';
    }

    setTimeout(() => { isInitialLoad = false; }, 0);

  } catch (err) {
    console.error('初始化失敗：', err);
    showLoadingError();
  } finally {
    showLoadingScreen(false);
  }
};

// ========================================
// 🖼️ 把 GAS 資料填入頁面靜態元素
// ========================================
function applyConfigToPage(cfg) {
  const h = cfg['首頁'] || {};
  const 訂購 = cfg['訂購'] || {};

  // 標題
  const mainTitle = document.getElementById('main-title');
  if (mainTitle) mainTitle.textContent = h['網頁大標題'] || '波波酪梨';

  // 網頁 title
  document.title = h['分頁標題'] || '波波酪梨｜線上訂購';

  // 公告
  const annTitle = document.getElementById('announcement-title');
  if (annTitle) annTitle.textContent = h['公告區標題'] || '最新公告';

  const annContent = document.getElementById('announcement-content');
  if (annContent) annContent.innerHTML = (h['公告內容'] || '').replace(/\n/g, '<br>');

  // 品種頁大標題
  const varietyTitle = document.getElementById('variety-title');
  if (varietyTitle) varietyTitle.textContent = h['品種分頁大標題'] || '我們的當季酪梨';

  // 訂購頁大標題
  const orderTitle = document.getElementById('order-title');
  if (orderTitle) orderTitle.textContent = h['訂購分頁大標題'] || '訂購資訊';

  // 配送備註
  const shippingNote = document.getElementById('shipping-note');
  if (shippingNote) shippingNote.textContent = 訂購['配送方式備註'] || '';

  // 配送選項 disabled 狀態
  const optPost = document.getElementById('opt-post');
  const opt711  = document.getElementById('opt-711');
  if (optPost) {
    optPost.disabled = 訂購['中華郵政配送'] !== '開';
    optPost.textContent = 訂購['中華郵政配送'] === '開'
      ? '📫 中華郵政 (限重10斤內)'
      : '📫 中華郵政（目前不支援）';
  }
  if (opt711) {
    opt711.disabled = 訂購['7-11超取配送'] !== '開';
    opt711.textContent = 訂購['7-11超取配送'] === '開'
      ? '🏪 7-11 超商取件 ($80 / 限重7斤內)'
      : '🏪 7-11（目前不支援）';
  }

  const optBlackcat = document.getElementById('opt-blackcat');
  if (optBlackcat) {
    optBlackcat.disabled = 訂購['黑貓配送'] !== '開';
    optBlackcat.textContent = 訂購['黑貓配送'] === '開'
      ? '🐈\u200d⬛ 黑貓宅急便 (限重10斤內)'
      : '🐈\u200d⬛ 黑貓宅急便（目前不支援）';
  }

  // 匯款跳轉按鈕名稱
  const lineBtn = document.getElementById('final-line-btn');
  if (lineBtn) lineBtn.textContent = cfg['匯款']['跳轉按鈕名稱'] || '確認匯款回報';

  // 頂部橫幅
  const bannerId = h['網頁頂部橫幅網址'] || '';
  if (bannerId) {
    const bannerContainer = document.getElementById('banner-container');
    const bannerImg = document.getElementById('banner-img');
    if (bannerContainer && bannerImg) {
      bannerImg.src = 'https://lh3.googleusercontent.com/d/' + bannerId;
      bannerContainer.style.display = 'block';
    }
  }
}

// ========================================
// ⏳ 載入中畫面（簡易版）
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
          @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes dotPulse {
            0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
            40% { opacity: 1; transform: scale(1.2); }
          }
          #loading-screen {
            position: fixed; top: 0; left: 0;
            width: 100%; height: 100%;
            background: linear-gradient(160deg, #e9edc9 0%, #d4e09b 100%);
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            z-index: 99999;
            transition: opacity 0.5s ease;
          }
          .avo-bounce {
            font-size: 5rem;
            animation: avoBounce 1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
            filter: drop-shadow(0 10px 8px rgba(0,0,0,0.15));
          }
          .loading-brand {
            margin-top: 20px;
            font-size: 1.4rem;
            font-weight: 900;
            color: #576e37;
            letter-spacing: 4px;
            animation: fadeInUp 0.8s ease both;
          }
          .loading-sub {
            margin-top: 6px;
            font-size: 0.75rem;
            color: #76944a;
            letter-spacing: 3px;
            opacity: 0.8;
            animation: fadeInUp 0.8s ease 0.2s both;
          }
          .loading-dots {
            display: flex;
            gap: 6px;
            margin-top: 24px;
            animation: fadeInUp 0.8s ease 0.4s both;
          }
          .loading-dots span {
            width: 8px; height: 8px;
            background: #76944a;
            border-radius: 50%;
            animation: dotPulse 1.2s ease infinite;
          }
          .loading-dots span:nth-child(2) { animation-delay: 0.2s; }
          .loading-dots span:nth-child(3) { animation-delay: 0.4s; }
        </style>
        <div class="avo-bounce">🥑</div>
        <div class="loading-brand">波波酪梨</div>
        <div class="loading-sub">Pro-Bro Avo. | Earth to Table</div>
        <div class="loading-dots">
          <span></span><span></span><span></span>
        </div>
      `;
      document.body.appendChild(el);
    }
    el.style.opacity = '1';
    el.style.display = 'flex';
  } else {
    if (el) {
      el.style.opacity = '0';
      setTimeout(() => { el.style.display = 'none'; }, 500);
    }
  }
}

function showLoadingError() {
  document.body.innerHTML = '<div style="text-align:center;padding:60px;font-size:1.1rem;color:#576e37;">🥑 資料載入失敗，請重新整理頁面試試。</div>';
}


// ========================================
// 以下全部原版保留，完全不動
// ========================================

function goToStep(step) {
  document.querySelectorAll('.page-content').forEach(p => {
    p.style.display = 'none';
  });

  const pageMap = {
    1: 'step1-announcement',
    2: 'step2-varieties',
    3: 'step3-price-list',
    4: 'step4-order-form',
    5: 'step5-payment-info'
  };

  const targetId = pageMap[step];
  const targetPage = document.getElementById(targetId);
  if (targetPage) targetPage.style.display = 'block';

  if (step === 5) {
    renderSuccessPage();
    setTimeout(() => {
      const successCard = document.querySelector('#step5-payment-info .info-block');
      if (successCard) successCard.classList.add('success-animate');
    }, 100);
    setTimeout(() => { fireConfetti(); }, 200);
  }

  if (step === 3) {
    setTimeout(() => { renderPriceMenu(); }, 0);
  }

  if (step === 4) {
    setTimeout(() => {
      renderProductList();
      updateAddressSection();
      calculateCartTotal();
    }, 0);
  }

  window.scrollTo(0, 0);
}

document.addEventListener('DOMContentLoaded', () => {
  const fields = document.querySelectorAll('#cust-name, #cust-phone, #delivery-address, #order-note');
  fields.forEach(field => {
    field.addEventListener('blur', () => {
      if (field.value.trim() !== '') {
        field.classList.add('input-completed');
        setTimeout(() => { field.classList.remove('input-completed'); }, 600);
      }
    });
  });

  const floatingBtn = document.getElementById('floating-checkout');
  if (floatingBtn) floatingBtn.addEventListener('click', () => { goToStep(4); });

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

function renderProductList() {
  const container = document.getElementById('product-list-container');
  if (!container) return;

  const cfg = window.APP_CONFIG.orderConfig || {};
  const stockMap = window.APP_CONFIG.stockMap || {};

  const categories = [
    { name: '當季酪梨(隨機出貨)【優級】', weights: [3,5,7,10], priceKey: '當季酪梨( 隨機出貨 )【優級】單價' },
    { name: '當季酪梨(隨機出貨)【次級】', weights: [3,5,7,10], priceKey: '當季酪梨( 隨機出貨 )【次級】單價' },
    { name: '平克頓/哈斯【優級】', weights: [1,2,3], priceKey: '平克頓/哈斯【優級】單價' },
    { name: '平克頓/哈斯【次級】', weights: [1,2,3], priceKey: '平克頓/哈斯【次級】單價' }
  ];

  const displayNameMap = {
    '平克頓/哈斯【優級】': '平克頓/哈斯 (隨機出貨)【優級】',
    '平克頓/哈斯【次級】': '平克頓/哈斯 (隨機出貨)【次級】',
    '當季酪梨(隨機出貨)【優級】': '當季酪梨(隨機出貨)【優級】',
    '當季酪梨(隨機出貨)【次級】': '當季酪梨(隨機出貨)【次級】'
  };

  let html = '';
  categories.forEach(cat => {
    const displayName = displayNameMap[cat.name] || cat.name;
    html += `<div class="product-group-label">🥑 ${displayName}</div>`;
    cat.weights.forEach(w => {
      const stockKey = (cat.name + '-' + w).replace(/\s+/g, '');
      const availableStock = stockMap[stockKey] || 0;
      const unitPrice = Number(cfg[cat.priceKey]) || 0;
      const displayPrice = unitPrice * w;
      const currentQty = (cart[stockKey] && cart[stockKey].qty) || 0;
      const remaining = availableStock - currentQty;
      html += `
        <div class="price-row">
          <div class="price-col weight">${w} 斤裝 <span>($${displayPrice})</span></div>
          <div class="price-col stock" id="stock-${stockKey}">剩 ${remaining}</div>
          <div class="price-col action">
            <div class="qty-control">
              <button onclick="updateCart('${stockKey}', -1, ${w}, '${displayName}')" class="btn-qty">-</button>
              <span id="qty-${stockKey}" class="qty-num">${currentQty}</span>
              <button onclick="updateCart('${stockKey}', 1, ${w}, '${displayName}')" class="btn-qty" ${remaining <= 0 ? 'disabled' : ''}>+</button>
            </div>
          </div>
        </div>
      `;
    });
  });
  container.innerHTML = html;
}

function updateCart(key, deltaQty, weight, displayName) {
  if (!cart[key] && deltaQty <= 0) return;

  const method = document.getElementById('shipping-method').value;
  if (!method) {
    customAlert('☝️ 請先選擇「1. 配送方式」，\n才能開始挑選規格喔！');
    return;
  }

  const currentQty = (cart[key] && cart[key].qty) || 0;
  const newQty = currentQty + deltaQty;
  if (newQty < 0) return;

  const availableStock = window.APP_CONFIG.stockMap[key] || 0;
  if (deltaQty > 0 && newQty > availableStock) {
    customAlert(`❌ 庫存只剩 ${availableStock} 份喔！`);
    return;
  }

  const prevQty = currentQty;
  const priceKey = stockKeyMap[displayName] || displayName;
  const unitPrice = 價格表[priceKey] || 0;

  if (newQty === 0) {
    delete cart[key];
  } else {
    cart[key] = { displayName, weight, qty: newQty, subtotal: unitPrice * weight * newQty };
  }

  recalcTotalWeight();

  let overweight = false;
  if (method === '711' && totalWeight > 7) overweight = true;
  if (method === 'post' && totalWeight > 10) overweight = true;
  if (method === 'blackcat' && totalWeight > 10) overweight = true;

  if (overweight) {
    const overweightMsgMap = {
      '711': '❌ 7-11配送總重不能超過7斤喔！',
      post: '❌ 郵寄配送總重不能超過10斤喔！',
      blackcat: '❌ 黑貓宅急便配送總重不能超過10斤喔！'
    };
    customAlert(overweightMsgMap[method] || '❌ 總重已超過此配送方式的限重！');
    if (prevQty === 0) {
      delete cart[key];
    } else {
      cart[key] = { displayName, weight, qty: prevQty, subtotal: unitPrice * weight * prevQty };
    }
    recalcTotalWeight();
    refreshCartUI();
    return;
  }

  refreshCartUI();
}

function refreshCartUI() {
  const stockMap = window.APP_CONFIG.stockMap || {};
  Object.keys(stockMap).forEach(key => {
    const item = cart[key];
    const qtyEl = document.getElementById(`qty-${key}`);
    if (qtyEl) qtyEl.innerText = item ? item.qty : 0;

    const plusBtn = qtyEl && qtyEl.parentNode.querySelector('button.btn-qty:last-child');
    const availableStock = stockMap[key] || 0;
    if (plusBtn) plusBtn.disabled = item ? (item.qty >= availableStock) : (0 >= availableStock);

    const stockEl = document.getElementById(`stock-${key}`);
    if (stockEl) {
      const usedQty = item ? item.qty : 0;
      stockEl.innerText = `剩 ${availableStock - usedQty}`;
    }

    if (item) {
      const priceKey = stockKeyMap[item.displayName] || item.displayName;
      const unitPrice = 價格表[priceKey] || 0;
      item.subtotal = unitPrice * item.weight * item.qty;
    }
  });

  calculateCartTotal();
  updateFloatingCart();
}

function handleShippingChange() {
  const method = document.getElementById('shipping-method').value;
  recalcTotalWeight();
  if (Object.keys(cart).length > 0) {
    if (method === '711' && totalWeight > 7) {
      customAlert('⚠️ 7-11 限重 7 斤，目前已超過！請減少品項。');
    } else if (method === 'post' && totalWeight > 10) {
      customAlert('⚠️ 郵寄限重 10 斤，目前已超過！');
    } else if (method === 'blackcat' && totalWeight > 10) {
      customAlert('⚠️ 黑貓宅急便限重 10 斤，目前已超過！');
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

  // 🏝️ 顯示/隱藏離島運費提示
  const islandHint = document.getElementById('island-shipping-hint');
  if (islandHint) islandHint.style.display = isIsland ? 'block' : 'none';

  let shippingFee = 0;
  if (method === 'post') {
    shippingFee = isIsland
      ? ((totalWeight < 7) ? 運費表.郵寄離島小 : 運費表.郵寄離島大)
      : ((totalWeight < 7) ? 運費表.郵寄小 : 運費表.郵寄大);
  } else if (method === '711') {
    shippingFee = 運費表['711運費'];
  } else if (method === 'blackcat') {
    shippingFee = isIsland
      ? ((totalWeight < 7) ? 運費表.黑貓離島小 : 運費表.黑貓離島大)
      : ((totalWeight < 7) ? 運費表.黑貓小 : 運費表.黑貓大);
  }

  finalSubtotal = subtotal;
  finalShippingFee = shippingFee;
  finalTotal = subtotal + shippingFee;
  updateFloatingCart();
}

function renderVarieties() {
  const container = document.getElementById('varieties-container');
  if (!container) return;
  const data = window.allVarieties || (window.APP_CONFIG && window.APP_CONFIG.varieties) || [];

  if (data.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--avo-dark); padding:20px;">目前尚無當季品種資訊。🥑</p>';
    return;
  }

  container.innerHTML = data.map(v => `
    <div class="info-block">
      ${v.img ? `<div class="variety-images"><img src="${v.img}" class="avocado-img" onclick="showLightbox('${v.img}')"></div>` : ''}
      <h3 class="variety-title">${v.name}</h3>
      <div class="product-divider"></div>
      <p style="white-space:pre-wrap;">${v.feature || ''}</p>
    </div>
  `).join('');
}

function renderSuccessPage() {
  document.getElementById('bank-val').innerText = window.APP_CONFIG.bankName || '';
  document.getElementById('account-val').innerText = window.APP_CONFIG.bankAcc || '';
  document.getElementById('name-val').innerText = window.APP_CONFIG.bankUser || '';
  document.getElementById('lp-announcement').innerText = window.APP_CONFIG.linePayMsg || '';

  if (window.APP_CONFIG.linePayImgId) {
    document.getElementById('lp-qrcode').src = 'https://lh3.googleusercontent.com/d/' + window.APP_CONFIG.linePayImgId;
  }

  document.getElementById('final-amount-display').innerText = '$' + finalTotal + ' 元';

  if (!currentOrderSummary) return;
  const o = currentOrderSummary;

  document.getElementById('order-summary-content').innerHTML = `
    <div class="order-summary-list">
      <div class="order-summary-row"><span class="label">📦 規格細項</span><span class="value js-summary-weight"></span></div>
      <div class="order-summary-row"><span class="label">🚚 配送方式</span><span class="value js-summary-shipping"></span></div>
      <div class="order-summary-row"><span class="label">🏠 收件地址(門市)</span><span class="value js-summary-address"></span></div>
      <div class="order-summary-row"><span class="label">💰 商品小計</span><span class="value js-summary-subtotal">$${o.subtotal}</span></div>
      <div class="order-summary-row"><span class="label">🚛 運費</span><span class="value js-summary-shipping-fee">$${o.shippingFee}</span></div>
    </div>
  `;

  const weightContainer = document.querySelector('.js-summary-weight');
  if (weightContainer) {
    weightContainer.innerHTML = o.weight.split('，').map(item => `<div>${item}</div>`).join('');
  }

  const shippingEl = document.querySelector('.js-summary-shipping');
  if (shippingEl) {
    const shippingNameMap = { post: '中華郵政配送', '711': '7-11超商配送', blackcat: '黑貓宅急便配送' };
    shippingEl.textContent = shippingNameMap[o.shippingMethod] || '';
  }

  const addressEl = document.querySelector('.js-summary-address');
  if (addressEl) addressEl.textContent = o.shipping || o.address || '';

  const rawMsg = window.APP_CONFIG.successMsg || '謝謝您支持，下單成功！';
  document.getElementById('success-reminder-msg').innerHTML = `<div class="success-warm-text">${rawMsg}</div>`;
}

function renderPriceMenu() {
  const container = document.getElementById('price-menu-container');
  if (!container) return;
  const cfg = window.APP_CONFIG.orderConfig || {};
  const stockMap = window.APP_CONFIG.stockMap || {};
  let html = '';

  html += `
    <div class="info-block price-info">
      <h3 class="price-title">🥑 當季酪梨</h3>
      <div class="product-divider"></div>
      <h4 class="price-subtitle">．優級．</h4>
      <div class="price-divider">✦ ✦ ✦</div>
      ${[3,5,7,10].map(w => {
        const price = (Number(cfg['當季酪梨( 隨機出貨 )【優級】單價']) || 0) * w;
        const key = ('當季酪梨( 隨機出貨 )【優級】-' + w).replace(/\s+/g,'');
        const count = stockMap[key] || 0;
        return `<div class="price-row"><div class="price-col weight">${w} 斤裝</div><div class="price-col amount">$${price}</div><div class="price-col stock">${count > 0 ? `（剩 ${count} 份）` : '（售罄）'}</div></div>`;
      }).join('')}
      <div style="height:26px;"></div>
      <h4 class="price-subtitle">．次級．</h4>
      <div class="price-divider">✦ ✦ ✦</div>
      ${[3,5,7,10].map(w => {
        const price = (Number(cfg['當季酪梨( 隨機出貨 )【次級】單價']) || 0) * w;
        const key = ('當季酪梨( 隨機出貨 )【次級】-' + w).replace(/\s+/g,'');
        const count = stockMap[key] || 0;
        return `<div class="price-row"><div class="price-col weight">${w} 斤裝</div><div class="price-col amount">$${price}</div><div class="price-col stock">${count > 0 ? `（剩 ${count} 份）` : '（售罄）'}</div></div>`;
      }).join('')}
    </div>
  `;

  html += `
    <div class="info-block price-info">
      <h3 class="price-title">🥑 平克頓 & 哈斯</h3>
      <div class="product-divider"></div>
      <h4 class="price-subtitle">．優級．</h4>
      <div class="price-divider">✦ ✦ ✦</div>
      ${[1,2,3].map(w => {
        const price = (Number(cfg['平克頓/哈斯【優級】單價']) || 0) * w;
        const key = ('平克頓/哈斯【優級】-' + w).replace(/\s+/g,'');
        const count = stockMap[key] || 0;
        return `<div class="price-row"><div class="price-col weight">${w} 斤裝</div><div class="price-col amount">$${price}</div><div class="price-col stock">${count > 0 ? `（剩 ${count} 份）` : '（售罄）'}</div></div>`;
      }).join('')}
      <div style="height:26px;"></div>
      <h4 class="price-subtitle">．次級．</h4>
      <div class="price-divider">✦ ✦ ✦</div>
      ${[1,2,3].map(w => {
        const price = (Number(cfg['平克頓/哈斯【次級】單價']) || 0) * w;
        const key = ('平克頓/哈斯【次級】-' + w).replace(/\s+/g,'');
        const count = stockMap[key] || 0;
        return `<div class="price-row"><div class="price-col weight">${w} 斤裝</div><div class="price-col amount">$${price}</div><div class="price-col stock">${count > 0 ? `（剩 ${count} 份）` : '（售罄）'}</div></div>`;
      }).join('')}
    </div>
  `;

  container.innerHTML = html;
  document.getElementById('ship-post-small').innerText = cfg['郵寄七斤(不含)以下'] || 0;
  document.getElementById('ship-post-large').innerText = cfg['郵寄七斤(包含)以上'] || 0;
  document.getElementById('ship-711').innerText = cfg['711運費'] || 0;
  document.getElementById('ship-blackcat-small').innerText = cfg['黑貓配送七斤(不含)以下'] || 0;
  document.getElementById('ship-blackcat-large').innerText = cfg['黑貓配送七斤(包含)以上'] || 0;
  document.getElementById('ship-post-island-small').innerText = cfg['郵寄離島七斤(不含)以下'] || 0;
  document.getElementById('ship-post-island-large').innerText = cfg['郵寄離島七斤(包含)以上'] || 0;
  document.getElementById('ship-blackcat-island-small').innerText = cfg['黑貓配送離島七斤(不含)以下'] || 0;
  document.getElementById('ship-blackcat-island-large').innerText = cfg['黑貓配送離島七斤(包含)以上'] || 0;
}

function initAddressSelector() {
  const countySelect = document.getElementById('county');
  const districtSelect = document.getElementById('district');
  const zipInput = document.getElementById('zipcode');
  if (!countySelect || !districtSelect || !zipInput || !window.APP_CONFIG.addressMap) return;

  const addressMap = window.APP_CONFIG.addressMap;
  countySelect.innerHTML = '<option value="">縣市</option>';
  districtSelect.innerHTML = '<option value="">區域</option>';

  Object.keys(addressMap).forEach(county => {
    countySelect.add(new Option(county, county));
  });

  countySelect.addEventListener('change', () => {
    districtSelect.innerHTML = '<option value="">區域</option>';
    zipInput.value = '';
    const districts = addressMap[countySelect.value];
    if (districts) {
      Object.keys(districts).forEach(dist => { districtSelect.add(new Option(dist, dist)); });
      districtSelect.disabled = false;
    } else {
      districtSelect.disabled = true;
    }
    calculateCartTotal();
  });

  districtSelect.addEventListener('change', () => {
    zipInput.value = (addressMap[countySelect.value] && addressMap[countySelect.value][districtSelect.value]) || '';
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
  postSection.style.display = 'none';
  storeSection.style.display = 'none';
  if (method === 'post' || method === 'blackcat') postSection.style.display = 'block';
  if (method === '711') storeSection.style.display = 'block';
}

function recalcTotalWeight() {
  totalWeight = Object.values(cart).reduce((sum, item) => sum + item.qty * item.weight, 0);
}

function updateFloatingCart() {
  const cartItemsContainer = document.getElementById('floating-cart-items');
  if (!cartItemsContainer) return;
  cartItemsContainer.innerHTML = '';
  const visibleItems = Object.values(cart).filter(item => item.qty > 0);
  visibleItems.forEach(item => {
    const div = document.createElement('div');
    div.className = 'floating-cart-item';
    div.innerHTML = `<span class="item-name">${item.displayName} ${item.weight}斤</span><span class="item-qty">x${item.qty}</span><span class="item-subtotal">$${item.subtotal}</span>`;
    cartItemsContainer.appendChild(div);
  });

  document.getElementById('floating-subtotal').innerHTML = `<span class="label">小計：</span><span class="amount">$${finalSubtotal}</span>`;
  document.getElementById('floating-shipping').innerHTML = `<span class="label">運費：</span><span class="amount">$${finalShippingFee}</span>`;
  document.getElementById('floating-total').innerHTML = `<span class="label">總計：</span><span class="amount">$${finalTotal}</span>`;

  if (visibleItems.length === 0) {
    cartItemsContainer.innerHTML = '<div style="text-align:center; color:#888;">購物車空空如也</div>';
  }
}

function handleOrderEnter() {
  const orderSwitch = (window.APP_CONFIG && window.APP_CONFIG.orderSwitch) || '開';
  if (orderSwitch === '關') {
    customAlert('目前為停止採收期，暫停接單中 🌱\n\n我們會於開放時第一時間公告，感謝您的體諒！');
    return;
  }
  goToStep(2);
}

// ========================================
// 📬 送單：改用 fetch 取代 google.script.run
// ========================================
async function submitOrder(e) {
  if (e) e.preventDefault();

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

  if (Object.keys(cart).length === 0 || totalWeight <= 0) {
    customAlert('☝️ 購物車還是空的，請挑選規格！');
    return;
  }

  const n = nEl.value.trim();
  const p = pEl.value.trim();
  const shippingMethodEl = document.getElementById('shipping-method');
  const shippingMethod = shippingMethodEl ? shippingMethodEl.value : '';

if (!n || !p) {
  customAlert('☝️請填寫收件人姓名與電話！');
  return;
}

if (!/^09\d{8}$/.test(p)) {
  customAlert('☝️ 請填寫正確的手機號碼格式！\n例如：0912345678');
  return;
}

  let fullAddress = '';
  if (shippingMethod === 'post' || shippingMethod === 'blackcat') {
    if (!countyEl.value || !districtEl.value) {
      countyEl.classList.add('address-error');
      districtEl.classList.add('address-error');
      const errorHint = document.getElementById('address-error-hint');
      if (errorHint) errorHint.style.display = 'block';
      countyEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!addressDetailEl.value.trim()) {
      customAlert('☝️請填寫完整宅配地址！');
      return;
    }
    countyEl.classList.remove('address-error');
    districtEl.classList.remove('address-error');
    const errorHint = document.getElementById('address-error-hint');
    if (errorHint) errorHint.style.display = 'none';
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

  submitBtn.innerText = '處理中...';
  submitBtn.disabled = true;

  // 🏝️ 保險：送單前用最新地址再算一次運費，確保離島判斷不會用到過期數字
  calculateCartTotal();

  const weightText = Object.values(cart).map(item => `${item.displayName} ${item.weight} 斤 x${item.qty}`);

  const orderData = {
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
    weight: weightText.join('，')
  };

  currentOrderSummary = orderData;

  // ✅ 改用 fetch 送單（取代原本的 google.script.run）
  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(orderData)
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || '送單失敗');

    // ✅ 下單成功：本地同步扣除庫存快照，避免回首頁/價目表顯示舊庫存
    const stockMap = window.APP_CONFIG.stockMap || {};
    Object.keys(cart).forEach(key => {
      if (stockMap[key] !== undefined) {
        stockMap[key] = Math.max(0, stockMap[key] - cart[key].qty);
      }
    });

    // ✅ 清空購物車，避免下次進訂購頁殘留舊品項
    cart = {};
    totalWeight = 0;

    submitBtn.disabled = false;
    submitBtn.innerText = '✅ 確認訂購';
    goToStep(5);
  } catch (err) {
    customAlert(err.message || '送單失敗，請稍後再試');
    submitBtn.disabled = false;
    submitBtn.innerText = '✅ 確認訂購';
  }
}

// ========================================
// 通用工具函式
// ========================================
function customAlert(msg) {
  const overlay = document.getElementById('custom-alert-overlay');
  const msgText = document.getElementById('alert-message');
  if (overlay && msgText) { msgText.innerText = msg; overlay.style.display = 'flex'; }
}

function closeAlert() { document.getElementById('custom-alert-overlay').style.display = 'none'; }

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
  if (type === 'bank') {
    bg.style.transform = 'translateX(0)';
    optBank.classList.add('active'); optLine.classList.remove('active');
    contentBank.classList.add('active'); contentLine.classList.remove('active');
  } else {
    bg.style.transform = 'translateX(100%)';
    optBank.classList.remove('active'); optLine.classList.add('active');
    contentBank.classList.remove('active'); contentLine.classList.add('active');
  }
}

function fireConfetti() {
  var end = Date.now() + 2000;
  (function frame() {
    confetti({ particleCount: 3, angle: 60, spread: 55, origin: { x: 0, y: 0.8 } });
    confetti({ particleCount: 3, angle: 120, spread: 55, origin: { x: 1, y: 0.8 } });
    if (Date.now() < end) requestAnimationFrame(frame);
  }());
}

function handleLineJump() {
  const targetUrl = (window.paymentConfig && window.paymentConfig['跳轉按鈕連結']) || '';
  if (targetUrl.trim().startsWith('http')) { window.open(targetUrl.trim(), '_blank'); }
  else { customAlert('✨ 感謝您的訂購！\n請手動回報匯款唷～ ✨'); }
}
