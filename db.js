const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'database.json');

// Default initial database
const defaultData = {
  products: [
    {
      id: 'gemini_adv_1m',
      name: 'اکانت اختصاصی Gemini Advanced (۱ ماهه)',
      category: 'اختصاصی',
      price: 390000,
      stock: 12,
      description: '• فعال‌سازی روی جیمیل شما یا اکانت آماده\n• دسترسی به مدل‌های Ultra و 1.5 Pro با سقف نامحدود\n• همراه با ۲ ترابایت فضای ابری Google One\n• گارانتی و پشتیبانی کامل ۳۰ روزه',
      active: true
    },
    {
      id: 'gemini_adv_share',
      name: 'اکانت اشتراکی Gemini Advanced (۱ ماهه)',
      category: 'اشتراکی',
      price: 160000,
      stock: 25,
      description: '• تحویل اکانت آماده با ایمیل و پسورد اختصاصی\n• دسترسی کامل به قابلیت‌های هوش مصنوعی پیشرفته گوگل\n• قیمت کاملاً اقتصادی برای دانشجویان و پژوهشگران\n• تحویل آنی پس از پرداخت',
      active: true
    },
    {
      id: 'gemini_api_pro',
      name: 'اکانت و لایسنس Gemini 1.5 Pro API',
      category: 'توسعه‌دهندگان',
      price: 490000,
      stock: 8,
      description: '• کلید اختصاصی API برای برنامه‌نویسان و بات‌ها\n• کانتکست ویندوز ۲ میلیون توکن (بالاترین سطح در دنیا)\n• بدون فیلتر و با ریت‌لیمیت بالا\n• راهنمای کامل اتصال به پایتون، نودجی‌اس و لنگ‌چین',
      active: true
    }
  ],
  channels: [
    {
      username: 'rad_protocol',
      title: 'کانال رسمی RadProtocol',
      link: 'https://t.me/rad_protocol'
    }
  ],
  users: {},
  orders: [],
  states: {}, // userId -> { state: string, data: object }
  settings: {
    shop_open: true
  }
};

function loadDb() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      saveDb(defaultData);
      return defaultData;
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.channels) {
      parsed.channels = defaultData.channels;
    }
    return parsed;
  } catch (err) {
    console.error('Error loading DB:', err.message);
    return defaultData;
  }
}

function saveDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving DB:', err.message);
  }
}

const db = {
  getProducts: () => {
    const data = loadDb();
    return data.products.filter(p => p.active !== false);
  },

  getAllProducts: () => {
    const data = loadDb();
    return data.products;
  },

  getProduct: (id) => {
    const data = loadDb();
    return data.products.find(p => p.id === id);
  },

  addProduct: (product) => {
    const data = loadDb();
    const id = product.id || 'prod_' + Date.now();
    const newProd = {
      id,
      name: product.name,
      category: product.category || 'عمومی',
      price: parseInt(product.price, 10) || 0,
      stock: parseInt(product.stock, 10) || 0,
      description: product.description || '',
      active: true,
      createdAt: new Date().toISOString()
    };
    data.products.push(newProd);
    saveDb(data);
    return newProd;
  },

  updateProductPrice: (id, newPrice) => {
    const data = loadDb();
    const prod = data.products.find(p => p.id === id);
    if (prod) {
      prod.price = parseInt(newPrice, 10);
      saveDb(data);
      return prod;
    }
    return null;
  },

  updateProductStock: (id, newStock) => {
    const data = loadDb();
    const prod = data.products.find(p => p.id === id);
    if (prod) {
      prod.stock = parseInt(newStock, 10);
      saveDb(data);
      return prod;
    }
    return null;
  },

  deleteProduct: (id) => {
    const data = loadDb();
    const index = data.products.findIndex(p => p.id === id);
    if (index !== -1) {
      data.products[index].active = false;
      saveDb(data);
      return true;
    }
    return false;
  },

  // Channels (Force Join Management)
  getChannels: () => {
    const data = loadDb();
    return data.channels || [];
  },

  addChannel: (channel) => {
    const data = loadDb();
    if (!data.channels) data.channels = [];
    const cleanUsername = channel.username.replace('@', '').replace('https://t.me/', '').trim();
    // Check if exists
    if (data.channels.some(c => c.username.toLowerCase() === cleanUsername.toLowerCase())) {
      return false;
    }
    const newChannel = {
      username: cleanUsername,
      title: channel.title || `@${cleanUsername}`,
      link: channel.link || `https://t.me/${cleanUsername}`
    };
    data.channels.push(newChannel);
    saveDb(data);
    return newChannel;
  },

  removeChannel: (username) => {
    const data = loadDb();
    if (!data.channels) return false;
    const cleanUsername = username.replace('@', '').replace('https://t.me/', '').trim().toLowerCase();
    const initialLen = data.channels.length;
    data.channels = data.channels.filter(c => c.username.toLowerCase() !== cleanUsername);
    if (data.channels.length !== initialLen) {
      saveDb(data);
      return true;
    }
    return false;
  },

  // State Management (FSM)
  setState: (userId, state, meta = {}) => {
    const data = loadDb();
    data.states[userId] = { state, data: meta, updatedAt: Date.now() };
    saveDb(data);
  },

  getState: (userId) => {
    const data = loadDb();
    return data.states[userId] || null;
  },

  clearState: (userId) => {
    const data = loadDb();
    delete data.states[userId];
    saveDb(data);
  },

  // User tracking
  touchUser: (user) => {
    const data = loadDb();
    if (!data.users[user.id]) {
      data.users[user.id] = {
        id: user.id,
        first_name: user.first_name || user.name || '',
        username: user.username || '',
        joinedAt: new Date().toISOString(),
        ordersCount: 0
      };
    } else {
      if (user.first_name || user.name) data.users[user.id].first_name = user.first_name || user.name;
      if (user.username !== undefined) data.users[user.id].username = user.username;
    }
    saveDb(data);
    return data.users[user.id];
  },

  saveUser: function(user) {
    return this.touchUser(user);
  },

  getUsersCount: () => {
    const data = loadDb();
    return Object.keys(data.users).length;
  },

  // Orders
  createOrder: (userId, productId) => {
    const data = loadDb();
    const prod = data.products.find(p => p.id === productId);
    if (!prod || prod.stock <= 0) return null;

    // Decrease stock
    prod.stock -= 1;

    const order = {
      orderId: 'ORD-' + Math.floor(100000 + Math.random() * 900000),
      userId,
      productId,
      productName: prod.name,
      price: prod.price,
      status: 'pending_payment',
      createdAt: new Date().toISOString()
    };

    data.orders.push(order);
    if (data.users[userId]) {
      data.users[userId].ordersCount = (data.users[userId].ordersCount || 0) + 1;
    }
    saveDb(data);
    return order;
  },

  getUserOrders: (userId) => {
    const data = loadDb();
    return data.orders.filter(o => o.userId === userId);
  }
};

module.exports = db;
