import type { Metadata } from 'next'
import Script from 'next/script'
import { FhevmProvider } from './providers/FhevmProvider'
import './globals.css'

export const metadata: Metadata = {
  title: 'BTCUPDOWN60',
  description: 'Encrypted BTC up/down prediction market demo on FHEVM (60-min rounds).',
  icons: {
    icon: '/favicon.svg',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <Script
          src="https://cdn.zama.org/relayer-sdk-js/0.3.0-5/relayer-sdk-js.umd.cjs"
          strategy="beforeInteractive"
        />
        <FhevmProvider>
          {children}
        </FhevmProvider>
      </body>
    </html>
  )
}
