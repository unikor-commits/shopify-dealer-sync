# Shopify Dealer Sync

Your own app that links your Shopify store to your dealer:

1. **Orders** – When a customer buys, the order is sent to your dealer automatically.
2. **Stock** – Every 30 minutes, your dealer's stock levels are copied into Shopify, so you never sell something they're out of.
3. **Tracking** – When the dealer ships, the tracking number is added to the Shopify order and Shopify emails it to the customer.
4. **AI agent** (optional) – Claude watches the store for you:
   - **Daily summary** at 8 AM: orders, sales, best sellers, problems, and a to-do list.
   - **Problem watcher** every hour: retries orders that failed to reach the dealer, flags orders stuck without tracking and low stock, and emails you only when something new comes up.
   - **Chat page** at `/chat`: ask things like "which orders haven't shipped?" and it looks up the real answer.

Products are matched by **SKU**, so each product variant in Shopify (e.g. "Hoodie – Black – S") must have the same SKU your dealer uses.

---

## Step 1: Get your dealer's API details

Ask your dealer: *"Do you have an API for placing orders, checking stock, and getting tracking numbers? Can you send me the documentation and an API key?"*

Then open `src/dealer.js` and update every line marked **CHANGE ME** to match their docs. That's the only code file you need to touch.

> If the dealer has **no API** (only a website you log into), this app can't place orders on its own. Let me know and we can switch it to email or a spreadsheet export instead.

## Step 2: Create the app in Shopify

1. Go to **dev.shopify.com/dashboard** (or Shopify admin → your store name → Dev Dashboard).
2. **Apps → Create app**, name it "Dealer Sync".
3. In the app's version, choose these permissions (scopes):
   - `read_orders`
   - `read_products`
   - `read_inventory`, `write_inventory`
   - `read_locations`
   - `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`
4. Add a **webhook**: topic **Orders create**, URL `https://YOUR-APP-ADDRESS/webhooks/orders-create` (you'll get the address in Step 3; you can come back and add it).
5. Release the version and **install the app on your store**.
6. From the app's **Settings**, copy the **Client ID** and **Client Secret**.

## Step 3: Put the app online

The app needs to run on a server so Shopify can reach it. Easy options: **Render**, **Railway**, or **Fly.io**.

1. Upload this folder to a GitHub repo.
2. Create a new "Web Service" on your host from that repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Add the settings from `.env.example` as **environment variables** on the host, filled in with your real values.
4. Your host gives you an address like `https://dealer-sync.onrender.com`. Use it for the webhook in Step 2.

> Tip: pick a plan with a **persistent disk** (or tell me and I'll switch storage to a database). The app keeps a small record in `data/orders.json` so it never sends an order twice; some free plans wipe that file on restart.

## Step 4: Test safely

1. Keep `DRY_RUN=true` at first.
2. Place a test order on your store. In your host's logs you should see `[DRY RUN] Would send to dealer: ...` with the customer and items.
3. If it looks right, set `DRY_RUN=false` and place one real test order.
4. Check that stock numbers in Shopify match the dealer after the next sync, and that tracking shows up once the dealer ships.

## Step 5: Turn on the AI agent

1. Go to **console.anthropic.com**, set up billing, and create an API key. (This is separate from your Claude subscription; you pay per use, which is usually small for one store.)
2. On your host, add these environment variables (never paste keys into chats or code):
   - `ANTHROPIC_API_KEY` – your new key
   - `ADMIN_PASSWORD` – a long, unique password for the chat page
3. For email summaries and alerts, add the `SMTP_...` settings and `ALERT_EMAIL_TO`. With Gmail, turn on 2-step verification and create an **App Password** to use as `SMTP_PASS`. Without email set up, summaries show in your host's logs.
4. Restart the app. The logs should say `AI agent: ON`.
5. Open `https://YOUR-APP-ADDRESS/chat`, enter your password, and ask a question.

Run them right away to test: `npm run summary-now` and `npm run watch-now`.

## Running it on your own computer (optional)

```bash
npm install
cp .env.example .env    # then fill in your values
npm start
npm run sync-stock      # run a stock sync right now
npm run sync-tracking   # check for tracking right now
```

## Files

- `src/index.js` – the server: receives new-order webhooks and runs the 30-minute sync
- `src/jobs.js` – the three jobs: send orders, sync stock, sync tracking
- `src/shopify.js` – talks to Shopify
- `src/dealer.js` – talks to your dealer (**edit this one**)
- `src/store.js` – remembers which orders were already sent
- `src/agent.js` – the AI agent and the tools it can use
- `src/monitor.js` – daily summary and hourly problem watcher
- `src/notify.js` – sends the emails
- `public/chat.html` – the chat page
