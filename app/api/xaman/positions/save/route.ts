import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const wallet = String(body.wallet ?? "").toLowerCase();
    const { asset, amount, lockMonths, apy, txid, endDate } = body;

    if (!wallet || !asset || !amount || !txid) {
      return NextResponse.json({ error: "Invalid params" }, { status: 400 });
    }

    const existing = await prisma.xamanDeposit.findUnique({ where: { txid } });
    if (existing) {
      return NextResponse.json({ ok: true, deposit: existing });
    }

    await prisma.xamanWallet.upsert({
      where: { wallet },
      update: {},
      create: { wallet },
    });

    const deposit = await prisma.xamanDeposit.create({
      data: {
        wallet,
        asset,
        amount: Number(amount),
        lockMonths: Number(lockMonths ?? 0),
        apy: Number(apy ?? 3.0),
        txid,
        endDate: endDate ? new Date(endDate) : null,
        status: "active",
      },
    });

    return NextResponse.json({ ok: true, deposit });
  } catch (err) {
    console.error("[positions/save]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
