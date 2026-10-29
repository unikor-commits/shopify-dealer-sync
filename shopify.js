// Talks to the Shopify Admin GraphQL API.
// Uses the client credentials grant (Dev Dashboard app installed on your own store).

const STORE = process.env.SHOPIFY_STORE;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-10';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  // Reuse the token until 5 minutes before it expires
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) return cachedToken;

  const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Shopify token request failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  cachedToken = data.access_token;
  // If Shopify doesn't say when it expires, refresh it hourly to be safe
  tokenExpiresAt = Date.now() + (data.expires_in ? data.expires_in * 1000 : 60 * 60 * 1000);
  return cachedToken;
}

async function graphql(query, variables = {}) {
  const token = await getAccessToken();
  const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// ---------- Stock ----------

let cachedLocationId = process.env.SHOPIFY_LOCATION_ID || null;

async function getLocationId() {
  if (cachedLocationId) return cachedLocationId;
  const data = await graphql(`{ locations(first: 1) { nodes { id name } } }`);
  cachedLocationId = data.locations.nodes[0]?.id;
  if (!cachedLocationId) throw new Error('No Shopify location found');
  return cachedLocationId;
}

async function getInventoryItemIdBySku(sku) {
  const data = await graphql(
    `query ($q: String!) {
      productVariants(first: 1, query: $q) { nodes { id sku inventoryItem { id } } }
    }`,
    { q: `sku:"${sku.replace(/"/g, '')}"` }
  );
  const variant = data.productVariants.nodes.find((v) => v.sku === sku);
  return variant ? variant.inventoryItem.id : null;
}

// quantities: [{ inventoryItemId, quantity }]
async function setInventory(quantities) {
  const locationId = await getLocationId();
  // Send in batches so one request never gets too big
  for (let i = 0; i < quantities.length; i += 100) {
    const batch = quantities.slice(i, i + 100);
    const data = await graphql(
      `mutation ($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { field message } }
      }`,
      {
        input: {
          name: 'available',
          reason: 'correction',
          ignoreCompareQuantity: true,
          quantities: batch.map((q) => ({
            inventoryItemId: q.inventoryItemId,
            locationId,
            quantity: q.quantity,
          })),
        },
      }
    );
    const errors = data.inventorySetQuantities.userErrors;
    if (errors.length) console.error('Stock update problems:', errors);
  }
}

// ---------- Tracking / fulfillment ----------

async function fulfillOrderWithTracking(shopifyOrderId, tracking) {
  const orderGid = `gid://shopify/Order/${shopifyOrderId}`;
  const data = await graphql(
    `query ($id: ID!) {
      order(id: $id) { name fulfillmentOrders(first: 10) { nodes { id status } } }
    }`,
    { id: orderGid }
  );
  if (!data.order) throw new Error(`Order ${shopifyOrderId} not found in Shopify`);

  const openOrders = data.order.fulfillmentOrders.nodes.filter((fo) =>
    ['OPEN', 'IN_PROGRESS'].includes(fo.status)
  );
  if (!openOrders.length) return { alreadyFulfilled: true };

  const result = await graphql(
    `mutation ($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: openOrders.map((fo) => ({ fulfillmentOrderId: fo.id })),
        trackingInfo: {
          number: tracking.number,
          company: tracking.carrier || undefined,
          url: tracking.url || undefined,
        },
        notifyCustomer: true, // Shopify emails the customer their tracking
      },
    }
  );
  const errors = result.fulfillmentCreate.userErrors;
  if (errors.length) throw new Error(`Fulfillment failed: ${JSON.stringify(errors)}`);
  return { alreadyFulfilled: false, orderName: data.order.name };
}

module.exports = { graphql, getInventoryItemIdBySku, setInventory, fulfillOrderWithTracking };
