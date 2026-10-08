// Load local .env safely if present
try {
  const localEnv = require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8');
  localEnv.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2 && parts[0].trim()) {
      process.env[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  });
} catch (e) {}

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE',
  ADMIN_IDS: [
    8602316735,
    8678906046,
    7746536015
  ],
  CHANNEL_USERNAME: '@rad_protocol',
  SUPPORT_USERNAME: '@radprotocoll',
  // On Render or Cloud, no proxy is needed (direct connection to Telegram API)
  PROXY_URL: (process.env.RENDER || process.env.NODE_ENV === 'production') ? '' : (process.env.TELEGRAM_PROXY || 'http://127.0.0.1:20808'),
  SHOP_NAME: 'فروشگاه تخصصی اکانت‌های جمینای | Gemini Store',
  CARD_NUMBER: '۶۰۳۷-۹۹۷۰-۰۰۰۰-۰۰۰۰',
  CARD_HOLDER: 'مدیر فروشگاه'
};
