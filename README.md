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

Needs Node.js 22.13 or newer (the LTS from [nodejs.org](https://nodejs.org)). The app uses Node's built-in `node:sqlite`.

```bash
npm start                   # http://localhost:3000
```

The first `npm start` in a new folder installs the packages and builds the app, which takes a minute or two. Later starts skip straight to the server, and the app is rebuilt automatically if its code has changed. On Windows you can also double-click **`start-stockroom.bat`**. The same commands work in Command Prompt, PowerShell, macOS and Linux.

Settings such as `APP_PIN` or `PORT` can go in a `.env` file in the project folder (copy `.env.example`). The server loads it on start, so there is no need to set variables in the shell.

**Windows tip:** keep the app folder outside OneDrive, for example `C:\stockroom`. OneDrive syncing tens of thousands of package files makes installs slow, and can lock files mid-install (`EPERM` errors).

If something goes wrong during setup, you can run the steps by hand: `npm install`, then `npm run build`, then `npm start`.

## AI scan (Claude or Gemini)

AI scan reads the handwritten count sheet and delivery notes from your photos. You can use either provider:

| | Claude | Google Gemini |
|---|---|---|
| Get a key | console.anthropic.com → API keys | aistudio.google.com → Get API key |
| Model used | `claude-opus-5-5` (`OCR_MODEL` to change) | `gemini-flash-latest` (`GEMINI_MODEL` to change) |
| Key from the environment | `ANTHROPIC_API_KEY` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |

Choose the provider and paste its key once under **Settings → AI scan**. The app checks the key with the provider, which doesn't use up any quota. The key is then stored on the server only and is never sent back to the browser. A key set in the environment takes precedence over one pasted in Settings. `OCR_PROVIDER=gemini` sets the starting provider until you pick one in Settings.

Both providers fill exactly the same output format. Every reply is checked against that format before the app uses it, and anything that doesn't fit is treated as an unreadable photo. Whichever provider you use, the numbers only fill in the review screen. Nothing changes stock until you confirm.

**Limits.** When Gemini's free quota or rate limit is used up (or Claude's rate limit is reached), the scan stops with *"Free limit reached, try again later or enter manually"* and an **Enter manually** button. On a multi-page count, pages already scanned are kept and only the remaining rows are left for you to type. On Gemini, photos are sent one at a time, to stay within the free tier's requests-per-minute limit.

**Privacy.** On Gemini's free tier, Google may use what you send (including photos) to improve its products, and people may review it. Check [Google's Gemini API terms](https://ai.google.dev/gemini-api/terms) before sending sheets, especially anything confidential. Keys on a paid (billing-enabled) Google project are covered by different terms.

Without any key, everything else still works, and counts and deliveries can be typed in.

For development, `npm run dev` runs the API on :3000 and the Vite dev server with hot reload. Tests: `npm test` (the AI scan tests use a local mock of the Gemini and Claude APIs; no keys or network needed).

On first start the 89 SKUs from `PACKAGING_INVENTORY_AUTOMATION.xlsx` (Master Inventory) are loaded. To add or update items later, upload the workbook again under Settings → *Master inventory*. Your minimum levels and units are kept.

**Phone setup.** Open the app on the phone, then add it to the Home Screen (on iPhone: Share → Add to Home Screen). Open Settings → *Enable on this device* for reminders. Push notifications need HTTPS (or localhost), so put the server behind HTTPS when you deploy it. If it is reachable from the internet, set `APP_PIN`.

**Units.** Items are counted and ordered in cartons by default, with *Pack / Carton Qty* as pieces per carton. Dashboard usage in pieces is converted to cartons using the pack size. Where the pack size is missing, the import warns you. Switch an item to *pieces* in its settings if you count it that way.

## Project layout

```
shared/   calendar, order/status/depletion engine, fuzzy SKU matching (+ unit tests)
server/   Express API, SQLite schema, Excel import/export, web push + reminder scheduler
  ocr/    AI scan: shared schemas and prompts, Claude and Gemini adapters, provider choice (+ tests with a mock API server)
web/      React PWA (Home, Count, Delivery, Usage, Order, Items, Reports, SKU matching, Settings, Audit)
```

Data (SQLite database and the uploaded photos) is stored in `data/` by default.
