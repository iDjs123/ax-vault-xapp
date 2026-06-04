import { NextResponse } from "next/server";
import { XummSdk } from "xumm-sdk";

const xumm = new XummSdk(process.env.XUMM_API_KEY!, process.env.XUMM_API_SECRET!);

export async function GET() {
  try {
    const payload = await xumm.payload.create({ txjson: { TransactionType: "SignIn" } });
    if (!payload) return NextResponse.json({ error: "Failed" }, { status: 500 });
    return NextResponse.json({ uuid: payload.uuid, qr: payload.refs.qr_png, deeplink: payload.next.always });
  } catch (err) {
    console.error("[connect]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
