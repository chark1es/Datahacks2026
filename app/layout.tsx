import type { Metadata } from "next";
import { Literata, Oxanium } from "next/font/google";
import "./globals.css";

const display = Oxanium({
  subsets: ["latin"],
  variable: "--font-display-fallback",
  display: "swap",
});

const body = Literata({
  subsets: ["latin"],
  variable: "--font-body-fallback",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DataHacks UCSD — Ground motion timeline",
  description:
    "Explore LOH PGV scenarios: the road is the scenario index; motion comes from the dataset only.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
