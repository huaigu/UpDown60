'use client';

import React, { createContext, useContext, useMemo, useState } from 'react';
import type { Eip1193Provider } from 'ethers';
import {
  useAppKit,
  useAppKitAccount,
  useAppKitNetwork,
  useAppKitProvider,
  useDisconnect,
} from '@reown/appkit/react';
import { initializeFheInstance, createEncryptedInput, decryptValue } from '../../src/lib/fhevmInstance';

// Create a comprehensive context that includes all wagmi-like hooks
interface FhevmContextType {
  // Wallet
  address: string;
  isConnected: boolean;
  chainId: number;
  isConnecting: boolean;
  walletError: string;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  walletProvider?: Eip1193Provider;
  
  // FHEVM
  fheInstance: any;
  isInitialized: boolean;
  error: string;
  initialize: () => Promise<void>;
  
  // Contract
  contract: any;
  isContractReady: boolean;
  contractError: string;
  
  // Operations
  encrypt: (contractAddress: string, userAddress: string, value: number) => Promise<any>;
  decrypt: (handle: string, contractAddress: string, signer: any) => Promise<number>;
  executeTransaction: (contract: any, method: string, encryptedData: string, proof: string, ...args: any[]) => Promise<any>;
  isBusy: boolean;
  message: string;
}

const FhevmContext = createContext<FhevmContextType | undefined>(undefined);

export function FhevmProvider({ children }: { children: React.ReactNode }) {
  const { open } = useAppKit();
  const { disconnect: disconnectAppKit } = useDisconnect();
  const { address, isConnected, status } = useAppKitAccount({ namespace: 'eip155' });
  const { chainId: appKitChainId } = useAppKitNetwork();
  const { walletProvider } = useAppKitProvider<Eip1193Provider>('eip155');
  const [walletError, setWalletError] = useState<string>('');
  const [fheInstance, setFheInstance] = useState<any>(null);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string>('');
  const chainId = useMemo(() => {
    if (typeof appKitChainId === 'number') return appKitChainId;
    if (typeof appKitChainId === 'string') {
      const rawValue = appKitChainId.includes(':')
        ? appKitChainId.split(':').pop() ?? ''
        : appKitChainId;
      const parsed = Number(rawValue);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }, [appKitChainId]);
  const isConnecting = status === 'connecting' || status === 'reconnecting';

  // Connect wallet
  const connect = async () => {
    try {
      setWalletError('');
      await open({ view: 'Connect', namespace: 'eip155' });
    } catch (err: any) {
      setWalletError(err?.message || 'Wallet connection failed');
    }
  };

  // Disconnect wallet
  const disconnect = async () => {
    try {
      await disconnectAppKit({ namespace: 'eip155' });
      setWalletError('');
    } catch (err: any) {
      setWalletError(err?.message || 'Failed to disconnect wallet');
    }
  };

  // Initialize FHEVM
  const initialize = async () => {
    try {
      setError('');
      if (!walletProvider) {
        throw new Error('Wallet provider not found. Please connect a wallet.');
      }
      const instance = await initializeFheInstance(walletProvider);
      setFheInstance(instance);
      setIsInitialized(true);
    } catch (err: any) {
      setError(err.message);
      setIsInitialized(false);
    }
  };

  // Encrypt function
  const encrypt = async (contractAddress: string, userAddress: string, value: number) => {
    try {
      setIsBusy(true);
      setMessage('Encrypting...');
      const result = await createEncryptedInput(contractAddress, userAddress, value);
      setMessage('Encryption completed');
      return result;
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setIsBusy(false);
    }
  };

  // Decrypt function
  const decrypt = async (handle: string, contractAddress: string, signer: any) => {
    try {
      setIsBusy(true);
      setMessage('Decrypting...');
      const result = await decryptValue(handle, contractAddress, signer);
      setMessage('Decryption completed');
      return result;
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setIsBusy(false);
    }
  };

  // Execute transaction function
  const executeTransaction = async (contract: any, method: string, encryptedData: string, proof: string, ...args: any[]) => {
    try {
      setIsBusy(true);
      setMessage('Executing transaction...');
      const tx = await contract[method](encryptedData, proof, ...args);
      setMessage('Transaction executed');
      return tx;
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setIsBusy(false);
    }
  };

  const contextValue: FhevmContextType = {
    // Wallet
    address: address || '',
    isConnected,
    chainId,
    isConnecting,
    walletError,
    connect,
    disconnect,
    walletProvider,
    
    // FHEVM
    fheInstance,
    isInitialized,
    error,
    initialize,
    
    // Contract
    contract: null,
    isContractReady: false,
    contractError: '',
    
    // Operations
    encrypt,
    decrypt,
    executeTransaction,
    isBusy,
    message,
  };

  return (
    <FhevmContext.Provider value={contextValue}>
      {children}
    </FhevmContext.Provider>
  );
}

export function useFhevm() {
  const context = useContext(FhevmContext);
  if (context === undefined) {
    throw new Error('useFhevm must be used within a FhevmProvider');
  }
  return context;
}
