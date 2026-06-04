import { NextResponse } from "next/server"

const XRPL_RPC = "https://xrplcluster.com"
const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"
const RLUSD_HEX = "524C555344000000000000000000000000000000"
// XRP reserve base: 10 XRP (owner reserve ignored for simplicity)
const XRP_BASE_RESERVE = 10

async function rpc(method: string, params: object) {
  const res = await fetch(XRPL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
    next: { revalidate: 0 },
  })
  return res.json()
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const wallet = searchParams.get("wallet")
  if (!wallet) return NextResponse.json({ xrp: 0, rlusd: 0 })

  try {
    const [infoRes, linesRes] = await Promise.all([
      rpc("account_info", { account: wallet, ledger_index: "current" }),
      rpc("account_lines", { account: wallet, ledger_index: "current", limit: 400 }),
    ])

    // XRP: drops ÷ 1_000_000 − base reserve
    const drops = Number(infoRes.result?.account_data?.Balance ?? 0)
    const xrp = Math.max(0, drops / 1_000_000 - XRP_BASE_RESERVE)

    // RLUSD: match by issuer + hex currency code (or plain "RLUSD")
    const lines: any[] = linesRes.result?.lines ?? []
    const rlusdLine = lines.find(
      (l) =>
        l.account === RLUSD_ISSUER &&
        (l.currency === RLUSD_HEX || l.currency === "RLUSD")
    )
    const rlusd = Math.max(0, Number(rlusdLine?.balance ?? 0))

    return NextResponse.json({ xrp, rlusd })
  } catch {
    return NextResponse.json({ xrp: 0, rlusd: 0 })
  }
}
