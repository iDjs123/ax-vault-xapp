import { NextRequest, NextResponse } from "next/server";
import { XummSdk } from "xumm-sdk";

const xumm = new XummSdk(process.env.XUMM_API_KEY!, process.env.XUMM_API_SECRET!);

export async function POST(req: NextRequest) {
  try {
    const { uuid } = await req.json();
    if (!uuid) return NextResponse.json({ error: "Missing uuid" }, { status: 400 });

    const status = await xumm.payload.get(uuid);
    if (!status) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json({
      signed: status.meta.signed,
      cancelled: status.meta.cancelled,
      expired: status.meta.expired,
      resolved: status.meta.resolved,
      opened: status.meta.opened,
      account: status.response?.account ?? null,
      txid: status.response?.txid ?? null,
    });
  } catch (err) {
    console.error("[status]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
