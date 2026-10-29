// The AI agent: Claude (via the Anthropic API) with tools that can look
// at your store and the sync app. Used for the daily summary, problem
// alerts, and the chat page.

const shopify = require('./shopify');
const store = require('./store');
const jobs = require('./jobs');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const STUCK_DAYS = Number(process.env.STUCK_DAYS || 4);
const LOW_STOCK = Number(process.env.LOW_STOCK_THRESHOLD || 5);

const SYSTEM_PROMPT = `You are the operations assistant for a small online clothing brand that dropships through a dealer.
The store runs on Shopify. A sync app sends new orders to the dealer, copies the dealer's stock into Shopify, and adds tracking when the dealer ships.
Use your tools to look up real data before answering; never guess numbers. Keep answers short, clear and friendly, in plain language for a busy store owner.
Point out anything that needs the owner's attention and say what to do about it.
Only use the retry or sync tools when the owner asks you to, or when you are told you are running as the automatic problem watcher.
Today's date: ${new Date().toISOString().slice(0, 10)}.`;

// ---------- Tools the agent can use ----------

const tools = [
  {
    name: 'get_orders',
    description: 'List Shopify orders from the last N days with totals, payment and shipping status, and items.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'How many days back to look (1-60)' } },
      required: ['days'],
    },
  },
  {
    name: 'get_low_stock',
    description: 'List product variants whose Shopify stock is at or below a threshold.',
    input_schema: {
      type: 'object',
      properties: { threshold: { type: 'integer', description: `Stock level to check against (default ${LOW_STOCK})` } },
    },
  },
  {
    name: 'get_sync_status',
    description: 'Show the sync app\'s order records: orders that failed to reach the dealer, orders waiting for tracking (and which are stuck), and recently shipped ones.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'retry_failed_orders',
    description: 'Try again to send every failed order to the dealer.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'run_stock_sync',
    description: 'Copy the dealer\'s current stock into Shopify right now.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'run_tracking_sync',
    description: 'Check the dealer for new tracking numbers right now and send them to customers.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function getOrders(days) {
  const d = Math.min(Math.max(Number(days) || 1, 1), 60);
  const since = new Date(Date.now() - d * 86400000).toISOString();
  const data = await shopify.graphql(
    `query ($q: String!) {
      orders(first: 100, query: $q, sortKey: CREATED_AT, reverse: true) {
        nodes {
          name createdAt displayFinancialStatus displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 20) { nodes { title variantTitle sku quantity } }
        }
      }
    }`,
    { q: `created_at:>='${since}'` }
  );
  return data.orders.nodes.map((o) => ({
    order: o.name,
    date: o.createdAt,
    total: `${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}`,
    payment: o.displayFinancialStatus,
    shipping: o.displayFulfillmentStatus,
    items: o.lineItems.nodes.map((li) => `${li.quantity} x ${li.title}${li.variantTitle ? ` (${li.variantTitle})` : ''}`),
  }));
}

async function getLowStock(threshold = LOW_STOCK) {
  const data = await shopify.graphql(
    `query ($q: String!) {
      productVariants(first: 100, query: $q) { nodes { displayName sku inventoryQuantity } }
    }`,
    { q: `inventory_quantity:<=${Number(threshold)}` }
  );
  return data.productVariants.nodes.map((v) => ({ item: v.displayName, sku: v.sku, stock: v.inventoryQuantity }));
}

function getSyncStatus() {
  const all = store.all();
  const now = Date.now();
  const failed = [];
  const waiting = [];
  const stuck = [];
  const shipped = [];
  for (const [id, o] of Object.entries(all)) {
    const row = { order: o.name, shopifyOrderId: id, dealerOrderId: o.dealerOrderId, updated: o.updatedAt };
    if (o.status === 'failed') failed.push({ ...row, error: o.error });
    if (o.status === 'sent_to_dealer') {
      const days = (now - new Date(o.sentAt || o.updatedAt).getTime()) / 86400000;
      (days >= STUCK_DAYS ? stuck : waiting).push({ ...row, daysWaiting: Math.floor(days) });
    }
    if (o.status === 'fulfilled') shipped.push({ ...row, tracking: o.tracking });
  }
  return { failed, waitingForTracking: waiting, stuckNoTracking: stuck, stuckAfterDays: STUCK_DAYS, recentlyShipped: shipped.slice(-10) };
}

async function runTool(name, input) {
  switch (name) {
    case 'get_orders': return getOrders(input.days);
    case 'get_low_stock': return getLowStock(input.threshold);
    case 'get_sync_status': return getSyncStatus();
    case 'retry_failed_orders': return jobs.retryFailed();
    case 'run_stock_sync': await jobs.syncStock(); return { done: true };
    case 'run_tracking_sync': await jobs.syncTracking(); return { done: true };
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- Talking to Claude ----------

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM_PROMPT, tools, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  return res.json();
}

// messages: [{ role: 'user' | 'assistant', content: string }]
// Returns the agent's final text answer.
async function ask(messages) {
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));

  for (let step = 0; step < 8; step++) {
    const reply = await callClaude(convo);
    convo.push({ role: 'assistant', content: reply.content });

    if (reply.stop_reason !== 'tool_use') {
      return reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    }

    const results = [];
    for (const block of reply.content.filter((b) => b.type === 'tool_use')) {
      try {
        const out = await runTool(block.name, block.input || {});
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true });
      }
    }
    convo.push({ role: 'user', content: results });
  }
  return 'Sorry, that took too many steps. Try asking a simpler question.';
}

module.exports = { ask, getSyncStatus, getLowStock };
