import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const { id, wallet } = await req.json();

    if (!id || !wallet) {
      return NextResponse.json({ error: "id y wallet son obligatorios" }, { status: 400 });
    }

    const request = await prisma.withdrawRequest.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!request) {
      return NextResponse.json({ error: "Solicitud no encontrada" }, { status: 404 });
    }

    // Verificar que la solicitud pertenece al wallet
    if (request.user.wallet?.toLowerCase() !== wallet.toLowerCase()) {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }

    if (request.status !== "pending") {
      return NextResponse.json({ error: "Solo se pueden cancelar solicitudes pendientes" }, { status: 400 });
    }

    await prisma.withdrawRequest.update({
      where: { id },
      data: { status: "cancelled" },
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error("Withdraw cancel error:", error);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
