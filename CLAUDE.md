# CLAUDE.md — Restaurant POS App (React Native)

**Stack:** Expo (React Native, TypeScript) · `expo-sqlite` · `expo-secure-store` · Zustand · Bluetooth ESC/POS printing
**Server:** the Laravel app on the Intel NUC (`Epos` repo), REST API at `http://<nuc-ip>:8000/api/v1`, Sanctum bearer token
**Printer:** Goojrpt PT-210 thermal printer (58 mm, Bluetooth)
**Timezone:** Asia/Manila (UTC+8) for everything shown or counted ("today", receipt numbers)

The server is built and tested; this app is its client. **Don't change server behaviour from here.** If the API seems wrong, say so instead of working around it.

---

## Source of truth

These live in the Laravel repo (`Epos/docs/`). Copy them into this repo's `docs/` and keep them in sync:

| File | What |
|---|---|
| `docs/UNIFIED_API_ENDPOINTS.md` | The API contract. §8.6 = offline sync. **Wins over everything else, this file included** |
| `docs/POS_APP_GUIDE.md` | How this app must work: outbox, sync loop, numbering, money math, printing, test plan |

Read the relevant section of the guide before working on sync, money, numbering or printing.

---

## Development build (no Expo Go)

The app runs as an Expo **development build** (`expo-dev-client`) from day one, because the Bluetooth printer needs native code that Expo Go can't load.

- **Build:**
  - Local: `npx expo run:android`. Needs Android Studio, i.e. the Android SDK and JDK 17.
  - Cloud: `eas build --profile development --platform android`.
- **Daily use:** `npx expo start --dev-client`. Ordinary code changes hot-reload; no rebuild needed.
- **Rebuild only when native code changes:** a native package is added or upgraded, or `app.json` plugins or permissions change. Say so when a change needs a rebuild.
- Install packages with `npx expo install` so their versions match the SDK.
- **Prove the printer first.** Before building screens, a "print test page" button must work on the real PT-210. The Android emulator has no Bluetooth to reach the printer, so printer work needs a real phone. Everything else can be built on the emulator.

**Printing goes through one interface** (`src/printing/`): `printReceipt(receipt)`, `printKitchenSlip(slip)`, `printCancelSlip(slip)`. It has two implementations:
- **Bluetooth ESC/POS**, the real one.
- **On-screen**, used when the printer is off or out of paper ("Print again"), and while developing on the emulator.

Screens never import the printer library directly.

**Release builds must allow plain `http://` to the NUC:**
- Android: `expo-build-properties` with `usesCleartextTraffic: true`.
- iOS: `NSAllowsLocalNetworking` and `NSLocalNetworkUsageDescription`.
- Android 12+ Bluetooth: ask for `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` at runtime.

---

## Suggested layout

```
app/                  ← Expo Router screens (login, shift, menu, ticket, checkout, open tickets, receipts, refunds, shift)
src/
  api/                ← fetch client: base URL from settings, Bearer token, 10 s timeout, envelope parsing
  db/                 ← SQLite schema, migrations, repositories (the phone's source of truth)
  sync/               ← outbox, drain loop, applyResult, snapshot refresh, online check, clock offset
  domain/             ← pure logic: money (centavos), numbering (labels/receipt numbers), receipt/slip builders
  printing/           ← printer interface + implementations (on-screen preview, Bluetooth ESC/POS)
  store/              ← Zustand stores (UI state read from SQLite)
  components/
```

Keep `domain/` free of React and I/O so it can be unit-tested.

---

## The rule everything is built around: offline-first

Power cuts take down the NUC and the Wi-Fi. **The app keeps selling with no server** and catches up later.

- **One road, always.** These actions go through the local **outbox** → `POST /sync`, online or offline:
  - open shift
  - ticket create, add item, set quantity, discount, cancel
  - payment (`ticket.charge`)
  - cash additions/expenses (`shift_transaction.*`)

  **Never** call the direct ticket/payment endpoints for these. There is no separate "online mode".
- **Golden rule:** a user action updates the local tables **and** inserts its outbox row **in one SQLite transaction**, along with any counter it uses. Only after that commits do you print, show "done" or navigate.
- **Online-only actions** call direct endpoints, but only when online and **only after the outbox has fully drained**:
  - passcode void (`DELETE /tickets/{id}/items/{id}`)
  - merge
  - refund request/approve/reject
  - receipt history/reprint
  - shift close

  Offline these buttons are disabled with "Needs the server". So are sign-out and switching users.

### Never

- Delete or rewrite an outbox row except on a server result (or a manager's deliberate discard).
- Generate a new action `id` or `*_uuid` on retry. Ids are made once, when the action is created (`expo-crypto` `randomUUID()`).
- Have two `/sync` requests in flight, or send the outbox out of `seq` order.
- Call an online-only endpoint while the outbox holds actions.
- Clear the outbox on `401`, sign-out or "reset". On `401`, show the login screen and keep everything.
- Print before the action is committed to SQLite.

### Sync loop essentials

- `drain()` is a single-flight loop: oldest 200 actions + `pending` count.
  - Network error, timeout or `5xx`: keep everything; retry with backoff 2 s, 5 s, 10 s, 30 s, then every 30 s.
  - Results come back in send order and are applied in that order.
- Run `drain()`:
  - after every saved action;
  - when the network returns;
  - on app start;
  - as a **30–60 s heartbeat** even when empty (`actions: []`, `pending: 0`). The heartbeat is what lets a shift close.
- `applyResult` by `status`:
  - `applied` / `applied_with_issue`: delete the outbox row and store the server's ids, `order_number`, final `customer_name` and `receipt_number`.
  - `rejected`: delete the outbox row. If the action was online, show `message` and undo it locally. If it was offline, show a notice and mark the record "not on server".
- **"Online"** means the server answered recently (`GET /up` or the last sync), not "Wi-Fi is on". Show a banner like "Offline — N sales waiting".
- **`offline` flag:** true if the action happened without the server knowing. An online action stuck for 5–10 s is flipped to `offline: true` along with **every waiting action after it**. Then:
  - print a kitchen slip for any food in them;
  - give any payment an offline receipt number and print the receipt.
- **Build `data` at send time** from the row's current `offline` flag:
  - `unit_price`: sent only for Fee/Custom items online; always sent offline.
  - `receipt_number`: sent only offline.
- **Refs:** use `*_uuid` for things this phone created and the server `*_id` for things from the snapshot.
- **Snapshot** (`GET /sync/snapshot`):
  - Refresh it on start, after reconnecting, every few minutes while online, and after a shift opens or closes.
  - Rewrite the menu tables only when `menu_version` changes.
  - Always take the latest `available_stock`, `shift`, `open_tickets` and `server_time`.

---

## Numbering and time

- `clock_offset_ms = server_time − Date.now()`, updated from every snapshot and sync response.
- `happened_at = now + clock_offset_ms`, sent as ISO-8601 with `+08:00` on every action.
- **Device code** (`P3`) comes from login/snapshot `device.code`. Store it.
- **Offline order label:** `{code}-{NNN}` (`P3-007`), sent as `offline_label` in `ticket.create`. After sync, display `#012 (P3-007)`.
- **Offline receipt number:** `REC-{YYYY-MM-DD}-{code}-{NNN}`. `NNN` restarts each **Manila** day. The server keeps it exactly as printed.
- Increment counters inside the same SQLite transaction as the action that uses them.

---

## Money (must match the server to the centavo)

- Work in **integer centavos** internally.
  - The API sends database money as **decimal strings** (`"175.00"`) and computed values as numbers. Parse both.
  - Always send amounts as numbers.
- Totals:
  ```
  modifier price = is_stockless_variant ? 0 : price_modifier
  line_total     = (unit_price + Σ modifier prices) × quantity
  subtotal       = Σ line_total (non-voided lines)
  discount       = discount_percent > 0 ? round(subtotal × percent / 100) : discount_amount
  total          = max(0, subtotal − discount)
  ```
- Payments must add up to `total` exactly.
  - Cash: `change = tendered − amount`.
  - GCash: a `payment_reference` is required; no tendered amount or change.
  - Split payment = cash + GCash **by amount**, never by item.
- **Split payment receipts:** one receipt per payment, each listing all items. Every payment except the last gets `floor(discount × amount ÷ total)` of the discount; the last gets the remainder.
- **₱0 total (comp):** exactly one charge with `amount: 0`.
- Sending a discount replaces both fields. Remove it with `{ discount_amount: 0 }`.

---

## Business rules the UI must respect

| Rule | Detail |
|---|---|
| **Item status** | `available` = orderable; `unavailable` = shown greyed out, not orderable; `hidden` never arrives |
| **Required modifiers** | A group with `is_required` needs a pick before the item is added |
| **Special items** | Category `type: "special"` → a "Specials" section. `entry_mode`: `fixed` adds as-is; `price` (Fee) means the cashier types an amount; `name_price` (Custom) means the cashier types a name and an amount |
| **Stockless variant** (e.g. "Lagi") | Always ₱0. Takes no stock, even at 0 left. **Never printed on the receipt**, always printed on the kitchen slip |
| **Notes** | Kitchen only: on the kitchen slip, **never on the receipt** |
| **Stock** | Show `available_stock` (`null` = untracked) and lower it locally as you sell. Online: a `409` for stock removes the line. Offline: at 0, warn but allow |
| **Quantity** | Minimum 1. Removing a line is a void: online, a manager passcode; offline, a typed reason (`ticket.void_item`) |
| **Customer names** | The server de-duplicates (john → john2). Always show the returned `customer_name` |
| **Ticket access** | A cashier sees only tickets they opened; a manager/admin sees all. `terminal_id` is just a label |
| **Shared account** | Several phones may share one cashier login. During an outage, finish each order on the phone that has it |
| **Cash entries** | Any role can add, edit or delete additions/expenses |
| **"Charge"** | Always means a payment. Never use the word for fees or custom items |

---

## HTTP conventions

- Send `Accept: application/json` and `Authorization: Bearer <token>`. The base URL is a **setting**, never a constant and never `localhost`.
- Response envelope:
  - Success: `{ success: true, data, meta? }`
  - Error: `{ success: false, message, errors? }` (`errors` only with `422`)
- How to handle each status:
  - `401`: show login and keep the outbox.
  - `403`, `404`, `409`: show `message`.
  - `422`: show the field errors.
  - `429`: honour `Retry-After`.
  - `5xx` or timeout: treat as offline.
- The token never expires (only a manager revokes it). Store it in SecureStore.
- `device_name` at login is a stable terminal name (e.g. `POS-01`), also used as `terminal_id`.

---

## Printing (PT-210, 58 mm)

- **Receipt**, one per payment:
  - Online: print the `payload` from the `ticket.charge` result.
  - Offline: build the same layout locally, using the offline receipt number.
  - No restaurant name or address.
  - Reprint adds a **DUPLICATE RECEIPT** watermark.
- **Kitchen slip:** **offline only**, when items are added. Include the label, customer, order type, time, every modifier (including Lagi) and the notes.
- **Cancel slip:** for a line voided offline after its slip printed ("CANCEL: 1× Burger — P3-007").
- Printer off or out of paper: show the receipt on screen with "Print again". The sale is already saved.

---

## Development

- Run the server so phones can reach it:
  - `php artisan serve --host=0.0.0.0 --port=8000`
  - `php artisan reverb:start` (port 8080)
  - Open ports 8000 and 8080 in Windows Firewall.
- Use the PC's IPv4 from `ipconfig` as the base URL. Check `http://<pc-ip>:8000/up` in the phone's browser first.
- Start the app: `npx expo start --dev-client`.
- On the Android emulator, the PC's own server is at `http://10.0.2.2:8000`. A real phone uses the PC's LAN IP.
- TypeScript strict mode. No `any` on API types: model each response.
- **Tests:** unit-test everything in `src/domain/` with Jest, plus the outbox/sync logic with a mocked `fetch`. Money math, discount proration, numbering, Manila day rollover and `applyResult` all need tests.
- **Before calling sync work done**, walk the manual outage scenarios in `POS_APP_GUIDE.md` §16:
  - mid-order outage
  - app killed offline
  - two phones selling the last item
  - lost reply
  - wrong phone clock
  - shift opened offline
  - close blocked by pending actions
  - money edge cases
- Don't commit. The user commits and writes their own messages.
