# Stockroom: daily packaging stock

A mobile-friendly web app for one stockroom controller. It tracks daily packaging stock, works out what to order before the 12:30 cutoff, and warns before anything runs out.

The daily routine is four taps on the bottom bar: **Count → Delivery → Usage → Order**.

## Daily workflow

| Step | What you do | What the app does |
|---|---|---|
| **Count** | Print the count sheet (Count → *Print blank count sheet*), count by hand, photograph each page | Reads the handwritten numbers, shows each one next to its SKU with a confidence mark, the previous count and the expected stock. You correct anything, then **Confirm & save**. Low (amber) and critical (red) items are listed and pushed as a notification. |
| **Delivery** | Photograph the delivery note | Extracts lines and quantities, matches them to SKUs (fuzzy, remembered once confirmed), converts PCS to cartons when the pack size is known, and compares against open orders. Shortages are flagged, and you choose whether the rest is still coming. |
| **Usage** | Upload the Calo dashboard packaging stats (.xlsx or .csv) | Reads daily usage per item (one column per date, or Date/Item/Qty rows), matches names to SKUs, asks you to confirm uncertain matches once, and flags unmatched names. |
| **Order** | Review quantities, then Copy / Send / Excel / PDF, then **Mark as ordered** | Order list grouped by supplier. Tap *why?* on any line to see the calculation. *Mark as ordered* writes the order log, which drives the 30-day rule and the delivery check. |

Nothing read from a photo or file changes stock until you confirm it. Unclear photos are flagged on the phone before upload (dark, glare, blur, low resolution) and again by the reader, which asks for a retake.

## Rules

**Calendar.** Sunday is closed: no ordering and no delivery. Extra closed days can be added in Settings. An order placed before the cutoff (default 12:30) is booked that day; after the cutoff, or on Sunday, it is booked on the next working day. Delivery is the next working day, so a Saturday order arrives on Monday. Supplier lead time is configurable globally and per item.

**Order quantity** (per SKU):

```
Required  = forecast usage from today until the delivery after next
            (next possible delivery + the following cycle)
          + safety stock            (safety = 1.3 × average daily usage)
Order qty = Required − (current stock + confirmed incoming orders)
            rounded up to whole cartons (or to pack multiples for items counted in pieces)
```

If a per-item minimum level is higher than safety stock, the minimum replaces it.

Average daily usage comes from the imported forecast (next 14 days). If there is no forecast it falls back to the master sheet's *Avg Daily Usage*, then to usage observed between counts.

**Current stock** is the last physical count plus deliveries confirmed after that count.

**Status.**
- 🔴 **Critical:** out of stock, or it runs out before an order placed now could arrive.
- 🟠 **Low:** below safety stock or below the item's minimum level.
- 🟢 **OK:** neither of the above.
- ⚪ **Setup:** no count yet, or no usage data and no minimum level.

**Days of cover / depletion.** Stock is projected forward day by day with the forecast. Sundays consume nothing unless the forecast file says otherwise (or you switch on *Packaging is used on Sundays*). Days of cover counts usage days only.

**Not ordered in 30+ days.** Any item with no order in the log for more than 30 days (or never) is flagged.

**Depletion warning.** For those items the app finds the day stock is fully used up. It then works back to the last booking day whose delivery still arrives by then, taking in lead time, the cutoff and Sunday closure. It warns once that day is 3 days away or less, so you still have ordering chances left. If it is already too late, the warning says so.

**Reminders.** Push notifications at 11:30 and 12:15 (editable), Monday to Saturday, never on closed days. Each one summarises what to order. The home screen shows a live countdown to the cutoff.

**Discrepancy check.** Expected stock is the previous count + deliveries − forecast usage. It is shown next to every count while you review. Gaps of at least 20% and 2 units (both editable) are highlighted, as they can point to wastage or counting errors.

Every change records who or what made it in the **audit trail**: a manual edit, OCR confirmed by you, OCR corrected by you, a usage import, or the system.

## Running it

Needs Node.js 22.13 or newer (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env        # optional: ANTHROPIC_API_KEY, APP_PIN
npm run build               # builds the web app into dist/
set -a; . ./.env; set +a
npm start                   # http://localhost:3000
```

**AI scan** (reading handwritten counts and delivery notes) needs a Claude API key. Paste it once in the app under **Settings → AI scan**; it is checked, stored on the server and never shown again. Alternatively set `ANTHROPIC_API_KEY` in the environment. Without a key everything else works and counts can be typed in.

For development, `npm run dev` runs the API on :3000 and the Vite dev server with hot reload. Tests: `npm test`.

On first start the 89 SKUs from `PACKAGING_INVENTORY_AUTOMATION.xlsx` (Master Inventory) are loaded. To add or update items later, upload the workbook again under Settings → *Master inventory*. Your minimum levels and units are kept.

**Phone setup.** Open the app on the phone, then add it to the Home Screen (on iPhone: Share → Add to Home Screen). Open Settings → *Enable on this device* for reminders. Push notifications need HTTPS (or localhost), so put the server behind HTTPS when you deploy it. If it is reachable from the internet, set `APP_PIN`.

**Units.** Items are counted and ordered in cartons by default, with *Pack / Carton Qty* as pieces per carton. Dashboard usage in pieces is converted to cartons using the pack size. Where the pack size is missing, the import warns you. Switch an item to *pieces* in its settings if you count it that way.

## Project layout

```
shared/   calendar, order/status/depletion engine, fuzzy SKU matching (+ unit tests)
server/   Express API, SQLite schema, OCR (Claude vision), Excel import/export, web push + reminder scheduler
web/      React PWA (Home, Count, Delivery, Usage, Order, Items, Reports, SKU matching, Settings, Audit)
```

Data (SQLite database and the uploaded photos) is stored in `data/` by default.
