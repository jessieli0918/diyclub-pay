const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());

// ========== 静态文件（安全：只暴露白名单文件，避免泄露 .env / server.js）==========
const PUBLIC_FILES = ['index.html', 'app.js', 'style.css', 'admin.html'];
const publicDir = path.join(__dirname, 'public');
const frontendDir = fs.existsSync(publicDir) ? publicDir : __dirname;

app.use((req, res, next) => {
  let rel = decodeURIComponent(req.path.replace(/^\/+/, ''));
  if (rel === '') rel = 'index.html';
  if (!PUBLIC_FILES.includes(rel)) return next();
  const filePath = path.join(frontendDir, rel);
  if (!fs.existsSync(filePath)) return next();
  res.sendFile(filePath);
});

// ========== 配置 ==========
const PORT = process.env.PORT || 3001;
const MODE = process.env.PAYPAL_MODE || 'demo';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || 'sb';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const CURRENCY = process.env.CURRENCY || 'USD';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ========== 数据库：Google Apps Script（生产用）+ 内存（本地备用）==========
let appsScriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
let useSheets = !!appsScriptUrl;
const ordersStore = new Map();

if (useSheets) {
  console.log('[DB] Using Google Sheets via Apps Script');
} else {
  console.log('[DB] Using in-memory storage (dev mode)');
}

// ========== 存储函数 ==========
async function saveOrder(order) {
  if (useSheets) {
    const res = await fetch(appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    if (!res.ok) throw new Error(`Apps Script save failed: ${res.status}`);
    return await res.json();
  } else {
    ordersStore.set(order.orderId, order);
    return { success: true, orderId: order.orderId };
  }
}

async function getOrder(orderId) {
  if (useSheets) {
    const res = await fetch(appsScriptUrl);
    const all = await res.json();
    return all.find(o => o.orderId === orderId) || null;
  } else {
    return ordersStore.get(orderId);
  }
}

async function updateOrder(orderId, updater) {
  if (useSheets) {
    // Apps Script 没提供单独 update 接口，我们用 doPost 走同一个入口
    // 简化：读取全部 → 改目标 → 用 doPost 存回去（先清空再追加）
    // 实际生产中我们改用"已存在则更新整行"的逻辑
    // 这里用 GET + POST 实现
    const res = await fetch(appsScriptUrl);
    const all = await res.json();
    const found = all.find(o => o.orderId === orderId);
    if (!found) return null;
    updater(found);
    // Apps Script 不支持单行更新，所以这里先获取所有再通过 delete + reposts 实现
    // 简化：直接 POST 新版本（doPost 是 appendRow，所以会重复）
    // 实际：我们在 Apps Script 里增加一个 action 参数
    const updateRes = await fetch(appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', order: found }),
    });
    return updateRes.json();
  } else {
    const order = ordersStore.get(orderId);
    if (order) {
      updater(order);
      ordersStore.set(orderId, order);
      return order;
    }
    return null;
  }
}

async function getAllOrders() {
  if (useSheets) {
    const res = await fetch(appsScriptUrl);
    return await res.json();
  } else {
    const orders = Array.from(ordersStore.values());
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return orders;
  }
}

// ========== PayPal API 基础 URL ==========
const PAYPAL_API = MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

function generateOrderId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `DIY-${timestamp}-${random}`;
}

async function getAccessToken() {
  if (MODE === 'demo') return 'demo-token';

  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return data.access_token;
}

// ========== API: 创建订单 ==========
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, type, orderId } = req.body;
    const token = await getAccessToken();

    if (MODE === 'demo') {
      return res.json({ id: 'DEMO_ORDER_' + Date.now(), status: 'CREATED', demo: true });
    }

    const orderData = {
      intent: 'CAPTURE',
      purchase_units: [{
        description: type === 'deposit' ? 'Deposit Payment' : 'Balance Payment',
        custom_id: orderId,
        amount: { currency_code: CURRENCY, value: amount.toFixed(2) },
      }],
    };

    const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(orderData),
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Create order failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== API: 确认收款 ==========
app.post('/api/capture-order', async (req, res) => {
  try {
    const { orderId, internalOrderId, type } = req.body;
    const token = await getAccessToken();

    if (MODE === 'demo') {
      await updateOrderStatus(internalOrderId, type, 'COMPLETED', '0.00');
      return res.json({
        id: orderId, status: 'COMPLETED', demo: true,
        purchase_units: [{ payments: { captures: [{ id: 'DEMO_' + Date.now(), status: 'COMPLETED', amount: { currency_code: CURRENCY, value: '0.00' } }] } }],
      });
    }

    const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    });

    const data = await response.json();
    
    if (data.status === 'COMPLETED') {
      const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
      const amount = capture?.amount?.value || '0.00';
      await updateOrderStatus(internalOrderId, type, 'COMPLETED', amount, data);
    }
    
    res.json(data);
  } catch (err) {
    console.error('Capture failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== 保存订单 ==========
app.post('/api/save-order', async (req, res) => {
  try {
    const order = {
      ...req.body,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    const result = await saveOrder(order);
    console.log(`[Save] Order ${order.orderId} saved`);
    
    res.json(result);
  } catch (err) {
    console.error('Save order failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== 更新订单 ==========
app.post('/api/update-order', async (req, res) => {
  try {
    const { orderId, shipping, balanceAmount } = req.body;
    
    let updated = null;
    await updateOrder(orderId, (order) => {
      if (shipping) order.shipping = shipping;
      if (balanceAmount) order.balanceAmount = balanceAmount;
      order.updatedAt = new Date().toISOString();
      updated = order;
    });
    
    if (!updated) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true, order: updated });
  } catch (err) {
    console.error('Update order failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== 查询订单 ==========
app.get('/api/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 更新订单状态（内部）==========
async function updateOrderStatus(orderId, type, status, amount, paypalData) {
  try {
    await updateOrder(orderId, (order) => {
      if (type === 'deposit') {
        order.depositStatus = status;
        order.depositAmount = amount;
        order.depositPaidAt = new Date().toISOString();
        if (paypalData && paypalData.payer) {
          const payer = paypalData.payer;
          order.payerInfo = {
            email: payer.email_address,
            name: payer.name ? `${payer.name.given_name} ${payer.name.surname}` : '',
            payerId: payer.payer_id,
          };
          if (payer.address) {
            order.paypalAddress = {
              address: payer.address.address_line_1 || '',
              city: payer.address.admin_area_2 || '',
              state: payer.address.admin_area_1 || '',
              zip: payer.address.postal_code || '',
              country: payer.address.country_code || '',
            };
          }
        }
      } else {
        order.balanceStatus = status;
        order.balanceAmount = amount;
        order.balancePaidAt = new Date().toISOString();
      }
      order.updatedAt = new Date().toISOString();
    });
    console.log(`[Update] Order ${orderId} ${type} -> ${status}`);
  } catch (e) {
    console.error('Update order status failed:', e);
  }
}

// ========== 商家后台 ==========
app.get('/api/admin/orders', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  
  try {
    const orders = await getAllOrders();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 配置 ==========
app.get('/api/config', (req, res) => {
  res.json({ clientId: CLIENT_ID, currency: CURRENCY, mode: MODE });
});

// ========== 健康检查 ==========
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mode: MODE,
    db: useSheets ? 'google-sheets' : 'memory',
    timestamp: new Date().toISOString()
  });
});

// ========== 启动 ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════════════════════╗
  ║        DIYCLUB Payment Server 🚀              ║
  ╠═══════════════════════════════════════════════╣
  ║  Local:  http://localhost:${PORT}              ║
  ║  Mode:   ${MODE.padEnd(22)} ║
  ║  DB:     ${useSheets ? 'Google Sheets' : 'Memory (dev)'}        ║
  ║  Currency: ${CURRENCY.padEnd(19)} ║
  ╚═══════════════════════════════════════════════╝
  `);
});
