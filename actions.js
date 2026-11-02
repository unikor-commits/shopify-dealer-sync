// Actions the AI agent can take on your Shopify store.
// Safety: anything that changes what customers see or pay (publishing,
// prices, deleting) only runs when the agent passes confirmed: true,
// which it may do only after you say "yes" in the chat.

const { graphql } = require('./shopify');

function needsConfirm(input, what) {
  if (input.confirmed === true) return null;
  return {
    needs_confirmation: true,
    message: `Not done yet. Ask the owner to confirm: ${what}. Then call again with confirmed: true.`,
  };
}

function userErrors(result) {
  const errors = result && result.userErrors;
  if (errors && errors.length) throw new Error(errors.map((e) => e.message).join('; '));
}

// ---------- Find products ----------
async function findProducts({ search }) {
  const data = await graphql(
    `query ($q: String) {
      products(first: 10, query: $q, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id title status totalInventory
          variants(first: 30) { nodes { id title sku price inventoryQuantity } }
        }
      }
    }`,
    { q: search ? `title:*${String(search).replace(/[*"]/g, '')}*` : null }
  );
  return data.products.nodes;
}

// ---------- Create a product (starts as a DRAFT) ----------
// options example: [{ name: "Size", values: ["S","M","L"] }]
async function createProduct(input) {
  const { title, description, price, sku_prefix, product_type, vendor, options = [], image_url } = input;
  if (!title || price == null) throw new Error('title and price are required');

  const product = {
    title,
    descriptionHtml: description ? `<p>${String(description).replace(/</g, '&lt;')}</p>` : undefined,
    productType: product_type || undefined,
    vendor: vendor || undefined,
    status: 'DRAFT', // never goes live without your OK
  };
  if (options.length) {
    product.productOptions = options.map((o) => ({ name: o.name, values: o.values.map((v) => ({ name: v })) }));
  }
  const media = image_url ? [{ originalSource: image_url, mediaContentType: 'IMAGE' }] : undefined;

  const created = await graphql(
    `mutation ($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product { id title variants(first: 1) { nodes { id } } }
        userErrors { field message }
      }
    }`,
    { product, media }
  );
  userErrors(created.productCreate);
  const p = created.productCreate.product;
  const prefix = (sku_prefix || title).toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 20);

  if (!options.length) {
    // Single product: set price + SKU on its default variant
    const upd = await graphql(
      `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
      }`,
      { productId: p.id, variants: [{ id: p.variants.nodes[0].id, price: String(price), inventoryItem: { sku: prefix, tracked: true } }] }
    );
    userErrors(upd.productVariantsBulkUpdate);
    return { created: p.title, id: p.id, status: 'DRAFT', variants: [{ sku: prefix, price }] };
  }

  // Every combination of the options becomes a variant (e.g. each size)
  let combos = [[]];
  for (const o of options) combos = combos.flatMap((c) => o.values.map((v) => [...c, { optionName: o.name, name: v }]));
  const variants = combos.map((c) => ({
    optionValues: c,
    price: String(price),
    inventoryItem: { sku: `${prefix}-${c.map((x) => x.name).join('-').toUpperCase().replace(/[^A-Z0-9-]+/g, '')}`, tracked: true },
  }));

  const bulk = await graphql(
    `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: REMOVE_STANDALONE_VARIANT) {
        productVariants { title sku price }
        userErrors { field message }
      }
    }`,
    { productId: p.id, variants }
  );
  userErrors(bulk.productVariantsBulkCreate);
  return { created: p.title, id: p.id, status: 'DRAFT', variants: bulk.productVariantsBulkCreate.productVariants };
}

// ---------- Edit title / description ----------
async function updateProductDetails(input) {
  const product = { id: input.product_id };
  if (input.title) product.title = input.title;
  if (input.description) product.descriptionHtml = `<p>${String(input.description).replace(/</g, '&lt;')}</p>`;
  const data = await graphql(
    `mutation ($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { id title } userErrors { field message } }
    }`,
    { product }
  );
  userErrors(data.productUpdate);
  return { updated: data.productUpdate.product.title };
}

// ---------- Publish / hide (needs confirmation) ----------
async function setProductStatus(input) {
  const status = String(input.status).toUpperCase();
  if (!['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(status)) throw new Error('status must be ACTIVE, DRAFT or ARCHIVED');
  if (status === 'ACTIVE') {
    const stop = needsConfirm(input, `make product ${input.product_id} live on the store`);
    if (stop) return stop;
  }
  const data = await graphql(
    `mutation ($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { title status } userErrors { field message } }
    }`,
    { product: { id: input.product_id, status } }
  );
  userErrors(data.productUpdate);
  return data.productUpdate.product;
}

// ---------- Change price (needs confirmation) ----------
async function setPrice(input) {
  const stop = needsConfirm(input, `set the price of all variants of ${input.product_id} to ${input.price}`);
  if (stop) return stop;
  const found = await graphql(
    `query ($id: ID!) { product(id: $id) { title variants(first: 100) { nodes { id } } } }`,
    { id: input.product_id }
  );
  if (!found.product) throw new Error('Product not found');
  const variants = found.product.variants.nodes.map((v) => ({
    id: v.id,
    price: String(input.price),
    compareAtPrice: input.compare_at_price != null ? String(input.compare_at_price) : undefined,
  }));
  const data = await graphql(
    `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`,
    { productId: input.product_id, variants }
  );
  userErrors(data.productVariantsBulkUpdate);
  return { product: found.product.title, newPrice: input.price, variantsChanged: variants.length };
}

// ---------- Delete (needs confirmation) ----------
async function deleteProduct(input) {
  const stop = needsConfirm(input, `permanently delete product ${input.product_id}`);
  if (stop) return stop;
  const data = await graphql(
    `mutation ($input: ProductDeleteInput!) {
      productDelete(input: $input) { deletedProductId userErrors { field message } }
    }`,
    { input: { id: input.product_id } }
  );
  userErrors(data.productDelete);
  return { deleted: data.productDelete.deletedProductId };
}

// ---------- Collections ----------
async function createCollection(input) {
  const data = await graphql(
    `mutation ($input: CollectionInput!) {
      collectionCreate(input: $input) { collection { id title } userErrors { field message } }
    }`,
    { input: { title: input.title, descriptionHtml: input.description ? `<p>${input.description}</p>` : undefined } }
  );
  userErrors(data.collectionCreate);
  const collection = data.collectionCreate.collection;
  if (input.product_ids && input.product_ids.length) await addToCollection({ collection_id: collection.id, product_ids: input.product_ids });
  return collection;
}

async function addToCollection(input) {
  const data = await graphql(
    `mutation ($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) { collection { title } userErrors { field message } }
    }`,
    { id: input.collection_id, productIds: input.product_ids }
  );
  userErrors(data.collectionAddProducts);
  return { collection: data.collectionAddProducts.collection.title, added: input.product_ids.length };
}

// ---------- Tool definitions for Claude ----------
const confirmedProp = {
  confirmed: { type: 'boolean', description: 'Only true after the owner explicitly said yes to this exact change in the chat.' },
};

const actionTools = [
  {
    name: 'find_products',
    description: 'Search the store\'s products by title (or list the most recent ones). Returns ids, status, variants, SKUs, prices and stock.',
    input_schema: { type: 'object', properties: { search: { type: 'string' } } },
  },
  {
    name: 'create_product',
    description: 'Create a new product as a DRAFT (hidden from customers). Options like sizes/colors create one variant per combination, each with its own SKU.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        price: { type: 'number', description: 'Price in the store currency' },
        sku_prefix: { type: 'string', description: 'Start of the SKU, ideally matching the dealer\'s SKU' },
        product_type: { type: 'string' },
        vendor: { type: 'string' },
        image_url: { type: 'string', description: 'Public image URL (optional)' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } },
            required: ['name', 'values'],
          },
        },
      },
      required: ['title', 'price'],
    },
  },
  {
    name: 'update_product_details',
    description: 'Change a product\'s title and/or description.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } },
      required: ['product_id'],
    },
  },
  {
    name: 'set_product_status',
    description: 'Make a product ACTIVE (live), DRAFT (hidden) or ARCHIVED. Going live needs confirmation.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'string' }, status: { type: 'string', enum: ['ACTIVE', 'DRAFT', 'ARCHIVED'] }, ...confirmedProp },
      required: ['product_id', 'status'],
    },
  },
  {
    name: 'set_price',
    description: 'Set the price (and optional compare-at "was" price) for all variants of a product. Needs confirmation.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'string' }, price: { type: 'number' }, compare_at_price: { type: 'number' }, ...confirmedProp },
      required: ['product_id', 'price'],
    },
  },
  {
    name: 'delete_product',
    description: 'Permanently delete a product. Needs confirmation. Prefer ARCHIVED or DRAFT unless the owner clearly wants it gone.',
    input_schema: { type: 'object', properties: { product_id: { type: 'string' }, ...confirmedProp }, required: ['product_id'] },
  },
  {
    name: 'create_collection',
    description: 'Create a collection (like "Hoodies" or "Winter Drop"), optionally with products in it.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' }, product_ids: { type: 'array', items: { type: 'string' } } },
      required: ['title'],
    },
  },
  {
    name: 'add_to_collection',
    description: 'Add products to an existing collection.',
    input_schema: {
      type: 'object',
      properties: { collection_id: { type: 'string' }, product_ids: { type: 'array', items: { type: 'string' } } },
      required: ['collection_id', 'product_ids'],
    },
  },
];

const handlers = {
  find_products: findProducts,
  create_product: createProduct,
  update_product_details: updateProductDetails,
  set_product_status: setProductStatus,
  set_price: setPrice,
  delete_product: deleteProduct,
  create_collection: createCollection,
  add_to_collection: addToCollection,
};

module.exports = { actionTools, handlers };
