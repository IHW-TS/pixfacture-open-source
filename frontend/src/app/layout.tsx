import "./globals.css";
import localFont from "next/font/local";
import "../sentry.server";
import "../sentry.client";
import { ROOT_METADATA } from "@/lib/metadata";

export const metadata = ROOT_METADATA;

const manrope = localFont({
  src: [{ path: "../assets/fonts/manrope-latin.woff2", weight: "400 700", style: "normal" }],
  variable: "--font-manrope",
  display: "swap",
});

const sora = localFont({
  src: [{ path: "../assets/fonts/sora-latin.woff2", weight: "500 800", style: "normal" }],
  variable: "--font-sora",
  display: "swap",
});

const inter = localFont({
  src: [{ path: "../assets/fonts/inter-latin.woff2", weight: "400 800", style: "normal" }],
  variable: "--font-inter",
  display: "swap",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${manrope.variable} ${sora.variable} ${inter.variable}`}>
      <body>
        <a className="skip-link" href="#main-content">
          Aller au contenu principal
        </a>
        {children}
      </body>
    </html>
  );
}
