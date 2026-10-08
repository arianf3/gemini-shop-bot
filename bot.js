/**
 * Gemini Accounts Telegram Shop Bot (@theKiANshop_bot)
 * Customer Catalog, Glass Button Icons, Dynamic Force-Join & Admin Management
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');
const config = require('./config');
const db = require('./db');

const BOT_TOKEN = config.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const PROXY_URL = config.PROXY_URL;

// Read Admin Token for channel membership verification (Riddle bot token fallback)
let ADMIN_VERIFY_TOKEN = '';
try {
  const envContent = require('fs').readFileSync('/root/.hermes/.env', 'utf8');
  const m = envContent.match(/TELEGRAM_BOT_TOKEN=([^\r\n]+)/);
  if (m) ADMIN_VERIFY_TOKEN = m[1].trim();
} catch (e) {}

// Persian digits converter
function toFaDigits(str) {
  if (str === undefined || str === null) return '';
  const f = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  return str.toString().replace(/[0-9]/g, (d) => f[d]);
}

function formatPrice(val) {
  if (!val && val !== 0) return '۰ تومان';
  const num = typeof val === 'number' ? val : parseInt(val, 10);
  return `${toFaDigits(num.toLocaleString())} تومان`;
}

function isAdmin(userId) {
  if (!userId) return false;
  return db.isAdmin(userId) || config.ADMIN_IDS.map(id => id.toString()).includes(userId.toString());
}

// Low-level HTTP / Proxy Request
function request(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';

    if (PROXY_URL && (parsed.hostname.includes('telegram.org') || options.useProxy)) {
      const p = new URL(PROXY_URL);
      if (isHttps) {
        const req = http.request({
          host: p.hostname,
          port: p.port,
          method: 'CONNECT',
          path: `${parsed.hostname}:${parsed.port || 443}`
        });

        req.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Proxy CONNECT error: ${res.statusCode}`));
          }
          const secureSocket = tls.connect({
            socket,
            servername: parsed.hostname
          }, () => {
            const tlsReq = https.request({
              host: parsed.hostname,
              path: parsed.pathname + parsed.search,
              method: options.method || 'GET',
              headers: options.headers || {},
              createConnection: () => secureSocket
            }, (tlsRes) => {
              let data = '';
              tlsRes.on('data', chunk => data += chunk);
              tlsRes.on('end', () => resolve({ statusCode: tlsRes.statusCode, data }));
            });
            tlsReq.on('error', reject);
            if (options.body) tlsReq.write(options.body);
            tlsReq.end();
          });
          secureSocket.on('error', reject);
        });

        req.on('error', reject);
        req.end();
        return;
      }
    }

    const client = isHttps ? https : http;
    const req = client.request(urlStr, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Telegram API Call
async function tgCall(method, payload = {}) {
  try {
    const body = JSON.stringify(payload);
    const res = await request(`${TELEGRAM_API}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      body
    });
    return JSON.parse(res.data);
  } catch (err) {
    console.error(`Telegram API error [${method}]:`, err.message);
    return { ok: false, error: err.message };
  }
}

// In-memory cache for channel membership verification (TTL: 3 minutes)
const membershipCache = new Map();

// Check membership across dynamic channels
async function checkUserMembership(userId, forceRefresh = false) {
  if (isAdmin(userId)) return { ok: true, missing: [] };

  if (!forceRefresh) {
    const cached = membershipCache.get(userId.toString());
    if (cached && (Date.now() - cached.timestamp < 180000)) {
      if (cached.ok) return { ok: true, missing: [] };
    }
  }

  const channels = db.getChannels();
  if (!channels || channels.length === 0) return { ok: true, missing: [] };

  const missing = [];
  for (const ch of channels) {
    const chatId = ch.id || `@${ch.username.replace('@', '')}`;
    let isMember = false;

    // 1. Try bot's own token
    try {
      const checkRes = await tgCall('getChatMember', { chat_id: chatId, user_id: userId });
      if (checkRes && checkRes.ok) {
        const st = checkRes.result.status;
        if (['creator', 'administrator', 'member', 'restricted'].includes(st)) {
          isMember = true;
        }
      }
    } catch (e) {}

    // 2. Fallback to Admin Verify token (Riddle bot) if needed
    if (!isMember && ADMIN_VERIFY_TOKEN) {
      try {
        const body = JSON.stringify({ chat_id: chatId, user_id: userId });
        const res = await request(`https://api.telegram.org/bot${ADMIN_VERIFY_TOKEN}/getChatMember`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          },
          body
        });
        const parsed = JSON.parse(res.data);
        if (parsed && parsed.ok) {
          const st = parsed.result.status;
          if (['creator', 'administrator', 'member', 'restricted'].includes(st)) {
            isMember = true;
          }
        }
      } catch (e) {}
    }

    if (!isMember) {
      missing.push(ch);
    }
  }

  const isOk = missing.length === 0;
  if (isOk) {
    membershipCache.set(userId.toString(), { ok: true, timestamp: Date.now() });
  } else {
    membershipCache.delete(userId.toString());
  }

  return { ok: isOk, missing };
}

// Force-Join Lock Screen UI
function getForceJoinLockUI(missingChannels, userName) {
  let text =
    `سلام <b>${userName || 'کاربر گرامی'}</b> عزیز! 💎\n\n` +
    `🔒 <b>برای دسترسی به فروشگاه و خرید اکانت‌های جمینای، لطفاً ابتدا در کانال‌های زیر عضو شوید:</b>\n\n`;

  missingChannels.forEach((ch, idx) => {
    text += `${toFaDigits(idx + 1)}. 📢 <b>${ch.title}</b> (@${ch.username})\n`;
  });

  text += `\n👇 <i>پس از عضویت در کانال‌های بالا، دکمه «تایید عضویت ✅» را لمس کنید:</i>`;

  const buttons = [];
  missingChannels.forEach(ch => {
    buttons.push([{ text: `📢 عضویت در ${ch.title}`, url: ch.link }]);
  });
  buttons.push([{ text: '✅ تایید و بررسی عضویت', callback_data: 'verify_join' }]);

  return { text, reply_markup: { inline_keyboard: buttons } };
}

// ===================== UI BUILDERS =====================

// Customer Main Menu
function getCustomerMainMenu(userId, userName) {
  const adminMode = isAdmin(userId);
  const settings = db.getSettings();
  let text = settings.start_message ||
    `سلام <b>{name}</b> عزیز! 💎\n\n` +
    `به <b>{shop_name}</b> خوش آمدید.\n` +
    `تمامی اشتراک‌ها و اکانت‌های هوش مصنوعی گوگل (Gemini Advanced & Ultra) با گارانتی تعویض و تحویل سریع ارائه می‌شوند.\n\n` +
    `👇 <b>لطفاً از منوی زیر گزینه مورد نظرتان را انتخاب کنید:</b>`;

  text = text
    .replace(/\{name\}/g, userName || 'کاربر گرامی')
    .replace(/\{shop_name\}/g, config.SHOP_NAME);

  const buttons = [
    [{ text: '🛍 مشاهده و خرید اکانت‌های جمینای', callback_data: 'user_catalog' }],
    [{ text: '🌐 ورود به وب‌سایت و کاتالوگ فروشگاه', web_app: { url: 'https://arianf3.github.io/gemini-shop-bot/' } }],
    [
      { text: '📦 سفارشات من', callback_data: 'user_orders' },
      { text: '💳 راهنمای خرید و تحویل', callback_data: 'user_guide' }
    ],
    [{ text: '📞 پشتیبانی و ارتباط با مدیر', url: `https://t.me/${config.SUPPORT_USERNAME.replace('@', '')}` }]
  ];

  if (adminMode) {
    buttons.push([{ text: '🔐 ورود به پنل مدیریت ادمین', callback_data: 'admin_dashboard' }]);
  }

  return { text, reply_markup: { inline_keyboard: buttons } };
}

// Customer Catalog (With Glass Icons: 🟢 for in-stock, 🔴 for out-of-stock)
function getCustomerCatalog() {
  const products = db.getProducts();

  if (products.length === 0) {
    return {
      text: '⚠️ در حال حاضر هیچ محصول فعالی در فروشگاه موجود نیست. لطفاً بعداً بررسی نمایید.',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'user_menu' }]]
      }
    };
  }

  let text = '🛍 <b>لیست اکانت‌ها و اشتراک‌های فعال جمینای:</b>\n\n';
  text += '🟢 = موجود در انبار  |  🔴 = ناموجود (اتمام ظرفیت)\n';
  text += '━━━━━━━━━━━━━━━━━━\n\n';

  const buttons = [];

  products.forEach((p, idx) => {
    const inStock = p.stock > 0;
    const stockStatus = inStock ? `🟢 موجود (${toFaDigits(p.stock)} عدد)` : '🔴 ناموجود';
    
    text += `${toFaDigits(idx + 1)}. <b>${p.name}</b>\n`;
    text += `💰 <b>قیمت:</b> <code>${formatPrice(p.price)}</code>\n`;
    text += `📦 <b>وضعیت:</b> ${stockStatus}\n\n`;

    // Glass button icon: 🟢 for available, 🔴 for out of stock
    const buttonIcon = inStock ? '🟢 💎' : '🔴 🛑';
    const buttonText = inStock 
      ? `${buttonIcon} ${p.name} | ${formatPrice(p.price)}`
      : `${buttonIcon} ${p.name} (❌ ناموجود)`;

    buttons.push([
      { text: buttonText, callback_data: `view_prod_${p.id}` }
    ]);
  });

  text += '👇 <i>برای مشاهده مشخصات کامل هر اکانت، روی دکمه شیشه‌ای آن کلیک کنید:</i>';
  buttons.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'user_menu' }]);

  return { text, reply_markup: { inline_keyboard: buttons } };
}

// Customer Product View
function getCustomerProductDetail(product) {
  const inStock = product.stock > 0;
  const stockText = inStock ? `🟢 موجود در انبار (${toFaDigits(product.stock)} عدد)` : '🔴 ناموجود (اتمام موجودی)';

  const text =
    `💎 <b>مشخصات محصول: ${product.name}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🏷 <b>دسته‌بندی:</b> ${product.category}\n` +
    `💰 <b>قیمت:</b> <code>${formatPrice(product.price)}</code>\n` +
    `📦 <b>وضعیت انبار:</b> <b>${stockText}</b>\n\n` +
    `📋 <b>توضیحات و امکانات:</b>\n` +
    `${product.description}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⚡️ <i>گارانتی تعویض تا آخرین روز اشتراک</i>`;

  const buttons = [];
  if (inStock) {
    buttons.push([{ text: '💳 خرید و ثبت سفارش (🟢 موجود)', callback_data: `buy_prod_${product.id}` }]);
  } else {
    buttons.push([{ text: '🔴 این اکانت در حال حاضر ناموجود است', callback_data: 'alert_stock_empty' }]);
  }

  buttons.push([
    { text: '🔙 بازگشت به کاتالوگ', callback_data: 'user_catalog' },
    { text: '🏠 منوی اصلی', callback_data: 'user_menu' }
  ]);

  return { text, reply_markup: { inline_keyboard: buttons } };
}

// Customer Order Checkout Prompt
function getCustomerCheckout(product, order) {
  const text =
    `🎉 <b>پیش‌فاکتور سفارش شما صادر شد!</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🆔 <b>کد پیگیری سفارش:</b> <code>${order.orderId}</code>\n` +
    `📦 <b>محصول:</b> ${product.name}\n` +
    `💰 <b>مبلغ قابل پرداخت:</b> <code>${formatPrice(product.price)}</code>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💳 <b>اطلاعات پرداخت کارت به کارت:</b>\n` +
    `• شماره کارت: <code>${config.CARD_NUMBER}</code>\n` +
    `• نام دارنده: <b>${config.CARD_HOLDER}</b>\n\n` +
    `📸 <b>مرحله بعد:</b>\n` +
    `پس از واریز مبلغ، تصویر رسید پرداختی را به همراه کد پیگیری (<code>${order.orderId}</code>) برای پشتیبانی ارسال فرمایید تا اکانت تحویل داده شود.`;

  const buttons = [
    [{ text: '📤 ارسال فیش به پشتیبانی', url: `https://t.me/${config.SUPPORT_USERNAME.replace('@', '')}` }],
    [{ text: '🔙 بازگشت به لیست محصولات', callback_data: 'user_catalog' }]
  ];

  return { text, reply_markup: { inline_keyboard: buttons } };
}

// ===================== ADMIN PANELS =====================

// Admin Main Dashboard
function getAdminDashboard() {
  const products = db.getAllProducts().filter(p => p.active !== false);
  const totalUsers = db.getUsersCount();
  const channels = db.getChannels();
  const admins = db.getAdmins();

  const text =
    `🔐 <b>پنل مدیریت ادمین فروشگاه جمینای</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>آمار زنده فروشگاه:</b>\n` +
    `• تعداد کل محصولات: <b>${toFaDigits(products.length)} محصول</b>\n` +
    `• تعداد کاربران: <b>${toFaDigits(totalUsers)} نفر</b>\n` +
    `• تعداد مدیران: <b>${toFaDigits(admins.length)} نفر</b>\n` +
    `• کانال‌های جوین اجباری: <b>${toFaDigits(channels.length)} کانال</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⚙️ <b>یکی از گزینه‌های زیر را انتخاب فرمایید:</b>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '📦 مدیریت محصولات (قیمت و موجودی)', callback_data: 'admin_products' }],
      [{ text: '➕ افزودن محصول جدید', callback_data: 'admin_add_prod' }],
      [
        { text: '✏️ تغییر سریع قیمت', callback_data: 'admin_quick_price' },
        { text: '📦 تغییر سریع موجودی', callback_data: 'admin_quick_stock' }
      ],
      [{ text: '👥 لیست کاربران ربات (استارت‌زده‌ها)', callback_data: 'admin_users_list_1' }],
      [{ text: '📢 مدیریت کانال‌های جوین اجباری', callback_data: 'admin_channels' }],
      [
        { text: '👑 مدیریت مدیران (Admins)', callback_data: 'admin_managers' },
        { text: '📝 ویرایش متن استارت', callback_data: 'admin_edit_start_text' }
      ],
      [{ text: '👀 مشاهده ربات از دید مشتری', callback_data: 'user_menu' }]
    ]
  };

  return { text, reply_markup: keyboard };
}

// Admin Users List UI with Pagination
function getAdminUsersListUI(page = 1) {
  const users = db.getAllUsers();
  const perPage = 5;
  const totalUsers = users.length;
  const totalPages = Math.ceil(totalUsers / perPage) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIdx = (currentPage - 1) * perPage;
  const pagedUsers = users.slice(startIdx, startIdx + perPage);

  let text =
    `👥 <b>لیست کاربران ربات (افراد استارت‌زده)</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>تعداد کل کاربران:</b> <b>${toFaDigits(totalUsers)} نفر</b>\n` +
    `📄 <b>صفحه:</b> <b>${toFaDigits(currentPage)} از ${toFaDigits(totalPages)}</b>\n\n`;

  if (totalUsers === 0) {
    text += `<i>هنوز هیچ کاربری ربات را استارت نکرده است.</i>\n`;
  } else {
    pagedUsers.forEach((u, i) => {
      const globalIdx = startIdx + i + 1;
      const name = u.first_name || 'بدون نام';
      const userTag = u.username ? `@${u.username}` : 'ندارد';
      const dateStr = u.joinedAt ? new Date(u.joinedAt).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }) : '--';
      const orders = u.ordersCount || 0;

      text +=
        `${toFaDigits(globalIdx)}. 👤 <b>${name}</b> (${userTag})\n` +
        `   🆔 آیدی عددی: <code>${u.id}</code>\n` +
        `   📅 عضویت: <i>${dateStr}</i>\n` +
        `   🛍 تعداد سفارشات: <b>${toFaDigits(orders)} عدد</b>\n\n`;
    });
  }

  const navButtons = [];
  if (currentPage > 1) {
    navButtons.push({ text: '◀️ صفحه قبلی', callback_data: `admin_users_list_${currentPage - 1}` });
  }
  navButtons.push({ text: '🔄 بروزرسانی', callback_data: `admin_users_list_${currentPage}` });
  if (currentPage < totalPages) {
    navButtons.push({ text: 'صفحه بعدی ▶️', callback_data: `admin_users_list_${currentPage + 1}` });
  }

  const keyboard = [
    navButtons,
    [{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_dashboard' }]
  ];

  return { text, reply_markup: { inline_keyboard: keyboard } };
}

// Admin Managers Management UI
function getAdminManagersUI() {
  const admins = db.getAdmins();

  let text =
    `👑 <b>مدیریت مدیران و ادمین‌های ربات</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `افراد زیر به پنل مدیریت (/admin) دسترسی کامل دارند:\n\n`;

  admins.forEach((id, idx) => {
    const isOwner = id.toString() === '8602316735';
    const tag = isOwner ? '🌟 مدیر ارشد (Owner)' : '👤 ادمین';
    text += `${toFaDigits(idx + 1)}. ${tag}: <code>${id}</code>\n`;
  });

  text += `\n👇 <i>جهت افزودن مدیر جدید یا حذف ادمین‌ها انتخاب کنید:</i>`;

  const buttons = [];
  admins.forEach(id => {
    if (id.toString() !== '8602316735') {
      buttons.push([{ text: `🗑 حذف ادمین: ${id}`, callback_data: `admin_del_manager_${id}` }]);
    }
  });

  buttons.push([{ text: '➕ افزودن مدیر جدید', callback_data: 'admin_add_manager' }]);
  buttons.push([{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_dashboard' }]);

  return { text, reply_markup: { inline_keyboard: buttons } };
}

// Admin Edit Start Text UI
function getAdminEditStartTextUI() {
  const settings = db.getSettings();
  const currentMsg = settings.start_message || 'تنظیم نشده';

  let text =
    `📝 <b>تنظیم و ویرایش متن پیام استارت ربات</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📌 <b>متن فعلی پیام استارت:</b>\n\n` +
    `<blockquote>${currentMsg}</blockquote>\n\n` +
    `💡 <b>متغیرهای هوشمند قابل استفاده در متن:</b>\n` +
    `• <code>{name}</code> : نام کاربر ارسال‌کننده استارت\n` +
    `• <code>{shop_name}</code> : نام فروشگاه (${config.SHOP_NAME})\n\n` +
    `<i>جهت تغییر متن یا بازنشانی از دکمه‌های زیر استفاده کنید:</i>`;

  const buttons = [
    [{ text: '✏️ ارسال و ثبت متن جدید', callback_data: 'admin_set_new_start_text' }],
    [{ text: '🔄 بازنشانی به متن پیش‌فرض سیستم', callback_data: 'admin_reset_start_text' }],
    [{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_dashboard' }]
  ];

  return { text, reply_markup: { inline_keyboard: buttons } };
}

// Admin Channels Management UI
function getAdminChannelsUI() {
  const channels = db.getChannels();

  let text =
    `📢 <b>مدیریت کانال‌های جوین اجباری</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `کاربران برای استفاده از ربات باید حتماً در تمام کانال‌های زیر عضو باشند:\n\n`;

  if (channels.length === 0) {
    text += `<i>در حال حاضر هیچ کانال جوین اجباری ثبت نشده است.</i>\n\n`;
  } else {
    channels.forEach((ch, idx) => {
      text += `${toFaDigits(idx + 1)}. 📢 <b>${ch.title}</b> (@${ch.username})\n`;
    });
    text += `\n`;
  }

  text += `👇 <i>می‌توانید کانال جدید اضافه کنید یا کانال‌های موجود را حذف نمایید:</i>`;

  const buttons = [];
  channels.forEach(ch => {
    buttons.push([
      { text: `🗑 حذف کانال: @${ch.username}`, callback_data: `admin_del_ch_${ch.username}` }
    ]);
  });

  buttons.push([{ text: '➕ افزودن کانال جدید', callback_data: 'admin_add_ch' }]);
  buttons.push([{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_dashboard' }]);

  return { text, reply_markup: { inline_keyboard: buttons } };
}

// Admin Products List
function getAdminProductsList(mode = 'view') {
  const products = db.getAllProducts().filter(p => p.active !== false);

  let title = '📦 <b>لیست محصولات فروشگاه:</b>\n\n';
  if (mode === 'price') title = '✏️ <b>انتخاب محصول برای تغییر قیمت:</b>\n\n';
  if (mode === 'stock') title = '📦 <b>انتخاب محصول برای تغییر موجودی:</b>\n\n';

  let text = title;
  const buttons = [];

  if (products.length === 0) {
    text += 'هیچ محصولی در دیتابیس ثبت نشده است.';
  } else {
    products.forEach((p, idx) => {
      const inStock = p.stock > 0;
      const statusIcon = inStock ? '🟢' : '🔴';
      text += `${toFaDigits(idx + 1)}. ${statusIcon} <b>${p.name}</b>\n`;
      text += `💰 قیمت: <code>${formatPrice(p.price)}</code> | موجودی: <b>${toFaDigits(p.stock)}</b>\n\n`;

      let cb = `admin_prod_view_${p.id}`;
      if (mode === 'price') cb = `admin_edit_price_${p.id}`;
      if (mode === 'stock') cb = `admin_edit_stock_${p.id}`;

      buttons.push([
        { text: `${statusIcon} ${p.name}`, callback_data: cb }
      ]);
    });
  }

  buttons.push([{ text: '➕ افزودن محصول جدید', callback_data: 'admin_add_prod' }]);
  buttons.push([{ text: '🔙 بازگشت به پنل مدیریت', callback_data: 'admin_dashboard' }]);

  return { text, reply_markup: { inline_keyboard: buttons } };
}

// Admin Single Product Manage UI
function getAdminSingleProductManage(product) {
  const inStock = product.stock > 0;
  const statusIcon = inStock ? '🟢' : '🔴';
  const stockText = inStock ? `🟢 موجود (${toFaDigits(product.stock)} عدد)` : '🔴 ناموجود (۰)';

  const text =
    `⚙️ <b>مدیریت محصول: ${product.name}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🆔 کد: <code>${product.id}</code>\n` +
    `💰 قیمت فعلی: <code>${formatPrice(product.price)}</code>\n` +
    `📦 موجودی فعلی: <b>${stockText}</b>\n` +
    `🏷 دسته‌بندی: <b>${product.category}</b>\n\n` +
    `📋 <b>توضیحات:</b>\n` +
    `${product.description}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👇 <b>عملیات مورد نظر را انتخاب فرمایید:</b>`;

  const buttons = [
    [
      { text: '✏️ ویرایش قیمت', callback_data: `admin_edit_price_${product.id}` },
      { text: '📦 ویرایش موجودی', callback_data: `admin_edit_stock_${product.id}` }
    ],
    [
      { text: '🗑 حذف این محصول', callback_data: `admin_delete_prod_${product.id}` }
    ],
    [
      { text: '🔙 بازگشت به لیست محصولات', callback_data: 'admin_products' },
      { text: '🔐 پنل مدیریت', callback_data: 'admin_dashboard' }
    ]
  ];

  return { text, reply_markup: { inline_keyboard: buttons } };
}

// ===================== REQUEST HANDLERS =====================

// Handle Messages
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from ? msg.from.id : chatId;
  const userName = msg.from ? (msg.from.first_name || 'کاربر') : 'کاربر';
  const text = (msg.text || '').trim();

  // Save/Update user in db
  db.saveUser({ id: userId, name: userName, username: msg.from?.username || '' });

  // 1. Check FSM State for Admin inputs
  const userState = db.getState(userId);
  if (userState && isAdmin(userId)) {
    // Awaiting Channel Input
    if (userState.state === 'awaiting_channel_input') {
      let cleanInput = text.replace(/https?:\/\/t\.me\//g, '').replace('@', '').trim();
      if (!cleanInput) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: '❌ لطفاً یوزرنیم یا لینک معتبر ارسال کنید (مثال: <code>@rad_protocol</code>)',
          parse_mode: 'HTML'
        });
        return;
      }

      // Try getChat for title
      let channelTitle = `کانال @${cleanInput}`;
      try {
        const chatInfo = await tgCall('getChat', { chat_id: `@${cleanInput}` });
        if (chatInfo && chatInfo.ok && chatInfo.result.title) {
          channelTitle = chatInfo.result.title;
        }
      } catch (e) {}

      db.addChannel({
        username: cleanInput,
        title: channelTitle,
        link: `https://t.me/${cleanInput}`
      });
      db.clearState(userId);

      await tgCall('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>کانال «${channelTitle}» (@${cleanInput}) با موفقیت به لیست جوین اجباری اضافه شد!</b>`,
        parse_mode: 'HTML',
        reply_markup: getAdminChannelsUI().reply_markup
      });
      return;
    }

    // Awaiting Price
    if (userState.state === 'awaiting_price') {
      const cleanNum = text.replace(/[^0-9]/g, '');
      const price = parseInt(cleanNum, 10);
      if (!price || isNaN(price) || price <= 0) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: '❌ لطفاً فقط عدد قیمت را به تومان وارد کنید (مثال: <code>390000</code>):',
          parse_mode: 'HTML'
        });
        return;
      }
      const prodId = userState.data.productId;
      const updated = db.updateProduct(prodId, { price });
      db.clearState(userId);

      await tgCall('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>قیمت محصول با موفقیت به <code>${formatPrice(price)}</code> تغییر یافت!</b>`,
        parse_mode: 'HTML',
        reply_markup: getAdminSingleProductManage(updated).reply_markup
      });
      return;
    }

    // Awaiting Stock
    if (userState.state === 'awaiting_stock') {
      const cleanNum = text.replace(/[^0-9]/g, '');
      const stock = parseInt(cleanNum, 10);
      if (isNaN(stock) || stock < 0) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: '❌ لطفاً یک عدد صحیح برای موجودی وارد کنید (مثال: <code>15</code> یا <code>0</code>):',
          parse_mode: 'HTML'
        });
        return;
      }
      const prodId = userState.data.productId;
      const updated = db.updateProduct(prodId, { stock });
      db.clearState(userId);

      const statusText = stock > 0 ? `🟢 موجود (${toFaDigits(stock)} عدد)` : '🔴 ناموجود (۰)';
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>موجودی محصول با موفقیت به ${statusText} تغییر یافت!</b>`,
        parse_mode: 'HTML',
        reply_markup: getAdminSingleProductManage(updated).reply_markup
      });
      return;
    }

    // Add Product Wizard Steps
    if (userState.state === 'add_prod_name') {
      db.setState(userId, 'add_prod_price', { name: text });
      await tgCall('sendMessage', {
        chat_id: chatId,
        text:
          `نام محصول: <b>${text}</b>\n\n` +
          `📌 <b>مرحله ۲ از ۴:</b> لطفاً <b>قیمت محصول</b> را به تومان وارد کنید:\n` +
          `<i>(فقط عدد ارسال کنید، مثلاً: <code>390000</code>)</i>`,
        parse_mode: 'HTML'
      });
      return;
    }

    if (userState.state === 'add_prod_price') {
      const cleanNum = text.replace(/[^0-9]/g, '');
      const price = parseInt(cleanNum, 10);
      if (!price || isNaN(price) || price <= 0) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: '❌ لطفاً فقط عدد قیمت را به تومان وارد کنید:\n(مثال: <code>390000</code>)',
          parse_mode: 'HTML'
        });
        return;
      }
      db.setState(userId, 'add_prod_stock', { ...userState.data, price });
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: `💰 قیمت: <code>${formatPrice(price)}</code>\n\n📌 <b>مرحله ۳ از ۴:</b> تعداد موجودی اولیه را وارد کنید:\n(مثال: <code>10</code> یا <code>0</code>)`,
        parse_mode: 'HTML'
      });
      return;
    }

    if (userState.state === 'add_prod_stock') {
      const cleanNum = text.replace(/[^0-9]/g, '');
      const stock = parseInt(cleanNum, 10);
      if (isNaN(stock) || stock < 0) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: '❌ لطفاً یک عدد صحیح برای موجودی وارد کنید:\n(مثال: <code>5</code>)',
          parse_mode: 'HTML'
        });
        return;
      }
      db.setState(userId, 'add_prod_desc', { ...userState.data, stock });
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: `📦 موجودی: <b>${toFaDigits(stock)} عدد</b>\n\n📌 <b>مرحله ۴ از ۴:</b> توضیحات و ویژگی‌های اکانت را وارد کنید:\n(می‌توانید چند خط توضیح بنویسید)`,
        parse_mode: 'HTML'
      });
      return;
    }

    if (userState.state === 'add_prod_desc') {
      const newProd = db.addProduct({
        name: userState.data.name,
        price: userState.data.price,
        stock: userState.data.stock,
        description: text,
        category: 'اکانت جمینای'
      });
      db.clearState(userId);

      await tgCall('sendMessage', {
        chat_id: chatId,
        text:
          `🎉 <b>محصول جدید با موفقیت اضافه شد!</b>\n\n` +
          `🏷 نام: <b>${newProd.name}</b>\n` +
          `💰 قیمت: <code>${formatPrice(newProd.price)}</code>\n` +
          `📦 موجودی: <b>${toFaDigits(newProd.stock)} عدد</b>\n\n` +
          `همین حالا در کاتالوگ فروشگاه با آیکون شیشه‌ای فعال شد.`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📦 مشاهده محصول در پنل', callback_data: `admin_prod_view_${newProd.id}` }],
            [{ text: '🔐 پنل مدیریت', callback_data: 'admin_dashboard' }]
          ]
        }
      });
      return;
    }

    // Awaiting New Admin ID
    if (userState.state === 'awaiting_new_admin_id') {
      let targetId = null;
      if (msg.forward_from) {
        targetId = msg.forward_from.id;
      } else {
        const clean = text.replace(/[^0-9]/g, '');
        if (clean) targetId = parseInt(clean, 10);
      }

      if (!targetId || isNaN(targetId)) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: '❌ لطفاً یک آیدی عددی معتبر ارسال کنید یا پیامی از کاربر را اینجا فوروارد کنید:',
          parse_mode: 'HTML'
        });
        return;
      }

      const added = db.addAdmin(targetId);
      db.clearState(userId);

      if (added) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: `✅ <b>کاربر با آیدی <code>${targetId}</code> با موفقیت به عنوان ادمین ثبت شد!</b>`,
          parse_mode: 'HTML',
          reply_markup: getAdminManagersUI().reply_markup
        });
      } else {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: `⚠️ کاربر با آیدی <code>${targetId}</code> قبلاً در لیست ادمین‌ها ثبت شده بود.`,
          parse_mode: 'HTML',
          reply_markup: getAdminManagersUI().reply_markup
        });
      }
      return;
    }

    // Awaiting New Start Text
    if (userState.state === 'awaiting_new_start_text') {
      if (!text || text.length < 5) {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: '❌ متن ارسال شده خیلی کوتاه است. لطفاً متن کامل استارت را وارد کنید:',
          parse_mode: 'HTML'
        });
        return;
      }

      db.updateSettings({ start_message: text });
      db.clearState(userId);

      await tgCall('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>متن پیام استارت با موفقیت ذخیره شد!</b>\n\n📌 <b>پیش‌نمایش:</b>\n<blockquote>${text}</blockquote>`,
        parse_mode: 'HTML',
        reply_markup: getAdminEditStartTextUI().reply_markup
      });
      return;
    }
  }

  // 2. Admin command
  if (text === '/admin') {
    if (!isAdmin(userId)) {
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: '⛔️ شما دسترسی لازم برای ورود به پنل ادمین را ندارید.'
      });
      return;
    }
    const adminUI = getAdminDashboard();
    await tgCall('sendMessage', {
      chat_id: chatId,
      text: adminUI.text,
      parse_mode: 'HTML',
      reply_markup: adminUI.reply_markup
    });
    return;
  }

  // 3. Channel Membership Check for regular users
  const membership = await checkUserMembership(userId);
  if (!membership.ok) {
    const lockUI = getForceJoinLockUI(membership.missing, userName);
    await tgCall('sendMessage', {
      chat_id: chatId,
      text: lockUI.text,
      parse_mode: 'HTML',
      reply_markup: lockUI.reply_markup
    });
    return;
  }

  // 4. Default /start or Main Menu
  const ui = getCustomerMainMenu(userId, userName);
  await tgCall('sendMessage', {
    chat_id: chatId,
    text: ui.text,
    parse_mode: 'HTML',
    reply_markup: ui.reply_markup
  });
}

// Handle Callback Queries
async function handleCallbackQuery(cq) {
  const cqId = cq.id;
  const chatId = cq.message.chat.id;
  const userId = cq.from ? cq.from.id : chatId;
  const userName = cq.from ? cq.from.first_name : 'کاربر';
  const messageId = cq.message.message_id;
  const data = cq.data;

  // Immediately dismiss button loading spinner on general navigation buttons
  const isAlertAction = data === 'verify_join' || data.includes('alert_') || data.startsWith('admin_del_');
  if (!isAlertAction) {
    tgCall('answerCallbackQuery', { callback_query_id: cqId }).catch(() => {});
  }

  // 0. Verify Join Button
  if (data === 'verify_join') {
    const membership = await checkUserMembership(userId, true);
    if (!membership.ok) {
      await tgCall('answerCallbackQuery', {
        callback_query_id: cqId,
        text: '❌ شما هنوز در تمامی کانال‌های مشخص شده عضو نشده‌اید!',
        show_alert: true
      });
      return;
    }

    await tgCall('answerCallbackQuery', {
      callback_query_id: cqId,
      text: '✅ عضویت شما تایید شد! خوش آمدید.',
      show_alert: false
    });

    const ui = getCustomerMainMenu(userId, userName);
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    return;
  }

  // Force-Join Check for non-admin callback navigation
  if (!isAdmin(userId)) {
    const membership = await checkUserMembership(userId);
    if (!membership.ok) {
      const lockUI = getForceJoinLockUI(membership.missing, userName);
      await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: lockUI.text,
        parse_mode: 'HTML',
        reply_markup: lockUI.reply_markup
      });
      await tgCall('answerCallbackQuery', {
        callback_query_id: cqId,
        text: '🔒 لطفاً ابتدا در کانال‌های زیر عضو شوید.',
        show_alert: true
      });
      return;
    }
  }

  // 1. Customer Navigation
  if (data === 'user_menu') {
    const ui = getCustomerMainMenu(userId, userName);
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data === 'user_catalog') {
    const ui = getCustomerCatalog();
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data === 'alert_stock_empty') {
    await tgCall('answerCallbackQuery', {
      callback_query_id: cqId,
      text: '❌ متاسفانه موجودی این اکانت به اتمام رسیده است و امکان ثبت سفارش وجود ندارد.',
      show_alert: true
    });
    return;
  }

  if (data.startsWith('view_prod_')) {
    const prodId = data.replace('view_prod_', '');
    const prod = db.getProduct(prodId);
    if (!prod) {
      await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: '❌ محصول یافت نشد!', show_alert: true });
      return;
    }
    const ui = getCustomerProductDetail(prod);
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data.startsWith('buy_prod_')) {
    const prodId = data.replace('buy_prod_', '');
    const prod = db.getProduct(prodId);
    if (!prod || prod.stock <= 0) {
      await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: '❌ متاسفانه موجودی این محصول به اتمام رسیده است.', show_alert: true });
      return;
    }
    const order = db.createOrder(userId, prodId);
    const ui = getCustomerCheckout(prod, order);
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: '✅ پیش‌فاکتور سفارش ایجاد شد!' });
    return;
  }

  if (data === 'user_guide') {
    const text =
      `💳 <b>راهنمای خرید و تحویل اکانت‌های جمینای:</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `۱. از بخش کاتالوگ، اکانت مورد نظر را انتخاب و دکمه خرید را بزنید.\n` +
      `۲. مبلغ را به شماره کارت داده شده واریز کرده و تصویر فیش را به همراه کد پیگیری برای پشتیبانی بفرستید.\n` +
      `۳. تیم پشتیبانی مشخصات ورود یا لایسنس را در کمتر از ۱۰ الی ۱۵ دقیقه برای شما ارسال می‌کند.\n\n` +
      `🛡 <b>گارانتی و تضمین:</b>\n` +
      `تمامی اکانت‌ها قانونی و دارای گارانتی تعویض در طول دوره اشتراک هستند.`;

    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛍 رفتن به کاتالوگ محصولات', callback_data: 'user_catalog' }],
          [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'user_menu' }]
        ]
      }
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data === 'user_orders') {
    const orders = db.getUserOrders(userId);
    let text = '📦 <b>لیست سفارشات شما:</b>\n\n';

    if (orders.length === 0) {
      text += 'شما تا کنون سفارشی در این ربات ثبت نکرده‌اید.';
    } else {
      orders.forEach((o, i) => {
        text += `${toFaDigits(i + 1)}. کد: <code>${o.orderId}</code>\n`;
        text += `محصول: <b>${o.productName}</b>\n`;
        text += `مبلغ: ${formatPrice(o.price)}\n`;
        text += `وضعیت: ${o.status === 'pending_payment' ? '⏳ در انتظار تایید فیش' : '✅ تکمیل شده'}\n\n`;
      });
    }

    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'user_menu' }]]
      }
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  // 2. Admin Actions (Protected)
  if (!isAdmin(userId)) {
    await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: '⛔️ دسترسی غیرمجاز!', show_alert: true });
    return;
  }

  if (data === 'admin_dashboard') {
    const ui = getAdminDashboard();
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  // Channel Management Callbacks
  if (data === 'admin_channels') {
    const ui = getAdminChannelsUI();
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data.startsWith('admin_del_ch_')) {
    const username = data.replace('admin_del_ch_', '');
    db.removeChannel(username);
    await tgCall('answerCallbackQuery', {
      callback_query_id: cqId,
      text: `🗑 کانال @${username} با موفقیت حذف شد.`,
      show_alert: true
    });
    const ui = getAdminChannelsUI();
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    return;
  }

  if (data === 'admin_add_ch') {
    db.setState(userId, 'awaiting_channel_input', {});
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `📢 <b>افزودن کانال جدید به لیست جوین اجباری</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `لطفاً آیدی، یوزرنیم یا لینک کانال مورد نظر را ارسال فرمایید:\n\n` +
        `<i>مثال:</i> <code>@rad_protocol</code> یا <code>https://t.me/rad_protocol</code>\n\n` +
        `⚠️ <i>توجه:</i> حتماً ربات باید در کانال اضافه شده باشد.`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: 'admin_channels' }]]
      }
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data === 'admin_products') {
    const ui = getAdminProductsList('view');
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data === 'admin_quick_price') {
    const ui = getAdminProductsList('price');
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data === 'admin_quick_stock') {
    const ui = getAdminProductsList('stock');
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data.startsWith('admin_prod_view_')) {
    const prodId = data.replace('admin_prod_view_', '');
    const prod = db.getProduct(prodId);
    if (!prod) {
      await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: '❌ محصول یافت نشد!', show_alert: true });
      return;
    }
    const ui = getAdminSingleProductManage(prod);
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  // Edit Price Action
  if (data.startsWith('admin_edit_price_')) {
    const prodId = data.replace('admin_edit_price_', '');
    const prod = db.getProduct(prodId);
    if (!prod) {
      await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: '❌ محصول یافت نشد!' });
      return;
    }
    db.setState(userId, 'awaiting_price', { productId: prodId });
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `✏️ <b>تغییر قیمت محصول: ${prod.name}</b>\n\n` +
        `قیمت فعلی: <code>${formatPrice(prod.price)}</code>\n\n` +
        `👇 <b>لطفاً قیمت جدید را به تومان (فقط عدد) ارسال کنید:</b>\n` +
        `<i>(مثال: <code>350000</code>)</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: `admin_prod_view_${prodId}` }]]
      }
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  // Edit Stock Action
  if (data.startsWith('admin_edit_stock_')) {
    const prodId = data.replace('admin_edit_stock_', '');
    const prod = db.getProduct(prodId);
    if (!prod) {
      await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: '❌ محصول یافت نشد!' });
      return;
    }
    db.setState(userId, 'awaiting_stock', { productId: prodId });
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `📦 <b>تغییر موجودی محصول: ${prod.name}</b>\n\n` +
        `موجودی فعلی: <b>${toFaDigits(prod.stock)} عدد</b>\n\n` +
        `👇 <b>لطفاً تعداد موجودی جدید را وارد کنید:</b>\n` +
        `<i>(مثال: <code>20</code> یا <code>0</code> برای ناموجود کردن)</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: `admin_prod_view_${prodId}` }]]
      }
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  // Delete Product
  if (data.startsWith('admin_delete_prod_')) {
    const prodId = data.replace('admin_delete_prod_', '');
    db.deleteProduct(prodId);
    await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: '✅ محصول با موفقیت حذف شد.', show_alert: true });
    const ui = getAdminProductsList('view');
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    return;
  }

  // Add Product Wizard Start
  if (data === 'admin_add_prod') {
    db.setState(userId, 'add_prod_name', {});
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `➕ <b>افزودن محصول جدید به فروشگاه</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📌 <b>مرحله ۱ از ۴:</b> لطفاً <b>نام محصول</b> را ارسال فرمایید:\n` +
        `<i>(مثال: اکانت ۳ ماهه Gemini Advanced اختصاصی)</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: 'admin_dashboard' }]]
      }
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  // Admin Users List Callback
  if (data.startsWith('admin_users_list_')) {
    const pageNum = parseInt(data.replace('admin_users_list_', ''), 10) || 1;
    const ui = getAdminUsersListUI(pageNum);
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  // Manager (Admin) Management Callbacks
  if (data === 'admin_managers') {
    const ui = getAdminManagersUI();
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data === 'admin_add_manager') {
    db.setState(userId, 'awaiting_new_admin_id', {});
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `👑 <b>افزودن مدیر جدید به ربات</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `لطفاً <b>آیدی عددی</b> کاربر مورد نظر را بفرستید یا پیامی از ایشان را داخل همین چت فوروارد (Forward) کنید:\n\n` +
        `<i>(آیدی عددی را می‌توانید از ربات‌هایی مثل @userinfobot دریافت کنید)</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: 'admin_managers' }]]
      }
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data.startsWith('admin_del_manager_')) {
    const targetId = data.replace('admin_del_manager_', '');
    if (targetId === '8602316735') {
      await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: '⛔️ حذف مدیر اصلی مجاز نیست!', show_alert: true });
      return;
    }
    db.removeAdmin(targetId);
    await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: `✅ ادمین ${targetId} حذف شد.`, show_alert: true });
    const ui = getAdminManagersUI();
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    return;
  }

  // Start Text Management Callbacks
  if (data === 'admin_edit_start_text') {
    const ui = getAdminEditStartTextUI();
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data === 'admin_set_new_start_text') {
    db.setState(userId, 'awaiting_new_start_text', {});
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text:
        `📝 <b>تنظیم متن جدید پیام استارت</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `متن مورد نظر خود را ارسال کنید. می‌توانید از تگ‌های HTML (مانند <code>&lt;b&gt;</code>, <code>&lt;code&gt;</code>) استفاده کنید.\n\n` +
        `📌 <i>کلمات کلیدی قابل استفاده:</i>\n` +
        `• <code>{name}</code> : نام کاربر ارسال‌کننده استارت\n` +
        `• <code>{shop_name}</code> : نام فروشگاه\n\n` +
        `👇 <i>متن را تایپ و ارسال کنید:</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: 'admin_edit_start_text' }]]
      }
    });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId });
    return;
  }

  if (data === 'admin_reset_start_text') {
    const defaultMsg = `سلام <b>{name}</b> عزیز! 💎\n\nبه <b>{shop_name}</b> خوش آمدید.\nتمامی اشتراک‌ها و اکانت‌های هوش مصنوعی گوگل (Gemini Advanced & Ultra) با گارانتی تعویض و تحویل سریع ارائه می‌شوند.\n\n👇 <b>لطفاً از منوی زیر گزینه مورد نظرتان را انتخاب کنید:</b>`;
    db.updateSettings({ start_message: defaultMsg });
    await tgCall('answerCallbackQuery', { callback_query_id: cqId, text: '✅ متن استارت به حالت پیش‌فرض بازگشت.', show_alert: true });
    const ui = getAdminEditStartTextUI();
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: ui.text,
      parse_mode: 'HTML',
      reply_markup: ui.reply_markup
    });
    return;
  }
}

// Long Polling Loop
let lastUpdateId = 0;
let isPolling = false;

async function pollUpdates() {
  if (isPolling) return;
  isPolling = true;

  try {
    const res = await tgCall('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 25,
      allowed_updates: ['message', 'callback_query']
    });

    if (res && res.ok && Array.isArray(res.result)) {
      for (const update of res.result) {
        lastUpdateId = update.update_id;
        if (update.message) {
          await handleMessage(update.message);
        } else if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }
      }
    }
  } catch (err) {
    console.error('Polling error:', err.message);
  } finally {
    isPolling = false;
    setTimeout(pollUpdates, 500);
  }
}

// ===================== HTTP SERVER & RENDER SUPPORT =====================
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check & WebApp serving
  if (req.url === '/' || req.url === '/health') {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'gemini-shop-bot',
      bot: '@theKiANshop_bot',
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Webhook Endpoint
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        if (body) {
          const update = JSON.parse(body);
          if (update.message) {
            await handleMessage(update.message);
          } else if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
          }
        }
      } catch (err) {
        console.error('Webhook error:', err.message);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP Server running on port ${PORT}`);
});

// Self-ping Keep-Alive on Render to stay online 24/7
const pingTarget = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
if (pingTarget) {
  console.log(`🔄 Self-ping keep-alive activated for: ${pingTarget}`);
  setInterval(() => {
    https.get(`${pingTarget}/health`, () => {}).on('error', () => {});
  }, 10 * 60 * 1000);
}

// Start bot
console.log('🤖 Gemini Shop Bot initialized.');
if (!BOT_TOKEN) {
  console.log('⚠️ BOT_TOKEN is empty. Set BOT_TOKEN in config.js or pass via environment variable.');
} else {
  if (WEBHOOK_URL) {
    const webhookEndpoint = `${WEBHOOK_URL.replace(/\/$/, '')}/webhook`;
    console.log(`🚀 Setting webhook to: ${webhookEndpoint}`);
    tgCall('setWebhook', { url: webhookEndpoint, drop_pending_updates: true }).then(res => {
      console.log('Webhook result:', res);
    });
  } else {
    console.log('🚀 Starting polling loop with token:', BOT_TOKEN.slice(0, 10) + '...');
    pollUpdates();
  }
}

module.exports = {
  handleMessage,
  handleCallbackQuery,
  tgCall,
  db
};
