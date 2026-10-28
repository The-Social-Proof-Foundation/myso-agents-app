import type { Metadata } from "next";
import localFont from "next/font/local";
import { ThemeProvider } from "next-themes";
import { MySoWalletProviders } from "@/components/myso-wallet-providers";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./myso.css";
const body = localFont({ src: "../public/fonts/space-grotesk-latin-wght-normal.woff2", weight: "300 700", variable: "--font-myso-body", display: "swap" });
const display = localFont({ src: "../public/fonts/chakra-petch-latin-600-normal.woff2", weight: "600", variable: "--font-myso-display", display: "swap" });
const brand = localFont({ src: "../public/fonts/chakra-petch-latin-400-normal.woff2", weight: "400", variable: "--font-myso-brand", display: "swap" });
export const metadata: Metadata = { title: "MySo Agents", description: "Coordinate work, agents, encrypted rooms and private knowledge access on MySo." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
    return <html lang="en" suppressHydrationWarning className={`${body.variable} ${display.variable} ${brand.variable}`}><body><ThemeProvider attribute="class" defaultTheme="system" enableSystem><MySoWalletProviders>{children}</MySoWalletProviders></ThemeProvider></body></html>;
}
