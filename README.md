# AX Vault xApp

**XRPL Earn & Loans xApp for Xaman**

A native [Xaman](https://xaman.app) xApp that lets XRPL users deposit XRP and RLUSD into a yield vault, request withdrawals, and take collateralized loans — all without leaving the Xaman wallet.

Live at: [asvexo.com/xapp](https://asvexo.com/xapp)

---

## How it works

1. **Connect** — The xApp auto-detects the Xaman runtime and reads the user's XRPL account. In a regular browser it shows a QR code to connect via Xaman.

2. **Deposit** — User selects an asset (XRP or RLUSD), a lock period (Flexible / 1M / 3M / 6M / 12M), and an amount. A Xaman payment payload is created server-side and presented as a native sign request (inside Xaman) or QR code (in browser). Deposits earn **3% APY**.

3. **Positions** — After a deposit is confirmed on-chain, the position is stored in the database. The xApp polls every 10 seconds to keep balances and interest up to date.

4. **Withdraw** — Withdrawals are processed manually by the vault operator within 24–48 hours. The user submits a request (no on-chain signature needed); the operator approves and executes via the admin panel.

5. **Loans** — Users can borrow up to **75% LTV** against RLUSD collateral. Interest accrues at **8% APY** calculated daily. Minimum holding period: 30 days.

---

## Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 16](https://nextjs.org) (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Wallet SDK | [Xumm SDK](https://xumm.readme.io) / [xumm](https://npmjs.com/package/xumm) |
| Database | PostgreSQL via [Prisma](https://prisma.io) |
| Email | [Resend](https://resend.com) |
| XRPL RPC | [xrplcluster.com](https://xrplcluster.com) |

---

## Project structure

```
app/
  xapp/
    page.tsx          # Main xApp UI (single-page, tabbed)
    layout.tsx        # Minimal layout wrapper
  api/
    xaman/
      connect/        # GET — create SignIn payload (QR flow)
      status/         # POST — poll payload status
      deposit/        # POST — create Payment payload
      xrpl-balance/   # GET — query account_info + account_lines
      positions/      # GET — load deposits, withdrawals, loans from DB
      positions/save/ # POST — persist confirmed deposit
      withdraw/
        request/      # POST — create withdrawal request (no signature)
        cancel/       # POST — cancel pending withdrawal request
lib/
  prisma.ts           # Prisma client singleton
  email.ts            # Resend email notifications
prisma/
  schema.prisma       # Database schema (Xaman models + minimal Platform/User)
```

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/sergiofortuar-maker/ax-vault-xapp
cd ax-vault-xapp
npm install
```

### 2. Environment variables

```bash
cp .env.example .env.local
```

Fill in your values (see `.env.example`):

- **`XUMM_API_KEY` / `XUMM_API_SECRET`** — from [developer.xumm.app](https://developer.xumm.app). Create an xApp and set the xApp URL to `https://yourdomain.com/xapp`.
- **`NEXT_PUBLIC_XUMM_API_KEY`** — same API key (exposed to the browser for the Xumm JS SDK).
- **`XRP_DESTINATION`** — your XRPL custody wallet address.
- **`DATABASE_URL` / `DIRECT_URL`** — PostgreSQL connection strings.
- **`RESEND_API_KEY`** — for withdrawal notification emails (optional).

### 3. Database

```bash
npx prisma migrate dev --name init
# or push the schema directly:
npx prisma db push
```

### 4. Run

```bash
npm run dev
# → http://localhost:3000/xapp
```

---

## Xaman Developer Console configuration

| Field | Value |
|---|---|
| xApp URL | `https://yourdomain.com/xapp` |
| App name | AX Vault |
| Permissions | `SignIn`, `Payment` |

---

## License

MIT
