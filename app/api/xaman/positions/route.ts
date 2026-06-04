import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

export async function GET(req: NextRequest) {
  try {
    const walletRaw = req.nextUrl.searchParams.get("wallet")
    if (!walletRaw) return NextResponse.json({ error: "wallet required" }, { status: 400 })

    const walletLower = walletRaw.toLowerCase()
    const walletOriginal = walletRaw

    const [deposits, withdrawals, loans] = await Promise.all([
      prisma.xamanDeposit.findMany({
        where: { wallet: { in: [walletLower, walletOriginal] } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.xamanWithdrawal.findMany({
        where: { wallet: { in: [walletLower, walletOriginal] } },
        orderBy: { requestedAt: "desc" },
      }),
      prisma.xamanLoan.findMany({
        where: {
          wallet: { in: [walletLower, walletOriginal] },
          status: "active"
        },
        orderBy: { createdAt: "desc" },
      }),
    ])

    console.log("[positions] wallet:", walletRaw, "deposits:", deposits.length, "loans:", loans.length)

    return NextResponse.json({ deposits, withdrawals, loans })
  } catch (err) {
    console.error("[positions GET]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
