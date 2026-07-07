// ========== State ==========
const state = {
  currentOrder: null,
  depositPaid: false,
  balancePaid: false,
};

const DEPOSIT_AMOUNT = 45;
const STORAGE_KEY = 'diyclub_order';
const SHIPPING_KEY = 'diyclub_shipping';

// ========== LocalStorage Functions ==========
function saveOrderToLocal(order) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
}

function getOrderFromLocal() {
  const data = localStorage.getItem(STORAGE_KEY);
  return data ? JSON.parse(data) : null;
}

function clearOrderFromLocal() {
  localStorage.removeItem(STORAGE_KEY);
}

function saveShippingToLocal(shipping) {
  localStorage.setItem(SHIPPING_KEY, JSON.stringify(shipping));
}

function getShippingFromLocal() {
  const data = localStorage.getItem(SHIPPING_KEY);
  return data ? JSON.parse(data) : null;
}

function clearShippingFromLocal() {
  localStorage.removeItem(SHIPPING_KEY);
}

// ========== Generate Order ID ==========
function generateOrderId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `DIY-${timestamp}-${random}`;
}

// ========== Auto-Save Shipping Form ==========
function setupShippingAutoSave() {
  const fields = ['shipping-name', 'shipping-phone', 'shipping-email', 'shipping-address', 'shipping-city', 'shipping-state', 'shipping-zip', 'shipping-country'];
  
  // Load saved data on page load
  const saved = getShippingFromLocal();
  if (saved) {
    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el && saved[id.replace('shipping-', '')]) {
        el.value = saved[id.replace('shipping-', '')];
      }
    });
  }
  
  // Auto-save on every input change
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        const data = {
          name: document.getElementById('shipping-name')?.value?.trim() || '',
          phone: document.getElementById('shipping-phone')?.value?.trim() || '',
          email: document.getElementById('shipping-email')?.value?.trim() || '',
          address: document.getElementById('shipping-address')?.value?.trim() || '',
          city: document.getElementById('shipping-city')?.value?.trim() || '',
          state: document.getElementById('shipping-state')?.value?.trim() || '',
          zip: document.getElementById('shipping-zip')?.value?.trim() || '',
          country: document.getElementById('shipping-country')?.value || 'US',
        };
        saveShippingToLocal(data);
      });
    }
  });
}

// ========== Render PayPal Buttons ==========
function renderButtons() {
  if (typeof paypal === 'undefined') {
    console.warn('PayPal SDK not loaded yet');
    return;
  }

  // Check for saved order
  checkLocalOrder();
  
  // Setup shipping auto-save
  setupShippingAutoSave();

  // ======== Deposit button ========
  paypal.Buttons({
    style: { shape: 'rect', color: 'gold', layout: 'vertical', label: 'paypal' },
    createOrder: async function() {
      const resultEl = document.getElementById('deposit-result');
      showResult(resultEl, 'Creating order...', 'loading');
      
      // Generate internal order ID
      const internalOrderId = generateOrderId();
      state.currentOrder = {
        orderId: internalOrderId,
        depositStatus: 'PENDING',
        balanceStatus: 'PENDING',
        createdAt: new Date().toISOString(),
      };
      
      // Save order to server
      await fetch('/api/save-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.currentOrder),
      });
      
      // Create PayPal order
      const res = await fetch('/api/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: DEPOSIT_AMOUNT, type: 'deposit', orderId: internalOrderId }),
      });
      
      const order = await res.json();
      if (order.error) {
        showResult(resultEl, 'Failed to create order: ' + order.error, 'error');
        throw new Error(order.error);
      }
      
      showResult(resultEl, 'Redirecting to PayPal...', 'loading');
      return order.id;
    },
    onApprove: async function(data) {
      const resultEl = document.getElementById('deposit-result');
      showResult(resultEl, 'Confirming payment...', 'loading');
      
      const res = await fetch('/api/capture-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: data.orderID, internalOrderId: state.currentOrder.orderId, type: 'deposit' }),
      });
      
      const capture = await res.json();
      if (capture.error || capture.status === 'FAILED') {
        showResult(resultEl, 'Payment failed. Please try again.', 'error');
        return;
      }
      
      // Update order status
      state.currentOrder.depositStatus = 'COMPLETED';
      state.currentOrder.depositAmount = DEPOSIT_AMOUNT.toFixed(2);
      state.currentOrder.depositPaidAt = new Date().toISOString();
      
      // 从PayPal获取地址
      if (capture.payer) {
        const payer = capture.payer;
        state.currentOrder.payerInfo = {
          email: payer.email_address,
          name: payer.name ? `${payer.name.given_name} ${payer.name.surname}` : '',
          payerId: payer.payer_id,
        };
        if (payer.address) {
          state.currentOrder.paypalAddress = {
            address: payer.address.address_line_1 || '',
            city: payer.address.admin_area_2 || '',
            state: payer.address.admin_area_1 || '',
            zip: payer.address.postal_code || '',
            country: payer.address.country_code || '',
          };
        }
      }
      
      state.depositPaid = true;
      
      // Save to localStorage
      saveOrderToLocal(state.currentOrder);
      
      // Show success state
      onDepositPaid();
    },
    onCancel: function() {
      showResult(document.getElementById('deposit-result'), 'Payment cancelled', 'error');
    },
    onError: function(err) {
      console.error(err);
      showResult(document.getElementById('deposit-result'), 'Something went wrong. Please try again.', 'error');
    },
  }).render('#deposit-button-container');

  // ======== Balance button ========
  paypal.Buttons({
    style: { shape: 'rect', color: 'gold', layout: 'vertical', label: 'paypal' },
    createOrder: async function() {
      const amount = parseFloat(document.getElementById('balance-amount').value);
      const resultEl = document.getElementById('balance-result');
      
      if (!amount || amount <= 0) {
        alert('Please enter a valid balance amount');
        throw new Error('Invalid amount');
      }
      
      if (!state.depositPaid && state.currentOrder?.depositStatus !== 'COMPLETED') {
        alert('Please pay the deposit first');
        throw new Error('Deposit not paid');
      }
      
      showResult(resultEl, 'Creating order...', 'loading');
      
      // Collect shipping info (if filled)
      const shipping = collectShippingInfo();
      
      // Save shipping info to order (if provided)
      if (shipping.name && shipping.address) {
        state.currentOrder.shipping = shipping;
        await fetch('/api/update-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            orderId: state.currentOrder.orderId, 
            shipping, 
            balanceAmount: amount 
          }),
        });
      }
      
      const res = await fetch('/api/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          amount, 
          type: 'balance', 
          orderId: state.currentOrder?.orderId || 'unknown' 
        }),
      });
      
      const order = await res.json();
      if (order.error) {
        showResult(resultEl, 'Failed to create order: ' + order.error, 'error');
        throw new Error(order.error);
      }
      
      showResult(resultEl, 'Redirecting to PayPal...', 'loading');
      return order.id;
    },
    onApprove: async function(data) {
      const resultEl = document.getElementById('balance-result');
      showResult(resultEl, 'Confirming payment...', 'loading');
      
      const res = await fetch('/api/capture-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          orderId: data.orderID, 
          internalOrderId: state.currentOrder?.orderId || 'unknown', 
          type: 'balance' 
        }),
      });
      
      const capture = await res.json();
      if (capture.error || capture.status === 'FAILED') {
        showResult(resultEl, 'Payment failed. Please try again.', 'error');
        return;
      }
      
      // Update order
      const balanceAmount = document.getElementById('balance-amount').value;
      state.currentOrder.balanceStatus = 'COMPLETED';
      state.currentOrder.balanceAmount = balanceAmount;
      state.currentOrder.balancePaidAt = new Date().toISOString();
      
      // 从PayPal获取地址（如果客户用PayPal账户付款）
      if (capture.payer) {
        const payer = capture.payer;
        if (!state.currentOrder.payerInfo) {
          state.currentOrder.payerInfo = {
            email: payer.email_address,
            name: payer.name ? `${payer.name.given_name} ${payer.name.surname}` : '',
            payerId: payer.payer_id,
          };
        }
        if (payer.address && !state.currentOrder.paypalAddress) {
          state.currentOrder.paypalAddress = {
            address: payer.address.address_line_1 || '',
            city: payer.address.admin_area_2 || '',
            state: payer.address.admin_area_1 || '',
            zip: payer.address.postal_code || '',
            country: payer.address.country_code || '',
          };
        }
      }
      
      state.balancePaid = true;
      
      // Save to localStorage (for address confirmation)
      saveOrderToLocal(state.currentOrder);
      
      // Show address confirmation
      onPaymentComplete();
    },
    onCancel: function() {
      showResult(document.getElementById('balance-result'), 'Payment cancelled', 'error');
    },
    onError: function(err) {
      console.error(err);
      showResult(document.getElementById('balance-result'), 'Something went wrong. Please try again.', 'error');
    },
  }).render('#balance-button-container');
}

// ========== On Deposit Paid ==========
function onDepositPaid() {
  // Update step indicator
  document.getElementById('step1').classList.add('done');
  document.getElementById('step1').querySelector('.step-num').textContent = '✓';
  document.getElementById('step-line-1').classList.add('done');
  document.getElementById('step2').classList.add('active');
  
  // Mark deposit card as paid
  const depositCard = document.getElementById('deposit-card');
  depositCard.classList.add('deposit-paid');
  
  // Hide PayPal button, show success message
  document.getElementById('deposit-button-container').innerHTML = '';
  document.getElementById('deposit-result').innerHTML = '';
  document.getElementById('deposit-result').style.display = 'none';
  
  // Show shipping card
  document.getElementById('shipping-card').style.display = 'block';
  document.getElementById('shipping-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  // Show summary card
  const summaryCard = document.getElementById('summary-card');
  summaryCard.style.display = 'block';
  document.getElementById('summary-order-id').textContent = state.currentOrder.orderId;
  
  // Show result
  showResult(document.getElementById('deposit-result'), '✓ Deposit paid successfully!', 'success');
}

// ========== On Payment Complete ==========
function onPaymentComplete() {
  // Update steps
  document.getElementById('step2').classList.add('done');
  document.getElementById('step2').querySelector('.step-num').textContent = '✓';
  document.getElementById('step-line-2').classList.add('done');
  document.getElementById('step3').classList.add('done');
  document.getElementById('step3').querySelector('.step-num').textContent = '✓';
  
  // Hide payment cards
  document.getElementById('deposit-card').style.display = 'none';
  document.getElementById('balance-card').style.display = 'none';
  document.getElementById('shipping-card').style.display = 'none';
  document.getElementById('summary-card').style.display = 'none';
  
  // Show address confirmation
  showAddressConfirmation();
}

// ========== Show Address Confirmation ==========
function showAddressConfirmation() {
  const card = document.getElementById('address-confirm-card');
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  // Try to get address from: 1) Manual input, 2) PayPal, 3) Empty
  const manualAddr = state.currentOrder?.shipping || {};
  const paypalAddr = state.currentOrder?.paypalAddress || {};
  const payerInfo = state.currentOrder?.payerInfo || {};
  
  // Use manual if available, otherwise PayPal
  const addr = manualAddr.name ? manualAddr : paypalAddr;
  
  // Fill form
  document.getElementById('confirm-name').value = addr.name || payerInfo.name || '';
  document.getElementById('confirm-phone').value = manualAddr.phone || '';
  document.getElementById('confirm-email').value = manualAddr.email || payerInfo.email || '';
  document.getElementById('confirm-address').value = addr.address || '';
  document.getElementById('confirm-city').value = addr.city || '';
  document.getElementById('confirm-state').value = addr.state || '';
  document.getElementById('confirm-zip').value = addr.zip || '';
  document.getElementById('confirm-country').value = addr.country || 'US';
  
  // Show address preview
  const previewEl = document.getElementById('address-preview');
  if (addr.address || manualAddr.phone || payerInfo.email) {
    previewEl.innerHTML = `
      <p><strong>${addr.name || payerInfo.name || 'N/A'}</strong></p>
      <p>${addr.address || 'N/A'}</p>
      <p>${addr.city || ''}, ${addr.state || ''} ${addr.zip || ''}</p>
      <p>${addr.country || ''}</p>
      ${manualAddr.phone ? `<p>📞 ${manualAddr.phone}</p>` : ''}
      ${payerInfo.email ? `<p>📧 ${payerInfo.email}</p>` : ''}
    `;
  } else {
    previewEl.innerHTML = '<p class="no-address">Please fill in your shipping address below</p>';
  }
  
  // Show source badge
  const badgeEl = document.getElementById('address-source-badge');
  if (manualAddr.name) {
    badgeEl.innerHTML = '<span class="source-tag manual">📋 From your input</span>';
  } else if (paypalAddr.address) {
    badgeEl.innerHTML = '<span class="source-tag paypal">💳 From PayPal</span>';
  } else {
    badgeEl.innerHTML = '<span class="source-tag empty">⚠️ No address yet</span>';
  }
}

// ========== Confirm Address ==========
async function confirmAddress() {
  const shipping = {
    name: document.getElementById('confirm-name').value.trim(),
    phone: document.getElementById('confirm-phone').value.trim(),
    email: document.getElementById('confirm-email').value.trim(),
    address: document.getElementById('confirm-address').value.trim(),
    city: document.getElementById('confirm-city').value.trim(),
    state: document.getElementById('confirm-state').value.trim(),
    zip: document.getElementById('confirm-zip').value.trim(),
    country: document.getElementById('confirm-country').value,
  };
  
  // Validate required fields
  if (!shipping.name || !shipping.address || !shipping.city || !shipping.state || !shipping.zip || !shipping.phone) {
    alert('Please fill in all required fields: Name, Address, City, State, ZIP, and Phone');
    return;
  }
  
  // Save to order
  if (state.currentOrder) {
    state.currentOrder.shipping = shipping;
    
    await fetch('/api/update-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: state.currentOrder.orderId,
        shipping,
      }),
    });
  }
  
  // Show complete page
  showCompletePage();
}

// ========== Show Complete Page ==========
function showCompletePage() {
  // Hide address confirmation
  document.getElementById('address-confirm-card').style.display = 'none';
  
  // Show complete card
  const completeCard = document.getElementById('complete-card');
  completeCard.style.display = 'block';
  completeCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  // Fill in details
  const deposit = parseFloat(state.currentOrder.depositAmount || DEPOSIT_AMOUNT);
  const balance = parseFloat(state.currentOrder.balanceAmount || 0);
  const total = deposit + balance;
  
  document.getElementById('final-order-id').textContent = state.currentOrder.orderId;
  document.getElementById('final-deposit').textContent = `$${deposit.toFixed(2)}`;
  document.getElementById('final-balance').textContent = `$${balance.toFixed(2)}`;
  document.getElementById('final-total').textContent = `$${total.toFixed(2)} USD`;
  
  // Fill shipping info
  const shipping = state.currentOrder.shipping || {};
  if (shipping.name) {
    document.getElementById('final-shipping-name').textContent = shipping.name;
    document.getElementById('final-shipping-address').textContent = shipping.address || '';
    document.getElementById('final-shipping-city').textContent = 
      `${shipping.city || ''}, ${shipping.state || ''} ${shipping.zip || ''}, ${shipping.country || ''}`;
    document.getElementById('final-shipping-phone').textContent = shipping.phone || '';
  }
  
  // Clear localStorage
  clearOrderFromLocal();
  clearShippingFromLocal();
}

// ========== Collect Shipping Info ==========
function collectShippingInfo() {
  return {
    name: document.getElementById('shipping-name')?.value?.trim() || '',
    phone: document.getElementById('shipping-phone')?.value?.trim() || '',
    email: document.getElementById('shipping-email')?.value?.trim() || '',
    address: document.getElementById('shipping-address')?.value?.trim() || '',
    city: document.getElementById('shipping-city')?.value?.trim() || '',
    state: document.getElementById('shipping-state')?.value?.trim() || '',
    zip: document.getElementById('shipping-zip')?.value?.trim() || '',
    country: document.getElementById('shipping-country')?.value || 'US',
  };
}

// ========== Check Local Order ==========
function checkLocalOrder() {
  const savedOrder = getOrderFromLocal();
  
  if (!savedOrder) return;
  
  // Check if already complete
  if (savedOrder.balanceStatus === 'COMPLETED') {
    clearOrderFromLocal();
    return;
  }
  
  // Check if deposit paid
  if (savedOrder.depositStatus === 'COMPLETED') {
    state.currentOrder = savedOrder;
    state.depositPaid = true;
    onDepositPaid();
  }
}

// ========== Show Result Message ==========
function showResult(el, msg, type) {
  if (!msg) {
    el.style.display = 'none';
    return;
  }
  el.className = 'result-message ' + type;
  el.textContent = msg;
  el.style.display = 'block';
}
