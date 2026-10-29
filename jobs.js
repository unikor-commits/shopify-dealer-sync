require('dotenv').config();
const shopify = require('./shopify');
const dealer = require('./dealer');
const store = require('./store');

// ---------- 1) New order -> dealer ----------
async function forwardOrder(order, { retry = false } = {}) {
  const id = String(order.id);
  const existing = store.get(id);
  if (existing && !(retry && existing.status === 'failed')) {
    console.log(`Order ${order.name} already handled, skipping`);
    return;
  }

  const items = (order.line_items || [])
    .filter((li) => li.sku) // only items that have a SKU from the dealer
    .map((li) => ({ sku: li.sku, quantity: li.quantity, title: li.title, variant: li.variant_title }));

  if (!items.length) {
    console.log(`Order ${order.name} has no dealer items (no SKUs), skipping`);
    store.upsert(id, { name: order.name, status: 'skipped_no_sku' });
    return;
  }

  const a = order.shipping_address || {};
  let dealerOrderId;
  try {
    dealerOrderId = await dealer.createOrder({
      id,
      name: order.name,
      email: order.email,
      phone: a.phone || order.phone,
      customerName: `${a.first_name || ''} ${a.last_name || ''}`.trim(),
      address: {
        line1: a.address1,
        line2: a.address2,
        city: a.city,
        state: a.province_code,
        zip: a.zip,
        country: a.country_code,
      },
      items,
    });
  } catch (err) {
    // Keep the order so it can be retried later
    store.upsert(id, { name: order.name, status: 'failed', error: err.message, order });
    throw err;
  }

  store.upsert(id, {
    name: order.name,
    dealerOrderId,
    status: 'sent_to_dealer',
    sentAt: new Date().toISOString(),
    error: null,
    order: null,
  });
  console.log(`Order ${order.name} sent to dealer (dealer ID: ${dealerOrderId})`);
}

// ---------- 2) Dealer stock -> Shopify ----------
async function syncStock() {
  const stock = await dealer.getStock();
  const updates = [];
  for (const row of stock) {
    const inventoryItemId = await shopify.getInventoryItemIdBySku(row.sku);
    if (inventoryItemId) updates.push({ inventoryItemId, quantity: row.quantity });
  }
  if (updates.length) await shopify.setInventory(updates);
  console.log(`Stock sync done: ${updates.length} of ${stock.length} dealer items matched your store`);
}

// ---------- 3) Dealer tracking -> Shopify -> customer ----------
async function syncTracking() {
  const pending = store.pendingTracking();
  for (const o of pending) {
    try {
      const tracking = await dealer.getTracking(o.dealerOrderId);
      if (!tracking) continue;
      await shopify.fulfillOrderWithTracking(o.shopifyOrderId, tracking);
      store.upsert(o.shopifyOrderId, { status: 'fulfilled', tracking: tracking.number });
      console.log(`Order ${o.name} marked shipped, tracking ${tracking.number} sent to customer`);
    } catch (err) {
      console.error(`Tracking update failed for ${o.name}:`, err.message);
    }
  }
  console.log(`Tracking check done: ${pending.length} order(s) checked`);
}

// ---------- 4) Retry orders that failed to reach the dealer ----------
async function retryFailed() {
  const failed = store.failedOrders();
  const results = [];
  for (const f of failed) {
    if (!f.order) continue;
    try {
      await forwardOrder(f.order, { retry: true });
      results.push({ order: f.name, result: 'sent' });
    } catch (err) {
      results.push({ order: f.name, result: `still failing: ${err.message}` });
    }
  }
  return { tried: results.length, results };
}

module.exports = { forwardOrder, syncStock, syncTracking, retryFailed };
