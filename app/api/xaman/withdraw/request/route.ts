import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendWithdrawRequestedToAdmin } from "@/lib/email";

const VALID_NETWORKS = ["xrp", "evm", "solana", "btc"] as const;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { wallet, asset, amount, network, destinationAddress, notifyEmail, platformSlug } = body;

    const numericAmount = parseFloat(amount);

    if (!wallet || !asset || isNaN(numericAmount) || numericAmount <= 0) {
      return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
    }

    if (!network || !VALID_NETWORKS.includes(network)) {
      return NextResponse.json(
        { error: "network debe ser: xrp | evm | solana | btc" },
        { status: 400 }
      );
    }

    if (!destinationAddress || destinationAddress.trim().length < 10) {
      return NextResponse.json({ error: "destinationAddress es obligatorio" }, { status: 400 });
    }

    if (notifyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail)) {
      return NextResponse.json({ error: "Formato de email inválido" }, { status: 400 });
    }

    // ── Buscar plataforma (slug del body, o primera disponible) ──────────────
    const slug = typeof platformSlug === "string" && platformSlug ? platformSlug : null
    const platform = slug
      ? await prisma.platform.findUnique({ where: { slug } })
      : await prisma.platform.findFirst()

    if (!platform) {
      return NextResponse.json({ error: "Plataforma no encontrada" }, { status: 404 });
    }

    // ── Buscar usuario por wallet (case-insensitive) + plataforma ────────────
    const walletNorm = wallet.toLowerCase()
    let user = await prisma.user.findFirst({
      where: {
        wallet: { equals: walletNorm, mode: "insensitive" },
        platformId: platform.id,
      },
    })

    // Si no existe → crear automáticamente (usuarios de xApp solo tienen wallet)
    if (!user) {
      user = await prisma.user.create({
        data: { wallet: walletNorm, platformId: platform.id },
      })
    }

    // ── Crear solicitud de retiro (sin validar UserAsset — el admin verifica) ─
    const withdrawRequest = await prisma.withdrawRequest.create({
      data: {
        userId: user.id,
        asset,
        amount: numericAmount,
        network,
        destinationAddress: destinationAddress.trim(),
        notifyEmail: notifyEmail?.trim() || null,
        status: "pending",
      },
      include: { user: { include: { platform: true } } },
    });

    // Notificar al admin (no bloqueante)
    sendWithdrawRequestedToAdmin({
      id: withdrawRequest.id,
      userWallet: wallet,
      platformSlug: withdrawRequest.user.platform.slug,
      asset,
      amount: numericAmount,
      network,
      destinationAddress: destinationAddress.trim(),
      notifyEmail: notifyEmail?.trim() || null,
      createdAt: withdrawRequest.createdAt,
    });

    return NextResponse.json({ success: true, id: withdrawRequest.id });

  } catch (error) {
    console.error("Withdraw request error:", error);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
