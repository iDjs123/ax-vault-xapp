import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AX Vault",
  description: "XRPL Earn & Loans xApp for Xaman",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
