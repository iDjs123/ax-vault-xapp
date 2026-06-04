import { Resend } from "resend";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@yourdomain.com";
const FROM_NOREPLY = process.env.FROM_EMAIL ?? "noreply@yourdomain.com";
const BRAND = "AX Vault";

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

async function send(payload: Parameters<Resend["emails"]["send"]>[0]): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.warn("RESEND_API_KEY not set — email skipped:", payload.subject);
    return;
  }
  try {
    await resend.emails.send(payload);
  } catch (err) {
    console.error("Email send error:", err);
  }
}

export interface WithdrawEmailData {
  id: string;
  userWallet: string | null;
  platformSlug: string;
  asset: string;
  amount: number;
  network: string;
  destinationAddress: string | null;
  notifyEmail?: string | null;
  createdAt: Date | string;
}

export async function sendWithdrawRequestedToAdmin(data: WithdrawEmailData): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  await send({
    from: FROM_NOREPLY,
    to: ADMIN_EMAIL,
    subject: `[${BRAND}] New withdrawal request — ${data.amount} ${data.asset}`,
    html: `
      <h2>New withdrawal request pending</h2>
      <p><strong>ID:</strong> ${data.id}</p>
      <p><strong>Wallet:</strong> ${data.userWallet ?? "—"}</p>
      <p><strong>Amount:</strong> ${data.amount} ${data.asset}</p>
      <p><strong>Network:</strong> ${data.network.toUpperCase()}</p>
      <p><strong>Destination:</strong> ${data.destinationAddress ?? "—"}</p>
      <p><strong>Requested:</strong> ${new Date(data.createdAt).toLocaleString()}</p>
      <p><a href="${baseUrl}/admin/withdraws">View admin panel →</a></p>
    `,
  });
}
