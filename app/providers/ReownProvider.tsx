'use client';

import type { ReactNode } from 'react';
import { AppKitProvider } from '@reown/appkit/react';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';
import { sepolia } from '@reown/appkit/networks';

const APP_NAME = 'BTCUPDOWN60';
const APP_DESCRIPTION =
  'Encrypted BTC up/down prediction market demo on FHEVM (60-min rounds).';
const SEPOLIA_CAIP_ID = 'eip155:11155111';
const SEPOLIA_PUBLIC_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.sepolia.org',
  'https://sepolia.drpc.org',
];

export function ReownProvider({ children }: { children: ReactNode }) {
  const projectId = '282af44566ab08206737bfd82bb57b6a';
  const appUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const metadata = {
    name: APP_NAME,
    description: APP_DESCRIPTION,
    url: appUrl,
    icons: [`${appUrl}/favicon.svg`],
  };

  return (
    <AppKitProvider
      adapters={[new EthersAdapter()]}
      networks={[sepolia]}
      defaultNetwork={sepolia}
      projectId={projectId}
      metadata={metadata}
      customRpcUrls={{
        [SEPOLIA_CAIP_ID]: SEPOLIA_PUBLIC_RPCS.map((url) => ({ url })),
      }}
    >
      {children}
    </AppKitProvider>
  );
}
