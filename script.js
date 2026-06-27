script
 🌟 核心變數與狀態
var 價格表 = {}, 運費表 = {};
var finalSubtotal = 0, finalShippingFee = 0, finalTotal = 0;
var isInitialLoad = true; 
var currentOrderSummary = null;
var cart = {}; 
var totalWeight = 0;
var isOpen = false;  控制浮動購物車是否展開

 顯示名稱 → stockMap key 的對照表
const stockKeyMap = {
  平克頓哈斯 (隨機出貨)【優級】 平克頓哈斯【優級】,
  平克頓哈斯 (隨機出貨)【次級】 平克頓哈斯【次級】,
  當季酪梨(隨機出貨)【優級】 當季酪梨(隨機出貨)【優級】,
  當季酪梨(隨機出貨)【次級】 當季酪梨(隨機出貨)【次級】
};

window.onload = function() {
 1. 環境檢查
  if (!window.APP_CONFIG  !window.APP_CONFIG.orderConfig) {
    showLoadingError();
    return;
  }

  const data = window.APP_CONFIG.orderConfig  {};

  價格表 = {
    當季酪梨(隨機出貨)【優級】 Number(data[當季酪梨( 隨機出貨 )【優級】單價])  0,
    當季酪梨(隨機出貨)【次級】 Number(data[當季酪梨( 隨機出貨 )【次級】單價])  0,
    平克頓哈斯【優級】 Number(data[平克頓哈斯【優級】單價])  0,
    平克頓哈斯【次級】 Number(data[平克頓哈斯【次級】單價])  0
  };
  
  運費表 = {
    郵寄小 Number(data[郵寄七斤(不含)以下])  100,
    郵寄大 Number(data[郵寄七斤(包含)以上])  120,
    711運費 Number(data[711運費])  80
  };

   2. 渲染 UI
   setTimeout(renderVarietyOptions, 0);  移除，因為不存在
  setTimeout(renderProductList, 0);  顯示商品列表
  setTimeout(renderVarieties, 0);     顯示品種介紹


   3. 加載訂購頁插圖卡片
  const cardImgId1 = data[訂購頁插圖ID_1]  ;
  const cardImgId2 = data[訂購頁插圖ID_2]  ;
  const cardText = data[訂購頁插圖文字]  ;
  const middleCard = document.getElementById('order-middle-card');

  setTimeout(() = {
    if (middleCard && (cardImgId1  cardImgId2  cardText)) {
      middleCard.style.display = 'block';
      const img1 = document.getElementById('order-card-img1');
      if (img1 && cardImgId1) img1.src = httpslh3.googleusercontent.comd + cardImgId1;
      const img2 = document.getElementById('order-card-img2');
      if (img2 && cardImgId2) img2.src = httpslh3.googleusercontent.comd + cardImgId2;
      
      const textElement = document.getElementById('order-card-text');
      if (textElement && cardText) {
        textElement.innerText = cardText;
        textElement.style.display = 'block';
        textElement.className = ; 
        textElement.style.cssText = text-aligncenter; colorvar(--avo-dark); font-size0.95rem; margin-top15px; line-height1.6; font-weight500; opacity0.85;;
      }
    }
  }, 0);  

 🌟 初始化 stockMap（統一 key 去空格）
window.APP_CONFIG.stockMap = {};
const rawStock = window.APP_CONFIG.stockData  {};
Object.keys(rawStock).forEach(k = {
  const normalizedKey = k.replace(s+g,'');
  window.APP_CONFIG.stockMap[normalizedKey] = Number(rawStock[k])  0;
});

   4. 處理首頁公告換行
  const annText = != JSON.stringify(設定['首頁']['公告內容']  ) ;
  const annP = document.querySelector('#step1-announcement p');
  if (annP && annText) {
    annP.innerHTML = annText.replace(ng, 'br');
  }
  
  setTimeout(() = {
    isInitialLoad = false;
  }, 0);

  setTimeout(renderPriceMenu, 0);
  setTimeout(initAddressSelector, 0);
  initShippingAddressToggle();

};

function goToStep(step) {
   1️⃣ 隱藏全部頁面
  document.querySelectorAll('.page-content').forEach(p = {
    p.style.display = 'none';
  });

   2️⃣ step 與頁面 ID 一一對應（照順序）
  const pageMap = {
    1 'step1-announcement',    公告
    2 'step2-varieties',       品種介紹
    3 'step3-price-list',      價格表
    4 'step4-order-form',      🟢 訂購填寫（改正）
    5 'step5-payment-info'    🟢 訂購完成  匯款資訊（改正）
  };

  const targetId = pageMap[step];
  const targetPage = document.getElementById(targetId);

  if (targetPage) {
    targetPage.style.display = 'block';
  }

   🎊 只有最後一步才觸發成功效果
   🎊 只有最後一步才觸發成功效果
  if (step === 5) {

     ① 先渲染成功頁內容
    renderSuccessPage();

     ② 再讓卡片浮現
    setTimeout(() = {
      const successCard = document.querySelector(
        '#step5-payment-info .info-block'
      );
      if (successCard) {
        successCard.classList.add('success-animate');
      }
    }, 100);

     ③ 最後噴彩花（最有儀式感）
    setTimeout(() = {
      fireConfetti();
    }, 200);
  }

 🟢 進入訂購頁時，強制同步配送方式 → 地址區塊
if (step === 4) {
  setTimeout(() = {
     const floatingCart = document.getElementById('floating-cart');
     floatingCart.classList.remove('show');  👈 強制收合

    renderProductList();
    updateAddressSection();
    calculateCartTotal();
  }, 0);
}

  window.scrollTo(0, 0);
}

document.addEventListener('DOMContentLoaded', () = {
   現有欄位完成感綁定
  const fields = document.querySelectorAll(
    '#cust-name, #cust-phone, #delivery-address, #order-note'
  );

  fields.forEach(field = {
    field.addEventListener('blur', () = {
      if (field.value.trim() !== '') {
        field.classList.add('input-completed');
        setTimeout(() = { field.classList.remove('input-completed'); }, 600);
      }
    });
  });

   ✅ 懸浮購物車按鈕綁定
  const floatingBtn = document.getElementById('floating-checkout');
  if (floatingBtn) {
    floatingBtn.addEventListener('click', () = {
      goToStep(4);
    });
  }

   🌟 浮動購物車展開收合
  const floatingCart = document.getElementById('floating-cart');
  const cartHandle = document.getElementById('floating-cart-handle');

  let isOpen = false;  ❗初始化

  if (floatingCart && cartHandle) {
     點把手展開或收合
    cartHandle.addEventListener('click', (e) = {
      isOpen = !isOpen;
      floatingCart.classList.toggle('show', isOpen);
      e.stopPropagation();
    });

     防止手機觸控滾動誤觸
    cartHandle.addEventListener('touchstart', (e) = e.stopPropagation());
  }
});



function renderProductList() {
  const container = document.getElementById('product-list-container');
  if (!container) return;

  const cfg = window.APP_CONFIG.orderConfig  {};
  const stockMap = window.APP_CONFIG.stockMap  {};

   產品分類
  const categories = [
    { name '當季酪梨(隨機出貨)【優級】', weights [3,5,7,10], priceKey '當季酪梨( 隨機出貨 )【優級】單價' },
    { name '當季酪梨(隨機出貨)【次級】', weights [3,5,7,10], priceKey '當季酪梨( 隨機出貨 )【次級】單價' },   
    { name '平克頓哈斯【優級】', weights [1,2,3], priceKey '平克頓哈斯【優級】單價' },
    { name '平克頓哈斯【次級】', weights [1,2,3], priceKey '平克頓哈斯【次級】單價' }
  ];

   顯示名稱 map（庫存 key → 顯示名稱）
  const displayNameMap = {
    平克頓哈斯【優級】 平克頓哈斯 (隨機出貨)【優級】,
    平克頓哈斯【次級】 平克頓哈斯 (隨機出貨)【次級】,
    當季酪梨(隨機出貨)【優級】 當季酪梨(隨機出貨)【優級】,
    當季酪梨(隨機出貨)【次級】 當季酪梨(隨機出貨)【次級】
  };

  let html = '';

  categories.forEach(cat = {
    const displayName = displayNameMap[cat.name]  cat.name;
    html += `div class=product-group-label🥑 ${displayName}div`;

    cat.weights.forEach(w = {
      const stockKey = (cat.name + - + w).replace(s+g,'');   庫存 key
      const availableStock = stockMap[stockKey]  0;
      const unitPrice = Number(cfg[cat.priceKey])  0;
      const displayPrice = unitPrice  w;
      const currentQty = cart[stockKey].qty  0;
      const remaining = availableStock - currentQty;

      html += `
        div class=price-row
          div class=price-col weight${w} 斤裝 span($${displayPrice})spandiv
          div class=price-col stock id=stock-${stockKey}剩 ${remaining}div
          div class=price-col action
            div class=qty-control
              button onclick=updateCart('${stockKey}', -1, ${w}, '${displayName}') class=btn-qty-button
              span id=qty-${stockKey} class=qty-num${currentQty}span
              button onclick=updateCart('${stockKey}', 1, ${w}, '${displayName}') class=btn-qty class=btn-qty ${remaining = 0  'disabled'  ''}+button
            div
          div
        div
      `;
    });
  });

  container.innerHTML = html;
}


function updateCart(key, deltaQty, weight, displayName) {
   ✅ 如果 key 不存在，且 deltaQty = 0，直接返回，不初始化空商品
  if (!cart[key] && deltaQty = 0) return;

  const method = document.getElementById('shipping-method').value;
  if (!method) {
    customAlert(☝️ 請先選擇「1. 配送方式」，n才能開始挑選規格喔！);
    return;
  }

  const currentQty = cart[key].qty  0;
  const newQty = currentQty + deltaQty;
  if (newQty  0) return;

  const availableStock = window.APP_CONFIG.stockMap[key]  0;
  if (deltaQty  0 && newQty  availableStock) {
    customAlert(`❌ 庫存只剩 ${availableStock} 份喔！`);
    return;
  }

  const prevQty = currentQty;
  const priceKey = stockKeyMap[displayName]  displayName;
  const unitPrice = 價格表[priceKey]  0;

  if (newQty === 0) {
    delete cart[key];
  } else {
    cart[key] = { 
      displayName, 
      weight, 
      qty newQty, 
      subtotal unitPrice  weight  newQty 
    };
  }

  recalcTotalWeight();

   重量限制檢查
  let overweight = false;
  if (method === '711' && totalWeight  7) overweight = true;
  if (method === 'post' && totalWeight  10) overweight = true;

  if (overweight) {
    customAlert(method === '711'
       ❌ 7-11配送總重不能超過7斤喔！
       ❌ 郵寄配送總重不能超過10斤喔！);
    
     還原 cart
    if (prevQty === 0) {
      delete cart[key];
    } else {
      cart[key] = { 
        displayName, 
        weight, 
        qty prevQty, 
        subtotal unitPrice  weight  prevQty 
      };
    }
    recalcTotalWeight();
    refreshCartUI();
    return;
  }

  refreshCartUI();
}



 刷新整個購物車 UI（含按鈕、庫存、總額）
 將 refreshCartUI() 改成同時更新懸浮購物車
function refreshCartUI() {
  const stockMap = window.APP_CONFIG.stockMap  {};

   1️⃣ 更新每個商品列表的按鈕與庫存
  Object.keys(stockMap).forEach(key = {
    const item = cart[key];  cart 裡面 key 要跟 stockMap 一致
    const qtyEl = document.getElementById(`qty-${key}`);
    if (qtyEl) qtyEl.innerText = item  item.qty  0;

    const plusBtn = qtyEl.parentNode.querySelector('button.btn-qtylast-child');
    const minusBtn = qtyEl.parentNode.querySelector('button.btn-qtyfirst-child');
    const availableStock = stockMap[key]  0;

    if (plusBtn) plusBtn.disabled = item  (item.qty = availableStock)  (0 = availableStock);
    if (minusBtn) minusBtn.disabled = false;

    const stockEl = document.getElementById(`stock-${key}`);
    if (stockEl) {
      const usedQty = item  item.qty  0;
      stockEl.innerText = `剩 ${availableStock - usedQty}`;
    }

     ✅ 更新每個 item subtotal
    if (item) {
      const priceKey = stockKeyMap[item.displayName]  item.displayName;
      const unitPrice = 價格表[priceKey]  0;
      item.subtotal = unitPrice  item.weight  item.qty;
    }

  });

   2️⃣ 更新購物車總額與懸浮購物車
  calculateCartTotal();
  updateFloatingCart();
}


 🌟 當配送方式變更時，檢查是否超重
function handleShippingChange() {
  const method = document.getElementById('shipping-method').value;

  recalcTotalWeight();

   ✅ 只在購物車有品項時才提醒超重
  if (Object.keys(cart).length  0) {
    if (method === '711' && totalWeight  7) {
      customAlert(⚠️ 7-11 限重 7 斤，目前已超過！請減少品項。);
    } else if (method === 'post' && totalWeight  10) {
      customAlert(⚠️ 郵寄限重 10 斤，目前已超過！);
    }
  }

  calculateCartTotal();
  updateAddressSection();  顯示對應地址區塊

}


 購物車重量計算
function calculateCartTotal() {
   ✅ 先同步總重量
  recalcTotalWeight();

  const method = document.getElementById('shipping-method').value;
  let subtotal = 0;

  Object.values(cart).forEach(k = {
    subtotal += k.subtotal;
  });

  let shippingFee = 0;
  if (method === 'post') {
    shippingFee = (totalWeight  7)  100  120;
  } else if (method === '711') {
    shippingFee = 80;
  }

  finalSubtotal = subtotal;
  finalShippingFee = shippingFee;
  finalTotal = subtotal + shippingFee;

   ✅ 更新懸浮購物車
  updateFloatingCart();
}



function renderVarieties() {

  const container = document.getElementById('varieties-container');
  if (!container) return;

   🌟 修正：優先從 APP_CONFIG 找，若無則找 allVarieties
  const data = window.allVarieties  (window.APP_CONFIG && window.APP_CONFIG.varieties)  [];

  if (data.length === 0) {
    container.innerHTML = 'p style=text-aligncenter; colorvar(--avo-dark); padding20px;目前尚無當季品種資訊。🥑p';
    return;
  }

  container.innerHTML = data.map(v = `
    div class=info-block
      ${v.img  `
        div class=variety-images
          img src=${v.img} class=avocado-img onclick=showLightbox('${v.img}')
        div
      `  ''}
      h3 class=variety-title${v.name}h3
      div class=product-dividerdiv
      p style=white-space pre-wrap;${v.feature  ''}p
    div
  `).join('');
}

 成功頁面顧客訂購資料
function renderSuccessPage() {
  document.getElementById('bank-val').innerText = window.APP_CONFIG.bankName  ;
  document.getElementById('account-val').innerText = window.APP_CONFIG.bankAcc  ;
  document.getElementById('name-val').innerText = window.APP_CONFIG.bankUser  ;
  document.getElementById('lp-announcement').innerText = window.APP_CONFIG.linePayMsg  ;

  if (window.APP_CONFIG.linePayImgId) {
    document.getElementById('lp-qrcode').src =
      httpslh3.googleusercontent.comd +
      window.APP_CONFIG.linePayImgId;
  }

  document.getElementById('final-amount-display').innerText =
    $ + finalTotal +  元;

  if (!currentOrderSummary) return;
  const o = currentOrderSummary;

   📦 訂購規格摘要
  document.getElementById('order-summary-content').innerHTML = `
    div class=order-summary-list
      div class=order-summary-row
        span class=label📦 規格細項span
        span class=value js-summary-weightspan
      div
      div class=order-summary-row
        span class=label🚚 配送方式span
        span class=value js-summary-shippingspan
      div
      div class=order-summary-row
        span class=label🏠 收件地址(門市)span
        span class=value js-summary-addressspan
      div      
      div class=order-summary-row
        span class=label💰 商品小計span
        span class=value js-summary-subtotal$${o.subtotal}span
      div
      div class=order-summary-row
        span class=label🚛 運費span
        span class=value js-summary-shipping-fee$${o.shippingFee}span
      div
    div
  `;

   顯示規格細項
  const weightContainer = document.querySelector('.js-summary-weight');
  if (weightContainer) {
    weightContainer.innerHTML = o.weight
      .split('，')
      .map(item = `div${item}div`)
      .join('');
  }

   顯示配送方式（友善名稱）
  const shippingEl = document.querySelector('.js-summary-shipping');
  if (shippingEl) {
    let friendlyShipping = o.shippingMethod === 'post'
         '中華郵政配送'
         '7-11超商配送';
    shippingEl.textContent = friendlyShipping;
  }


   顯示收件地址
  const addressEl = document.querySelector('.js-summary-address');
  if (addressEl) {
    addressEl.textContent = o.shipping  o.address  '';
  }

   成功訊息
  const rawMsg = window.APP_CONFIG.successMsg  謝謝您支持，下單成功！;
  document.getElementById('success-reminder-msg').innerHTML =
    `div class=success-warm-text${rawMsg}div`;
}

 --- 🌟 通用工具 ---
function customAlert(msg) {
  const overlay = document.getElementById('custom-alert-overlay');
  const msgText = document.getElementById('alert-message');
  if (overlay && msgText) { msgText.innerText = msg; overlay.style.display = 'flex'; }
}

function closeAlert() { document.getElementById('custom-alert-overlay').style.display = 'none'; }
function showLightbox(s) { document.getElementById('lightbox-img').src = s; document.getElementById('lightbox-overlay').style.display = 'flex'; }
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
    confetti({ particleCount 3, angle 60, spread 55, origin { x 0, y 0.8 } });
    confetti({ particleCount 3, angle 120, spread 55, origin { x 1, y 0.8 } });
    if (Date.now()  end) requestAnimationFrame(frame);
  }());
}
function handleLineJump() {
  const targetUrl = (window.paymentConfig && window.paymentConfig['跳轉按鈕連結'])  ;
  if (targetUrl.trim().startsWith('http')) { window.open(targetUrl.trim(), '_blank'); }
  else { customAlert(✨ 感謝您的訂購！n請手動回報匯款唷～ ✨); }
}

 下單送單處理
function submitOrder(e) {
  if (e) e.preventDefault();  防止表單自動提交

  const nEl = document.getElementById('cust-name');
  const pEl = document.getElementById('cust-phone');
  const submitBtn = document.getElementById('submit-btn');
  const countyEl = document.getElementById('county');
  const districtEl = document.getElementById('district');
  const zipcodeEl = document.getElementById('zipcode');
  const addressDetailEl = document.getElementById('delivery-address');
  const storeEl = document.getElementById('store-name');
  const orderNoteEl = document.getElementById('order-note');

  if (!nEl  !pEl  !submitBtn) {
    customAlert(⚠️ 找不到必填欄位，請確認訂購頁已正確顯示！);
    return;
  }

  if (Object.keys(cart).length === 0  totalWeight = 0) {
    customAlert(☝️ 購物車還是空的，請挑選規格！);
    return;
  }

  const n = nEl.value.trim();
  const p = pEl.value.trim();
  const shippingMethodEl = document.getElementById('shipping-method');
  const shippingMethod = shippingMethodEl  shippingMethodEl.value  '';

  if (!n  !p) {
    customAlert(☝️請填寫收件人姓名與電話！);
    return;
  }

  let fullAddress = '';
  if (shippingMethod === 'post') {
    if (!countyEl  !districtEl  !zipcodeEl  !addressDetailEl) {
      customAlert(☝️ 郵寄欄位缺失！);
      return;
    }
    if (!countyEl.value  !districtEl.value) {
      countyEl.classList.add('address-error');
      districtEl.classList.add('address-error');
      const errorHint = document.getElementById('address-error-hint');
      if (errorHint) errorHint.style.display = 'block';
      countyEl.scrollIntoView({ behavior 'smooth', block 'center' });
      return;
    }
    if (!addressDetailEl.value.trim()) {
      customAlert(☝️請填寫完整宅配地址！);
      return;
    }
    countyEl.classList.remove('address-error');
    districtEl.classList.remove('address-error');
    const errorHint = document.getElementById('address-error-hint');
    if (errorHint) errorHint.style.display = 'none';
    fullAddress = `${zipcodeEl.value  ''} ${countyEl.value}${districtEl.value}${addressDetailEl.value.trim()}`;
  } else if (shippingMethod === '711') {
    if (!storeEl  !storeEl.value.trim()) {
      customAlert(☝️請填寫 7-11 門市名稱！);
      if (storeEl) storeEl.scrollIntoView({ behavior 'smooth', block 'center' });
      return;
    }
    fullAddress = `7-11 門市：${storeEl.value.trim()}`;
  } else {
    customAlert(☝️請選擇配送方式！);
    return;
  }

   禁用按鈕避免重複送單
  submitBtn.innerText = 處理中...;
  submitBtn.disabled = true;

   拼接顧客選購規格細項
  const weightText = Object.values(cart).map(item = {
    return `${item.displayName} ${item.weight} 斤 x${item.qty}`;
  });


  const orderData = {
    cart cart,
    subtotal finalSubtotal,
    shippingMethod shippingMethod,    原始配送方式保留
    shipping fullAddress,             真正收件地址  門市
    shippingFee finalShippingFee,
    total finalTotal,
    name n,
    phone p,
    address fullAddress,
    note orderNoteEl  orderNoteEl.value  '',
    weight weightText.join('，')
  };

   更新成功頁摘要
  currentOrderSummary = orderData;

   送單到 Apps Script
  google.script.run
    .withSuccessHandler(() = {
      submitBtn.disabled = false;
      submitBtn.innerText = ✅ 確認訂購;
      goToStep(5);
    })
    .withFailureHandler(err = {
      customAlert(err.message  送單失敗，請稍後再試);
      submitBtn.disabled = false;
      submitBtn.innerText = ✅ 確認訂購;
    })
    .processOrder(orderData);
}



 價格表
function renderPriceMenu() {
  const container = document.getElementById('price-menu-container');
  if (!container) return;

  const cfg = window.APP_CONFIG.orderConfig  {};
  const stockMap = window.APP_CONFIG.stockMap  {};  ✅ 使用全域 stockMap

  let html = '';

   🥑 卡片一：當季酪梨
  html += `
    div class=info-block price-info
      h3 class=price-title🥑 當季酪梨h3
      div class=product-dividerdiv

      h4 class=price-subtitle．優級．h4
      div class=price-divider✦ ✦ ✦div

      ${[3,5,7,10].map(w = {
        const price = (Number(cfg['當季酪梨( 隨機出貨 )【優級】單價'])  0)  w;
        const key = ('當季酪梨( 隨機出貨 )【優級】-' + w).replace(s+g,'');
        const count = stockMap[key]  0;

        return `
          div class=price-row
            div class=price-col weight${w} 斤裝div
            div class=price-col amount$${price}div
            div class=price-col stock
              ${count  0  `（剩 ${count} 份）`  '（售罄）'}
            div
          div
        `;
      }).join('')}

      div style=height26px;div

      h4 class=price-subtitle．次級．h4
      div class=price-divider✦ ✦ ✦div

      ${[3,5,7,10].map(w = {
        const price = (Number(cfg['當季酪梨( 隨機出貨 )【次級】單價'])  0)  w;
        const key = ('當季酪梨( 隨機出貨 )【次級】-' + w).replace(s+g,'');
        const count = stockMap[key]  0;

        return `
          div class=price-row
            div class=price-col weight${w} 斤裝div
            div class=price-col amount$${price}div
            div class=price-col stock
              ${count  0  `（剩 ${count} 份）`  '（售罄）'}
            div
          div
        `;
      }).join('')}
    div
  `;

   🥑 卡片二：平克頓  哈斯
  html += `
    div class=info-block price-info
      h3 class=price-title🥑 平克頓  哈斯h3
      div class=product-dividerdiv

      h4 class=price-subtitle．優級．h4
      div class=price-divider✦ ✦ ✦div

      ${[1,2,3].map(w = {
        const price = (Number(cfg['平克頓哈斯【優級】單價'])  0)  w;
        const key = ('平克頓哈斯【優級】-' + w).replace(s+g,'');
        const count = stockMap[key]  0;

        return `
          div class=price-row
            div class=price-col weight${w} 斤裝div
            div class=price-col amount$${price}div
            div class=price-col stock
              ${count  0  `（剩 ${count} 份）`  '（售罄）'}
            div
          div
        `;
      }).join('')}

      div style=height26px;div

      h4 class=price-subtitle．次級．h4
      div class=price-divider✦ ✦ ✦div

      ${[1,2,3].map(w = {
        const price = (Number(cfg['平克頓哈斯【次級】單價'])  0)  w;
        const key = ('平克頓哈斯【次級】-' + w).replace(s+g,'');
        const count = stockMap[key]  0;

        return `
          div class=price-row
            div class=price-col weight${w} 斤裝div
            div class=price-col amount$${price}div
            div class=price-col stock
              ${count  0  `（剩 ${count} 份）`  '（售罄）'}
            div
          div
        `;
      }).join('')}
    div
  `;

  container.innerHTML = html;

   🚚 運費
  document.getElementById('ship-post-small').innerText = cfg['郵寄七斤(不含)以下']  0;
  document.getElementById('ship-post-large').innerText = cfg['郵寄七斤(包含)以上']  0;
  document.getElementById('ship-711').innerText = cfg['711運費']  0;
}

 ------------- 縣市，行政區 -------------
function initAddressSelector() {
  const countySelect = document.getElementById('county');
  const districtSelect = document.getElementById('district');
  const zipInput = document.getElementById('zipcode');

  if (!countySelect  !districtSelect  !zipInput  !window.APP_CONFIG.addressMap) return;

  const addressMap = window.APP_CONFIG.addressMap;

   修改預設文字，讓使用者知道這是並排的
  countySelect.innerHTML = 'option value=縣市option';
  districtSelect.innerHTML = 'option value=區域option';

  Object.keys(addressMap).forEach(county = {
    const opt = new Option(county, county);
    countySelect.add(opt);
  });

  countySelect.addEventListener('change', () = {
    districtSelect.innerHTML = 'option value=區域option';
    zipInput.value = '';
    const districts = addressMap[countySelect.value];
    if (districts) {
      Object.keys(districts).forEach(dist = {
        districtSelect.add(new Option(dist, dist));
      });
      districtSelect.disabled = false;
    } else {
      districtSelect.disabled = true;
    }
  });

  districtSelect.addEventListener('change', () = {
    zipInput.value = addressMap[countySelect.value].[districtSelect.value]  '';
  });
}


 🌟 初始化配送方式監聽
function initShippingAddressToggle() {
  const shippingEl = document.getElementById('shipping-method');
  if (!shippingEl) return;

  shippingEl.addEventListener('change', handleShippingChange);

   ✅ 頁面初始時不要立即渲染空購物車，只同步地址區塊
  updateAddressSection();
}



function updateAddressSection() {
  const method = document.getElementById('shipping-method').value;

  const postSection = document.getElementById('post-address-section');
  const storeSection = document.getElementById('store-address-section');

  if (!postSection  !storeSection) return;

   先全部隱藏
  postSection.style.display = 'none';
  storeSection.style.display = 'none';

  if (method === 'post') {
    postSection.style.display = 'block';
  }

  if (method === '711') {
    storeSection.style.display = 'block';
  }
}

 計算總重量函數
function recalcTotalWeight() {
  totalWeight = Object.values(cart).reduce((sum, item) = sum + item.qty  item.weight, 0);
}

 更新懸浮購物車內容
function updateFloatingCart() {
  const cartItemsContainer = document.getElementById('floating-cart-items');
  if (!cartItemsContainer) return;

   清空
  cartItemsContainer.innerHTML = '';

   只顯示 qty  0 的商品
  const visibleItems = Object.values(cart).filter(item = item.qty  0);

  visibleItems.forEach(item = {
    const div = document.createElement('div');
    div.className = 'floating-cart-item';
    div.innerHTML = `
      span class=item-name${item.displayName} ${item.weight}斤span
      span class=item-qtyx${item.qty}span
      span class=item-subtotal$${item.subtotal}span
    `;
    cartItemsContainer.appendChild(div);
  });


   懸浮購物車顯示(小計，運費，總計)
  document.getElementById('floating-subtotal').innerHTML =
    `span class=label 小計：spanspan class=amount$${finalSubtotal}span`;

  document.getElementById('floating-shipping').innerHTML =
    `span class=label 運費：spanspan class=amount$${finalShippingFee}span`;

  document.getElementById('floating-total').innerHTML =
    `span class=label 總計：spanspan class=amount$${finalTotal}span`;



  if (visibleItems.length === 0) {
    cartItemsContainer.innerHTML =
      'div style=text-aligncenter; color#888;購物車空空如也div';
  }
}

 第一頁開關
function handleOrderEnter() {
  const orderSwitch = APP_CONFIG.orderSwitch  '開';

  if (orderSwitch === '關') {
    customAlert('目前為停止採收期，暫停接單中 🌱nn我們會於開放時第一時間公告，感謝您的體諒！');
    return;
  }

  goToStep(2);
}
 頁面載入時同步開關狀態
document.addEventListener('DOMContentLoaded', () = {
  if (typeof APP_CONFIG === 'undefined') return;

  const btn = document.getElementById('order-enter-btn');
  if (!btn) return;

  if (APP_CONFIG.orderSwitch === '關') {
    btn.classList.add('is-disabled');

     🔥 改按鈕文字
    btn.innerText = '🚫 現在暫停接單';
  }
});

script
