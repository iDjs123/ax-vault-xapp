import { NextRequest, NextResponse } from "next/server";
import { XummSdk } from "xumm-sdk";
import { prisma } from "@/lib/prisma";

const xumm = new XummSdk(process.env.XUMM_API_KEY!, process.env.XUMM_API_SECRET!);

// Destino XRP master (todas las redes)
const MASTER_DESTINATION = process.env.XRP_DESTINATION ?? "rnTMMN1aMDSFyYJAbVjfcVbvtvW4kb7re8";
const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

export async function POST(req: NextRequest) {
  try {
    const {
      wallet,
      amount,
      asset,
      // Appaman-specific
      lockMonths,
      isLoan,
      loanAmount,
      isRepayment,
      loanId,
      // Platform-specific
      platformSlug,
    } = await req.json();

    console.log("[deposit] asset:", asset, "amount:", amount, "wallet:", wallet, "platformSlug:", platformSlug);

    if (!wallet || !amount || Number(amount) <= 0) {
      return NextResponse.json({ error: "Invalid params" }, { status: 400 });
    }

    // ── Determinar si es un depósito de plataforma o appaman ─────────────
    const isPlatformDeposit = !!platformSlug;

    let instruction: string;
    let destinationTag: number | undefined;

    if (isPlatformDeposit) {
      // Depósito de plataforma: buscar el tenant para obtener su destination tag
      const platform = await prisma.platform.findUnique({
        where: { slug: platformSlug },
        select: { destinationTag: true },
      });

      instruction = "platform_deposit";
      destinationTag = platform?.destinationTag ?? undefined;

      console.log(`[deposit] PLATFORM deposit for ${platformSlug}, tag=${destinationTag}`);
    } else {
      // Depósito appaman (app independiente)
      instruction = isLoan
        ? "appaman_loan"
        : isRepayment
        ? "appaman_repayment"
        : "appaman_deposit";

      console.log(`[deposit] APPAMAN deposit, instruction=${instruction}`);
    }

    // ── Construir el amount del XRPL ─────────────────────────────────────
    const txAmount =
      asset === "XRP"
        ? String(Math.floor(Number(amount) * 1_000_000))
        : {
            currency: "524C555344000000000000000000000000000000",
            issuer: RLUSD_ISSUER,
            value: String(amount),
          };

    console.log("[deposit] txAmount:", JSON.stringify(txAmount));

    // ── Crear payload Xaman ───────────────────────────────────────────────
    const payload = await xumm.payload.create({
      txjson: {
        TransactionType: "Payment",
        Account: wallet,
        Destination: MASTER_DESTINATION,
        Amount: txAmount,
        // DestinationTag es obligatorio para identificar el tenant
        ...(destinationTag != null ? { DestinationTag: destinationTag } : {}),
      },
      options: { submit: true },
      custom_meta: {
        instruction,
        blob: JSON.stringify({
          wallet,
          asset,
          amount,
          platformSlug: platformSlug ?? null,
          lockMonths: lockMonths ?? 0,
          apy: 3.0,
          isLoan: isLoan ?? false,
          loanAmount: loanAmount ?? 0,
          isRepayment: isRepayment ?? false,
          loanId: loanId ?? null,
        }),
      },
    } as any);

    if (!payload) return NextResponse.json({ error: "Failed to create payload" }, { status: 500 });

    return NextResponse.json({
      uuid:     payload.uuid,
      qr:       payload.refs.qr_png,
      signUrl:  payload.next.always,
      deeplink: payload.next.always,
    });
  } catch (err) {
    console.error("[deposit]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
