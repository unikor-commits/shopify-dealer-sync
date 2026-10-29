// Remembers which Shopify orders were sent to the dealer, so orders are
// never sent twice and we know which ones still need tracking.
// Saved as a simple JSON file (data/orders.json).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'orders.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function get(shopifyOrderId) {
  return load()[shopifyOrderId] || null;
}

function upsert(shopifyOrderId, fields) {
  const data = load();
  data[shopifyOrderId] = { ...(data[shopifyOrderId] || {}), ...fields, updatedAt: new Date().toISOString() };
  save(data);
}

function pendingTracking() {
  return Object.entries(load())
    .filter(([, o]) => o.status === 'sent_to_dealer')
    .map(([shopifyOrderId, o]) => ({ shopifyOrderId, ...o }));
}

function failedOrders() {
  return Object.entries(load())
    .filter(([, o]) => o.status === 'failed')
    .map(([shopifyOrderId, o]) => ({ shopifyOrderId, ...o }));
}

function all() {
  return load();
}

module.exports = { get, upsert, pendingTracking, failedOrders, all };
