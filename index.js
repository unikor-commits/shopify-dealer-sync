require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { forwardOrder, syncStock, syncTracking } = require('./jobs');
const agent = require('./agent');
const { dailySummary, watchForProblems } = require('./monitor');

const app = express();
const aiEnabled = Boolean(process.env.ANTHROPIC_API_KEY);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Check that a webhook really came from Shopify (signed with your client secret)
function isFromShopify(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET)
    .update(req.body)
    .digest('base64');
  return safeEqual(digest, hmac);
}

// Shopify calls this every time a customer places an order
app.post('/webhooks/orders-create', express.raw({ type: 'application/json' }), (req, res) => {
  if (!isFromShopify(req)) return res.status(401).send('Invalid signature');

  // Reply fast so Shopify doesn't retry, then do the work
  res.status(200).send('ok');
  const order = JSON.parse(req.body.toString('utf8'));
  forwardOrder(order).catch((err) => console.error(`Could not send order ${order.name} to dealer:`, err.message));
});

// ---------- AI chat page ----------
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'chat.html')));

app.post('/api/chat', express.json({ limit: '200kb' }), async (req, res) => {
  if (!aiEnabled) return res.status(503).json({ error: 'AI agent is off: add ANTHROPIC_API_KEY' });
  if (!process.env.ADMIN_PASSWORD || !safeEqual(req.get('x-admin-password') || '', process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const messages = Array.isArray(req.body.messages) ? req.body.messages.slice(-20) : [];
  const clean = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') return res.status(400).json({ error: 'No question' });
  try {
    res.json({ reply: await agent.ask(clean) });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'The assistant hit an error. Check the server logs.' });
  }
});

app.get('/', (req, res) => res.send('Shopify dealer sync is running'));

// ---------- Schedules ----------
const tz = process.env.TIMEZONE || 'America/Chicago';

// Stock + tracking sync (default: every 30 minutes)
const schedule = process.env.SYNC_SCHEDULE || '*/30 * * * *';
cron.schedule(schedule, async () => {
  try { await syncStock(); } catch (err) { console.error('Stock sync failed:', err.message); }
  try { await syncTracking(); } catch (err) { console.error('Tracking sync failed:', err.message); }
}, { timezone: tz });

if (aiEnabled) {
  // Problem watcher (default: every hour, at :15)
  cron.schedule(process.env.WATCH_SCHEDULE || '15 * * * *', () => {
    watchForProblems().catch((err) => console.error('Problem watcher failed:', err.message));
  }, { timezone: tz });

  // Daily summary (default: 8:00 AM)
  cron.schedule(process.env.SUMMARY_SCHEDULE || '0 8 * * *', () => {
    dailySummary().catch((err) => console.error('Daily summary failed:', err.message));
  }, { timezone: tz });
}

// ---------- Sign up for new-order notifications from Shopify ----------
const { graphql } = require('./shopify');

async function registerOrderWebhook() {
  const base = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!base) return console.log('Webhook not registered: set APP_URL to your app address');
  const uri = `${base}/webhooks/orders-create`;

  const existing = await graphql(`{
    webhookSubscriptions(first: 50, topics: [ORDERS_CREATE]) { nodes { id uri } }
  }`);
  if (existing.webhookSubscriptions.nodes.some((w) => w.uri === uri)) {
    return console.log(`Order webhook already set up: ${uri}`);
  }

  const result = await graphql(
    `mutation ($uri: String!) {
      webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { uri: $uri }) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }`,
    { uri }
  );
  const errors = result.webhookSubscriptionCreate.userErrors;
  if (errors.length) throw new Error(JSON.stringify(errors));
  console.log(`Order webhook set up: ${uri}`);
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  if (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) {
    registerOrderWebhook().catch((err) => console.error('Could not set up order webhook:', err.message));
  }
  console.log(`Running on port ${port}. Sync schedule: ${schedule}`);
  console.log(aiEnabled ? 'AI agent: ON (chat at /chat, hourly watcher, daily summary)' : 'AI agent: OFF (no ANTHROPIC_API_KEY)');
  if (process.env.DRY_RUN === 'true') console.log('DRY RUN is on: orders will NOT be sent to the dealer');
});
