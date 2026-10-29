// ============================================================
//  DEALER CONNECTION — the only file you need to adjust.
//  Every dealer's API is a little different. Ask your dealer for
//  their API documentation, then update the URLs and field names
//  marked with "CHANGE ME" so they match.
// ============================================================

const BASE = process.env.DEALER_API_URL;
const KEY = process.env.DEALER_API_KEY;

async function dealerRequest(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`, // CHANGE ME if your dealer uses a different header (e.g. 'X-API-Key')
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Dealer API ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// 1) Send a new order to the dealer. Returns the dealer's order ID.
async function createOrder(order) {
  const payload = {
    // CHANGE ME: match these names to your dealer's order format
    reference: order.name, // e.g. "#1001"
    customer: {
      name: order.customerName,
      email: order.email,
      phone: order.phone,
    },
    shipping_address: order.address,
    items: order.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    blind_shipping: true, // ask dealer to ship without their branding, if supported
  };

  if (process.env.DRY_RUN === 'true') {
    console.log('[DRY RUN] Would send to dealer:', JSON.stringify(payload, null, 2));
    return `dry-run-${order.id}`;
  }

  const data = await dealerRequest('POST', '/orders', payload); // CHANGE ME: dealer's "create order" path
  return String(data.id || data.order_id); // CHANGE ME: where the dealer returns its order ID
}

// 2) Get the dealer's current stock. Returns [{ sku, quantity }]
async function getStock() {
  const data = await dealerRequest('GET', '/inventory'); // CHANGE ME: dealer's stock path
  const rows = data.items || data; // CHANGE ME: where the list lives in their response
  return rows.map((r) => ({ sku: String(r.sku), quantity: Number(r.quantity ?? r.stock ?? 0) }));
}

// 3) Check an order for tracking. Returns { number, carrier, url } or null if not shipped yet.
async function getTracking(dealerOrderId) {
  if (String(dealerOrderId).startsWith('dry-run-')) return null;
  const data = await dealerRequest('GET', `/orders/${encodeURIComponent(dealerOrderId)}`); // CHANGE ME
  const number = data.tracking_number; // CHANGE ME
  if (!number) return null;
  return { number, carrier: data.carrier, url: data.tracking_url }; // CHANGE ME
}

module.exports = { createOrder, getStock, getTracking };
