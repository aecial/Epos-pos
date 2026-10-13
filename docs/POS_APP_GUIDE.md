# POS App Guide (React Native)

A build guide for the restaurant's point-of-sale phone app. It talks to the Laravel server on the Intel NUC (`/api/v1`). The server is already built and tested; this app is the client.

The authoritative API contract is `docs/UNIFIED_API_ENDPOINTS.md` in the Laravel repo, especially §8.6 (offline sync). If this guide and that file ever disagree, that file wins.

---

## 1. The one idea to build around: offline-first

Power cuts take down the NUC, the Wi-Fi and the modem. The phones keep their battery, so **the app must keep selling with no server at all**. It catches the server up when the power returns.

Think of each phone as a **waiter with a notebook**:

- Every sale is written in the notebook (a local database and an **outbox**) **before** anything else happens.
- Online, the notebook is read to the server within a second, so the cashier sees the server's answer almost immediately.
- Offline, the notebook keeps filling up, the phone prints the receipt and a **kitchen slip** itself, and it's all sent when the connection returns.
- The server reads the notebook in order and ticks off each entry. Reading the same page twice never counts it twice.

**One road, always.** Selling actions (open shift, tickets, items, quantity, discount, cancel, payment, cash entries) **always** go through the outbox to `POST /sync`, online or offline. Don't build a separate "online mode" that calls the ticket endpoints directly. Two paths drift apart and the bugs hide in the gap.

---

## 2. Suggested stack

| Need | Use |
|---|---|
| App | Expo with a **development build** from day one (`expo-dev-client`; `npx expo run:android` locally or `eas build --profile development` in the cloud): the Bluetooth printer needs native code, which Expo Go can't load. Keep printing behind one interface (an on-screen version and the Bluetooth one) so screens can be built without the printer nearby |
| Local database (the source of truth on the phone) | `expo-sqlite` |
| Token | `expo-secure-store` |
| Ids | `expo-crypto` `randomUUID()` (uuid v4) |
| Network status | `@react-native-community/netinfo`, plus a real check against the server (`GET /up`) |
| UI state | Zustand (or Context), read from SQLite; SQLite stays the source of truth |
| HTTP | `fetch` or Axios with a request timeout (about 10 s) |
| Printer | A Bluetooth ESC/POS library that works with the Goojrpt PT-210 (58 mm). Test the exact library on the real printer early |

### Allow plain `http://` (or the installed app can't reach the NUC)

The NUC serves `http://` on the local network. Phones block that by default in **installed** (release) builds, even when it works in development:

- **Android:** in `app.json`, add the `expo-build-properties` plugin with `{ "android": { "usesCleartextTraffic": true } }`.
- **iOS:**
  - in `ios.infoPlist`, set `NSAppTransportSecurity` → `NSAllowsLocalNetworking: true`. If requests to the NUC's IP address still fail, use `NSAllowsArbitraryLoads: true` instead; it's acceptable for a business-owned app that only talks to its own server;
  - add an `NSLocalNetworkUsageDescription` text, since iOS asks permission for the local network.
- **Bluetooth (printer):** Android 12+ needs the `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` permissions, asked for at runtime.

Build an installed release early and test it against the NUC. Don't wait until the end to find out.

### Testing on real phones while developing

The phone and the development PC must be on the same Wi-Fi:

1. Start the server listening on the network, not just the PC: `php artisan serve --host=0.0.0.0 --port=8000` (MySQL must be running).
2. Start the WebSocket server: `php artisan reverb:start` (it listens on the network on port 8080).
3. Allow ports 8000 and 8080 through Windows Firewall, e.g. `New-NetFirewallRule -DisplayName "Epos dev" -Direction Inbound -Protocol TCP -LocalPort 8000,8080 -Action Allow` in an admin PowerShell.
4. In the app, the base URL is the PC's address from `ipconfig` (IPv4, e.g. `http://192.168.1.20:8000/api/v1`), never `localhost` (on the phone, that's the phone itself).
5. Check from the phone's browser that `http://<pc-ip>:8000/up` loads before debugging the app.

---

## 3. Talking to the server

- **Base URL:** `http://<nuc-ip>:8000/api/v1`. Make it a setting, not a constant.
- **Headers on every request:** `Accept: application/json` and `Authorization: Bearer <token>` (except login).
- **Response envelope:**
  - Success: `{ "success": true, "data": …, "meta"?: … }`
  - Error: `{ "success": false, "message": "…", "errors"?: { field: [msg] } }`, where `errors` comes only with `422`
- **Money:** records from the database (tickets, items, charges, shifts) come as **decimal strings**, e.g. `"175.00"`. Parse them before doing math. Computed values (live shift totals, receipt payloads) are numbers. Always send amounts as numbers.
- **Times:** the server sends ISO-8601 UTC. The restaurant runs on **Asia/Manila (UTC+8)**, so show times and work out "today" in Manila time.
- **Status codes:**

| Code | Meaning | What the app does |
|---|---|---|
| `401` | Token missing or revoked | Go to login, but **never** delete the outbox |
| `403` | Wrong role or ability, or a bad passcode | Show the message |
| `404` | Not found, or another cashier's ticket | Show the message |
| `409` | A business rule said no (ticket not open, stock short, …) | Show the message |
| `422` | Validation failed | Show the `errors` next to the fields |
| `429` | Too many logins (6/min) or wrong passcodes (5/min) | Wait for `Retry-After` |
| `5xx` / timeout | Server trouble | Treat as offline for syncing; retry later |

---

## 4. Sign-in and the device code

`POST /auth/login`

```json
{ "username": "dangbi", "password": "…", "device_name": "POS-01" }
```

→ `201`:

```json
{ "data": { "token": "1|…", "user": { "id": 2, "name": "Dangbi", "role": "cashier", … }, "device": { "code": "P3", "name": "POS-01" } } }
```

- **Token:** store it in SecureStore. It **never expires**; a manager can revoke it from the back office.
- **`device.code`** (e.g. `P3`) is this login's unique prefix for the receipt and order numbers the phone prints while offline (§9). Store it.
- **`device_name`:** use a stable, readable name (the terminal's name). Managers see it on the Devices page.
- **Roles:**
  - `cashier`: sells and sees only their own tickets.
  - `manager`/`admin`: sees all tickets.
  - Any role can record cash additions and expenses.
- **One shared account on every phone** (the restaurant's choice) works: every phone sees every ticket, and each phone is still told apart by its own device code and `terminal_id`. **During an outage, finish each order on the phone that has it.** Every phone downloaded every open ticket, so two phones could otherwise both pay the same order. The server would catch that as a "possible double payment", but it's better never to need it.
- **Sign-out (`POST /auth/logout`) is blocked while the outbox isn't empty.** Show "Connect to the server to send N waiting sales before signing out". Switching users is the same.
- **On a `401`:** show the login screen, but keep the outbox. It is sent after someone signs in again.

---

## 5. Local database (suggested tables)

| Table | Holds |
|---|---|
| `settings` | `base_url`, `device_code`, `device_name`, `user` (id, name, role), `clock_offset_ms`, `menu_version`, `order_counter`, `receipt_counter` + `receipt_counter_date` |
| `categories`, `items`, `modifiers` | The menu from the snapshot (keep the item's `modifiers` with their group and `is_stockless_variant`) |
| `shift` | The current shift: `shift_uuid`, `server_id` (null until synced), starting cash, opened at |
| `tickets` | `ticket_uuid`, `server_id`, `order_number` (server), `offline_label`, customer name, order type, status, discount, totals in centavos, `created_offline` |
| `ticket_lines` | `line_uuid`, `server_id`, `ticket_uuid`, item id, name, quantity, unit price (centavos), modifiers (json), notes, `is_stockless`, voided, `sent_to_kitchen` |
| `payments` | `charge_uuid`, `ticket_uuid`, method, amount, tendered, reference, `receipt_number`, `server_receipt_id` |
| `outbox` | `id` (the action uuid), `seq` (autoincrement = order), `type`, `offline` (bool), `happened_at`, `payload` (json), `status` (`waiting`/`sent`) |
| `notices` | Server rejections and issues to show the cashier |

**Golden rule:** a user action changes the local tables **and** adds its outbox row **in one SQLite transaction**. Only after that commits do you print, show "done" or move on. A crash or dead battery after that point loses nothing.

---

## 6. The snapshot: what the phone keeps to sell offline

`GET /sync/snapshot` → `data`:

```json
{
  "device": { "code": "P3", "name": "POS-01" },
  "server_time": "2026-10-10T10:00:00+08:00",
  "menu_version": "4f1c…",
  "shift": { "id": 7, "status": "open", "starting_cash": "2000.00", "opened_at": "…" },
  "categories": [{ "id": 1, "name": "Itik", "type": "menu" }],
  "items": [ /* exactly the GET /items shape */ ],
  "open_tickets": [ /* your open tickets (a manager: all), each with items[].modifiers */ ]
}
```

- **When to refresh:**
  - on app start;
  - right after reconnecting;
  - every few minutes while online;
  - after a shift opens or closes.

  Re-save the menu tables only when `menu_version` changed. Always take the new `available_stock`, `shift`, `open_tickets` and `server_time`.
- **`server_time`:** work out `clock_offset_ms = server_time − Date.now()` and keep it (§9).
- **`shift: null`** means no shift is open. A manager can open one, even offline (§11).
- **Items:**
  - `status: "unavailable"` → show greyed out; it can't be ordered.
  - `category.type: "special"` → a "Specials" section.
  - `entry_mode`:
    - `fixed`: add as-is.
    - `price` (Fee): the cashier types the amount.
    - `name_price` (Custom): the cashier types a name and an amount.
- **Modifiers:** a group with `is_required: true` must have a pick before adding. Online the server refuses the item otherwise ("Fried Itik needs a choice of Size."); offline the sale is kept but flagged for a manager. `is_stockless_variant: true` (e.g. "Lagi") is always ₱0 and takes no stock; see the printing rules in §14.
- **Only `available` items can be sold.** Online the server refuses an unavailable or hidden item, or one whose category was switched off, even if the phone's menu is old ("Burger is unavailable right now."). Offline it's kept and flagged.

---

## 7. The outbox and the sync loop

### One action

```json
{
  "id": "6f0c2b1e-…",              // uuid made once when the action is created, reused on every retry
  "type": "ticket.add_item",
  "offline": false,                // true = it happened without the server knowing (see §8)
  "happened_at": "2026-10-10T10:06:00+08:00",   // required when offline; send it always
  "data": { … }                    // depends on the type (§10)
}
```

### The loop (pseudo-code)

```
syncing = false
async function drain() {
  if (syncing) return              // only ONE request in flight, ever
  syncing = true
  try {
    while (true) {
      batch = outbox.oldest(200)   // oldest first, in seq order
      res = POST /sync { actions: batch.map(build), pending: outbox.count() - batch.length }
      if (network error / timeout / 5xx) { scheduleRetry(backoff); break }   // keep everything, resend the SAME ids later
      if (401) { goToLogin(); break }                                        // keep the outbox
      for (r of res.data.results) applyResult(r)   // in the same order as sent
      saveClockOffset(res.data.server_time)
      if (batch.length < 200) break
    }
  } finally { syncing = false }
}
```

- **Run `drain()`:**
  - right after any action is saved;
  - when the network comes back;
  - on app start;
  - every 30–60 s as a **heartbeat**, even with an empty outbox (`actions: []`, `pending: 0`). The heartbeat tells the server this phone has nothing left, so the shift can close.
- **Retry timing:** 2 s, 5 s, 10 s, 30 s, then every 30 s. Resending is always safe: an action id the server already has returns its stored result and changes nothing.
- **`applyResult(r)`:**

| `r.status` | What to do |
|---|---|
| `applied` | Delete the outbox row. Save the server's answers from `r.result` (§10): server ids, real `order_number`, final `customer_name` (e.g. "John2"), `receipt_number`s |
| `applied_with_issue` | Same as applied. The server also wrote notes for a manager (`r.issues`); optionally show the cashier a small notice |
| `rejected` | Delete the outbox row, and if it was **online**, show `r.message` to the cashier now (e.g. "Insufficient stock for item Fried Itik.") and undo it locally. If **offline**, the server already made a note for the manager: show a small notice and mark the local record "not on server" |

- **A batch that's cut off is fine.** The next send repeats the same ids, the ones already applied replay as no-ops, and the rest continue.

### Building `data` at send time

Store what you need on the outbox row and build `data` **when sending**, from the row's current `offline` flag. Two fields depend on it:

- `ticket.add_item` → `unit_price`:
  - **online:** only for Fee/Custom items (the server **refuses** it for normal items);
  - **offline:** always, as the price the customer was charged.
- `ticket.charge` → `receipt_number`:
  - **offline:** the number the phone printed;
  - **online:** leave it out (the server numbers it).

---

## 8. Online, offline, and the in-between

- **Status:** "online" means the server answered recently, not just "Wi-Fi is on" (the Wi-Fi can be up while the NUC is down). Check `GET http://<nuc-ip>:8000/up` (any `200`) or use the last sync result. Show a clear banner: **"Offline — 12 sales waiting"**.
- **The `offline` flag answers one question:** did this happen without the server knowing?
  - Created while online → `offline: false`.
  - Created while offline → `offline: true`.
  - **Stuck:** an online action not delivered within ~5–10 s (the network just died) → flip it **and every waiting action after it** to `offline: true`. Then:
    - print the kitchen slip for any food in them (the kitchen display never got it);
    - for a payment, give it an offline receipt number and print the receipt.

  Flipping an action that hasn't been answered is safe. If the server had in fact received it, it returns the original result.
- **Online-only actions** (§12) are disabled while offline, with the reason shown.

---

## 9. Time, labels and receipt numbers

- **`happened_at`** = `new Date(Date.now() + clock_offset_ms)`, sent as ISO with the offset (`+08:00`). The server distrusts times in the future or before the shift opened, and flags them.
- **Offline order label:** `{device_code}-{NNN}` (e.g. `P3-007`), from `order_counter` in `settings`. Send it as `offline_label` in `ticket.create`. Print it on the slips and the receipt. After sync, show the real number with the label: **#012 (P3-007)**.
- **Offline receipt number:** `REC-{YYYY-MM-DD}-{device_code}-{NNN}` (e.g. `REC-2026-10-10-P3-001`), with `NNN` restarting each **Manila** day (`receipt_counter` + `receipt_counter_date`). The server keeps exactly this number, so paper and server match.
- Increase the counters **inside the same SQLite transaction** as the action that uses them.

---

## 10. Action reference (`POST /sync`)

Refer to things the phone created by their **uuid**, and to things that came from the server (open tickets in the snapshot) by their **server id**. Every "ref" field accepts either:

- `ticket_uuid` or `ticket_id`
- `line_uuid` or `ticket_item_id`
- `shift_uuid` or `shift_id`
- `transaction_uuid` or `transaction_id`

| Type | `data` | `result` |
|---|---|---|
| `shift.open` | `shift_uuid`, `starting_cash` | `shift_id`, `joined` |
| `ticket.create` | `ticket_uuid`, shift ref (optional; default = the open shift), `terminal_id`, `customer_name`, `order_type` (`dine_in`/`takeout`), `offline_label` (offline) | `ticket_id`, `shift_id`, `order_number`, `customer_name` |
| `ticket.add_item` | ticket ref, `line_uuid`, `item_id`, `quantity`, `modifier_ids` [], `notes`, `unit_price`, `custom_name` (Custom item) | `ticket_id`, `ticket_item_id`, `line_total`, `ticket_total` |
| `ticket.set_quantity` | line ref, `quantity` (≥ 1) | `ticket_item_id`, `line_total`, `ticket_total` |
| `ticket.void_item` | line ref, `reason` — **offline only** | `ticket_item_id`, `ticket_total` |
| `ticket.discount` | ticket ref, `discount_amount` and/or `discount_percent` (0–100) | `ticket_total` |
| `ticket.cancel` | ticket ref | `status` |
| `ticket.charge` | ticket ref, `charges`: [{ `charge_uuid`, `payment_method` (`cash`/`gcash`), `amount`, `tendered_amount` (cash only), `payment_reference` (required for gcash), `receipt_number` (offline) }] | `status`, `charged`, `receipts`: [{ `charge_uuid`, `charge_id`, `receipt_id`, `receipt_number`, `payload` }]: `payload` is the printable receipt, so print it straight away |
| `shift_transaction.add` | `transaction_uuid`, shift ref (optional), `type` (`expense`/`addition`), `amount`, `reason` — any staff | `transaction_id`, `shift_id` |
| `shift_transaction.update` | transaction ref, `amount`, `reason` — any staff | `transaction_id` |
| `shift_transaction.delete` | transaction ref — any staff | `transaction_id` |

**Things to know:**

- **Discounts:** sending a discount replaces both fields (an omitted one becomes 0). A percent above 0 wins over a fixed amount. To remove the discount, send `{ "discount_amount": 0 }`.
- **Names:** the server adds a number to a name already open in the shift (john → john2), across all phones. Show the returned `customer_name`.
- **Ticket access:** a cashier may only act on tickets they opened (others are rejected `Not found.`).
- **Quantity 0 isn't allowed;** removing a line is a void (online: passcode, §12; offline: `ticket.void_item` with a reason).
- **Online, the server refuses what the menu doesn't offer:** an unavailable, hidden or switched-off item, or a missing pick from a required group. Show its message and remove the line.
- **Offline, the server accepts what already happened** (stock below zero, the price you charged, an item that was switched off, a missing required pick, a closed shift's late sales) and flags each disagreement for a manager. You don't need to handle those flags.

---

## 11. Screens and flows

| Screen | What it does | How |
|---|---|---|
| **Login** | Username + password | `POST /auth/login` (online only) → save token and device code → snapshot |
| **Shift setup** | Snapshot `shift` exists → menu. None → manager enters starting cash | `shift.open` with a new `shift_uuid` (works offline: it joins whatever shift the server has, or becomes the shift) |
| **Menu** | Categories, item grid, Specials; greyed-out `unavailable` items; `available_stock` | Snapshot tables; lower the local stock as you sell |
| **Cart / ticket** | New ticket, add items (modifiers, notes), quantity +/−, discount, order type | `ticket.create`, `ticket.add_item`, `ticket.set_quantity`, `ticket.discount` |
| **Remove item** | Online: a manager types a passcode. Offline: the cashier types a reason | Online: `DELETE` (§12). Offline: `ticket.void_item` |
| **Checkout** | Cash (tendered → change), GCash (reference required), split cash + GCash by amount; total ₱0 → one "Close (no charge)" with a single `amount: 0` charge | `ticket.charge` → print a receipt per payment |
| **Open tickets** | My open tickets (a manager: all); cancel; merge | `ticket.cancel`; merge is online-only (§12) |
| **Receipts** | History from every terminal, search, reprint | Online only: `GET /receipts`, `GET /receipts/{id}`, `POST /receipts/{id}/reprint` |
| **Refunds** | Request; approve/reject with a manager passcode | Online only (§12) |
| **Shift** | Live totals, expenses and additions (any staff), close shift | `GET /shifts/active`; `shift_transaction.*`; close is online-only (§12) |

**Stock:**

- Show `available_stock` and lower it locally as you sell. `null` = not tracked (unlimited).
- **Online:** if the server rejects an add for stock, show it and remove the line.
- **Offline:** you can't see other phones' sales. At 0 left, **warn but allow** (the server flags it).
- Lines with a stockless variant (Lagi) ignore stock completely, even at 0.

---

## 12. Online-only calls (direct endpoints)

These need the server's answer on the spot. **Call them only when online and only after the outbox is empty** (drain first, then call). That keeps them after everything before them, and the records they point at exist on the server.

| Action | Call |
|---|---|
| **Remove an item with a passcode** | `DELETE /tickets/{ticket_id}/items/{ticket_item_id}` with `{ "passcode": "0428" }` → `meta.approver` = who approved. `403` wrong passcode, `429` after 5 tries/min |
| **Merge tickets** | `POST /tickets/{target_id}/merge` with `{ "merge_from_ticket_ids": [11, 12] }` (same shift, all open; a cashier only their own) |
| **Request a refund** | `POST /refunds` with `{ "ticket_id", "charge_id", "reason", "items": [{ "ticket_item_id", "quantity", "amount" }] }` |
| **Approve / reject a refund** | `PUT /refunds/{id}/approve` or `/reject` with `{ "passcode" }`; the pending list is `GET /refunds?status=pending` |
| **Receipts** | `GET /receipts?search=…&date_from=…&payment_method=…&page=…`; `GET /receipts/{id}` (has `payload`); `POST /receipts/{id}/reprint` → print with the "DUPLICATE RECEIPT" watermark |
| **Close the shift** | Drain the outbox → `GET /shifts/active` (its `devices` list shows each phone's `pending_actions`) → `PUT /shifts/{id}/close` with `{ "closing_cash" }`. `409` if a ticket is open or a device still has unsent actions. A manager may add `"force": true` for a broken phone |

Offline these buttons are **disabled**, with "Needs the server". Signing out and switching users are disabled offline too.

---

## 13. Money math (match the server exactly)

Work in **integer centavos**. If the phone's total differs from the server's, the sale still goes through, but it lands on a manager's review list.

```
modifier price   = is_stockless_variant ? 0 : price_modifier
line_total       = (unit_price + Σ modifier prices) × quantity
subtotal         = Σ line_total of lines that aren't voided
discount         = discount_percent > 0 ? round(subtotal × discount_percent / 100) : discount_amount
total            = max(0, subtotal − discount)
```

- **`unit_price`** is the item's `base_price`, or the amount typed for a Fee/Custom item.
- **Payments:** they must add up to `total` exactly. Cash `change = tendered − amount`. GCash has no tendered amount or change.
- **Split payment receipts** (one receipt per payment): each receipt lists **all** items, and the discount is shared by amount. Every payment except the last gets `floor(discount × amount ÷ total)`; the last gets what's left. So a receipt's `subtotal = amount + its discount share`, `total = amount`.
- **₱0 total (comp):** exactly one payment of `amount: 0`.

---

## 14. Printing (Goojrpt PT-210, 58 mm)

**Receipt.** After a payment, print one per payment. **Online:** print the `payload` returned in the `ticket.charge` result (§10); it's exactly what the server stored, with the server's receipt number. **Offline:** print the same layout from local data, with the phone's offline receipt number (§9):

- No restaurant name, address or contact (the owner's choice).
- Receipt number, date and time (Manila), order number, plus `· P3-007` when it was taken offline, customer, dine-in/takeout, cashier.
- Lines: `qty × name`, modifiers with their price, line total. **Never print a stockless variant (Lagi)**: it's always ₱0 and kitchen-only. **Never print kitchen notes.** Fee lines can go under their own "Fees" heading.
- Subtotal, discount, total, payment method, tendered and change (cash) or reference (GCash).
- A footer line like "Thank you" is your choice.
- Merged tickets: print every order number (`order.merged_from`).
- Reprint: the same receipt plus a big **DUPLICATE RECEIPT** watermark.

**Kitchen slip.** **Offline only**, when items are added (the kitchen display can't receive them):

- Order label (`P3-007`), customer, dine-in/takeout, time.
- Each line `qty × name`, **all** modifiers **including Lagi**, and the notes.
- Removed offline after the slip went out → print a short **"CANCEL: 1× Burger — P3-007"** slip.

**Order of steps:** save to SQLite → then print. If the printer is off or out of paper, show the receipt on screen and offer "Print again". The sale is already saved.

---

## 15. Things that must never happen

- Deleting or rewriting outbox rows except after the server's result (or a deliberate "discard" by a manager).
- Making a new `id` or uuid for a retry.
- Sending two `/sync` requests at the same time, or sending the outbox out of order.
- Calling an online-only endpoint while the outbox still holds actions.
- Signing out, or clearing app data, with actions still waiting.
- Printing before the action is safely in SQLite.

---

## 16. Test before trusting it

1. **Mid-order outage:** start an order online, turn on airplane mode, add items (a kitchen slip prints), pay (a receipt prints with `REC-…-P3-001`), turn it back on, and check the ticket shows **#0xx (P3-…)** in the back office with the right times.
2. **Kill the app offline:** reopen it, and nothing is lost and the counters continue.
3. **Two phones offline, one item left:** both sell it; after sync, the stock is −1 and Sync Review shows "Stock below zero".
4. **Lost reply:** cut the network right after sending a payment, reconnect, and check there's exactly one payment on the server.
5. **Wrong phone clock:** set it a day ahead, sell offline, sync, and check Sync Review shows "Phone clock wrong".
6. **Opening offline:** start the day with no shift and the NUC off, open the shift on the phone, sell, then power the NUC back on.
7. **Close:** with sales still waiting on a phone, the close is refused and names the phone; once it syncs, the close works.
8. **Money:** a percent discount, a split payment and a ₱0 comp all sync as `applied`, with no "Payment differed" note.
