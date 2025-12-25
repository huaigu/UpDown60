'use client';

import { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import {
  createEncryptedInput,
  decryptMultipleHandles,
  fetchPublicDecryption,
  initializeFheInstance,
} from '../../src/lib/fhevmInstance';
import { useFhevm } from '../providers/FhevmProvider';

const CONTRACT_ADDRESSES: Record<number, string> = {
  31337: '0x0000000000000000000000000000000000000000',
  11155111: '0x0000000000000000000000000000000000000000',
};

const CONTRACT_ABI = [
  'function stakeAmount() view returns (uint64)',
  'function getCurrentRound() view returns (uint256)',
  'function getRoundHandles(uint256 roundId) view returns (bytes32,bytes32)',
  'function getPendingClaim(uint256 roundId, address user) view returns (bool,bytes32)',
  'function placeBet(uint256 roundId, bytes32 encryptedDirection, bytes proof) payable',
  'function finalizeRound(uint256 roundId)',
  'function requestRoundReveal(uint256 roundId)',
  'function resolveTotalsCallback(uint256 roundId, bytes cleartexts, bytes proof)',
  'function requestClaim(uint256 roundId)',
  'function claimCallback(uint256 roundId, bytes cleartexts, bytes proof)',
];

const ROUND_SECONDS = 300;
const SEPOLIA_CHAIN_ID = 11155111;
const SEPOLIA_CONFIG = {
  chainId: '0xaa36a7',
  chainName: 'Sepolia',
  nativeCurrency: {
    name: 'Sepolia Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  rpcUrls: ['https://sepolia.infura.io/v3/'],
  blockExplorerUrls: ['https://sepolia.etherscan.io/'],
};
const STAKE_ETH = '0.01';
const LOCAL_SUBMISSIONS_KEY = 'btcUpDownLocalSubmissions';

const formatAddress = (value: string) => {
  if (!value) return '';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

type LocalSubmission = {
  id: string;
  roundId: number;
  direction: 'up' | 'down';
  timestamp: number;
  address?: string;
};

export default function BtcUpDownPage() {
  const {
    connect,
    isConnected,
    isConnecting,
    address,
    isInitialized,
    initialize,
    walletError,
    error,
    chainId,
  } = useFhevm();
  const [isInitializing, setIsInitializing] = useState(false);
  const [isSwitchingNetwork, setIsSwitchingNetwork] = useState(false);
  const [networkError, setNetworkError] = useState('');
  const [localSubmissions, setLocalSubmissions] = useState<LocalSubmission[]>([]);
  const [blockTimestamp, setBlockTimestamp] = useState<number | null>(null);
  const [blockFetchedAt, setBlockFetchedAt] = useState<number | null>(null);
  const [clientNow, setClientNow] = useState(Date.now());
  const isOnSepolia = chainId === SEPOLIA_CHAIN_ID;
  const totalsRevealed = false;
  const poolValueText = totalsRevealed ? '14.5 ETH' : 'Pending reveal';
  const upOddsLabel = totalsRevealed ? '1.85x Payout' : 'Pending reveal';
  const downOddsLabel = totalsRevealed ? '2.10x Payout' : 'Pending reveal';
  const pendingRevealClass = totalsRevealed ? '' : 'font-black uppercase';

  useEffect(() => {
    document.body.classList.add('btc-updown-body');
    return () => {
      document.body.classList.remove('btc-updown-body');
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(LOCAL_SUBMISSIONS_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as LocalSubmission[];
      if (Array.isArray(parsed)) {
        setLocalSubmissions(parsed);
      }
    } catch (err) {
      console.warn('Failed to parse local submissions cache', err);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LOCAL_SUBMISSIONS_KEY, JSON.stringify(localSubmissions));
  }, [localSubmissions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClientNow(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isConnected || typeof window === 'undefined' || !window.ethereum) return;
    let isActive = true;
    const fetchBlockTime = async () => {
      try {
        const latestBlock = await window.ethereum.request({
          method: 'eth_getBlockByNumber',
          params: ['latest', false],
        });
        if (!isActive || !latestBlock?.timestamp) return;
        const timestamp = parseInt(latestBlock.timestamp, 16);
        setBlockTimestamp(timestamp);
        setBlockFetchedAt(Date.now());
      } catch (err) {
        console.warn('Failed to fetch latest block timestamp', err);
      }
    };

    fetchBlockTime();
    const interval = window.setInterval(fetchBlockTime, 10000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [isConnected]);

  useEffect(() => {
    if (!isConnected || isInitialized || isInitializing || !isOnSepolia) return;
    setIsInitializing(true);
    initialize().finally(() => {
      setIsInitializing(false);
    });
  }, [isConnected, isInitialized, isInitializing, initialize, isOnSepolia]);

  const ensureSepolia = async () => {
    if (!window.ethereum) {
      throw new Error('No wallet found');
    }
    const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
    if (parseInt(chainIdHex, 16) === SEPOLIA_CHAIN_ID) {
      return;
    }
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: SEPOLIA_CONFIG.chainId }],
      });
    } catch (switchError: any) {
      if (switchError?.code !== 4902) {
        throw switchError;
      }
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [SEPOLIA_CONFIG],
      });
    }
  };

  const handleLocalSubmit = (directionValue: 'up' | 'down') => {
    const targetRound = Math.floor(Date.now() / 1000 / ROUND_SECONDS) + 1;
    const newSubmission: LocalSubmission = {
      id: `${targetRound}-${Date.now()}`,
      roundId: targetRound,
      direction: directionValue,
      timestamp: Date.now(),
      address: address || undefined,
    };
    setLocalSubmissions((prev) => [newSubmission, ...prev].slice(0, 6));
  };

  const handleConnect = async () => {
    if (isConnecting || isInitializing || isSwitchingNetwork) return;
    setNetworkError('');
    try {
      setIsSwitchingNetwork(true);
      await ensureSepolia();
      await connect();
    } catch (err: any) {
      setNetworkError(err?.message || 'Failed to switch network');
    } finally {
      setIsSwitchingNetwork(false);
    }
  };

  const connectLabel = isSwitchingNetwork
    ? 'Switching...'
    : isConnected
      ? isInitialized
        ? 'Connected'
        : 'Initializing...'
      : isConnecting
        ? 'Connecting...'
        : 'Connect';

  const statusHint =
    walletError ||
    error ||
    networkError ||
    (address
      ? isOnSepolia
        ? `Wallet: ${address}`
        : 'Switch to Sepolia'
      : isInitialized
        ? 'FHEVM ready'
        : isConnected
          ? 'Initializing FHEVM...'
          : 'Connect wallet');
  const countdown = useMemo(() => {
    const fallbackTime = Math.floor(clientNow / 1000);
    const estimatedTime =
      blockTimestamp && blockFetchedAt
        ? blockTimestamp + Math.floor((clientNow - blockFetchedAt) / 1000)
        : fallbackTime;
    const secondsLeft = ROUND_SECONDS - (estimatedTime % ROUND_SECONDS || 0);
    const minutes = Math.floor(secondsLeft / 60);
    const seconds = secondsLeft % 60;
    return {
      minutesText: String(minutes).padStart(2, '0'),
      secondsText: String(seconds).padStart(2, '0'),
    };
  }, [blockTimestamp, blockFetchedAt, clientNow]);
  const displaySubmissions = localSubmissions.slice(0, 3);

  return (
    <div
      className="btc-updown-home bg-background-light min-h-screen flex flex-col overflow-x-hidden text-neo-black selection:bg-secondary selection:text-white"
      style={{
        backgroundImage: 'radial-gradient(#000 1px, transparent 1px)',
        backgroundSize: '20px 20px',
      }}
    >
      <style jsx global>{`
        body.btc-updown-body {
          font-family: 'Space Grotesk', sans-serif;
          background-color: #ffde59;
          background-image: radial-gradient(#000 1px, transparent 1px);
          background-size: 20px 20px;
        }
        body.btc-updown-body h1,
        body.btc-updown-body h2,
        body.btc-updown-body h3,
        body.btc-updown-body .font-display {
          font-family: 'Archivo Black', sans-serif;
        }
        body.btc-updown-body .font-mono {
          font-family: 'Space Grotesk', monospace;
        }
        body.btc-updown-body ::-webkit-scrollbar {
          width: 16px;
          background: #ffde59;
          border-left: 3px solid #000;
        }
        body.btc-updown-body ::-webkit-scrollbar-thumb {
          background: #000;
          border: 3px solid #ffde59;
        }
        body.btc-updown-body .text-outline {
          text-shadow: 2px 2px 0px #000;
        }
      `}</style>
      <header className="border-b-6 border-neo-black bg-white sticky top-0 z-50">
        <div className="px-6 py-5 flex flex-col md:flex-row items-center justify-between gap-6 max-w-[1440px] mx-auto w-full">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-neo-black flex items-center justify-center border-3 border-neo-black shadow-none -rotate-3">
              <span className="material-symbols-outlined text-primary text-4xl font-bold">query_stats</span>
            </div>
            <h1 className="text-4xl font-display tracking-tighter uppercase transform rotate-1">
              PREDICATE<span className="text-secondary">.MKT</span>
            </h1>
          </div>
          <nav className="hidden md:flex items-center gap-4">
            <a
              className="bg-white px-6 py-3 text-lg font-display uppercase border-3 border-neo-black shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
              href="#"
            >
              Markets
            </a>
            <a
              className="bg-white px-6 py-3 text-lg font-display uppercase border-3 border-neo-black shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
              href="#"
            >
              Leaderboard
            </a>
            <a
              className="bg-white px-6 py-3 text-lg font-display uppercase border-3 border-neo-black shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
              href="#"
            >
              Docs
            </a>
          </nav>
          <button
            className="flex items-center gap-3 bg-secondary text-white px-8 py-4 font-display text-lg uppercase border-3 border-neo-black shadow-neo hover:translate-x-[4px] hover:translate-y-[4px] hover:shadow-neo-hover active:translate-x-[8px] active:translate-y-[8px] active:shadow-none transition-all rotate-1"
            onClick={handleConnect}
            title={statusHint}
            type="button"
          >
            <span className="material-symbols-outlined text-[24px]">wallet</span>
            <span>{connectLabel}</span>
          </button>
        </div>
      </header>
      <div className="bg-neo-black border-b-6 border-neo-black overflow-hidden whitespace-nowrap py-3 flex items-center rotate-0">
        <div className="animate-marquee inline-block">
          <span className="mx-12 font-display text-2xl text-primary uppercase">
            BTC/USD $64,230.50 <span className="text-[#0bda0b]">(+1.2%)</span>
          </span>
          <span className="mx-12 font-display text-2xl text-white uppercase">
            ETH/USD $3,450.00 <span className="text-[#ff3333]">(-0.4%)</span>
          </span>
          <span className="mx-12 font-display text-2xl text-secondary uppercase">
            SOL/USD $145.20 <span className="text-[#0bda0b]">(+5.6%)</span>
          </span>
          <span className="mx-12 font-display text-2xl text-primary uppercase">
            BTC/USD $64,230.50 <span className="text-[#0bda0b]">(+1.2%)</span>
          </span>
          <span className="mx-12 font-display text-2xl text-white uppercase">
            ETH/USD $3,450.00 <span className="text-[#ff3333]">(-0.4%)</span>
          </span>
          <span className="mx-12 font-display text-2xl text-secondary uppercase">
            SOL/USD $145.20 <span className="text-[#0bda0b]">(+5.6%)</span>
          </span>
        </div>
      </div>
      <main className="flex-grow w-full max-w-[1440px] mx-auto p-6 md:p-10 grid grid-cols-1 lg:grid-cols-12 gap-10">
        <div className="lg:col-span-8 flex flex-col gap-10">
          <div className="border-6 border-neo-black bg-white p-8 shadow-neo relative rounded-2xl">
            <div className="absolute -top-6 -right-4 bg-secondary text-white font-display px-6 py-2 border-3 border-neo-black uppercase text-lg transform rotate-6 shadow-neo-sm z-10">
              Round #9284 Live
            </div>
            <div className="flex flex-col md:flex-row justify-between items-end gap-8">
              <div>
                <h2 className="bg-neo-black text-white inline-block px-2 py-1 text-sm font-display uppercase tracking-widest mb-4">
                  Next Round Closes In
                </h2>
                <div className="flex gap-4 items-end">
                  <div className="flex flex-col items-center">
                    <div className="bg-white border-4 border-neo-black px-6 py-4 text-6xl font-display shadow-neo-sm leading-none rounded-xl">
                      {countdown.minutesText}
                    </div>
                    <span className="text-sm font-bold uppercase mt-2 bg-primary px-2 border-2 border-neo-black">
                      Min
                    </span>
                  </div>
                  <span className="text-6xl font-display mb-8">:</span>
                  <div className="flex flex-col items-center">
                    <div className="bg-neo-black text-primary border-4 border-neo-black px-6 py-4 text-6xl font-display shadow-neo-sm leading-none rounded-xl">
                      {countdown.secondsText}
                    </div>
                    <span className="text-sm font-bold uppercase mt-2 bg-primary px-2 border-2 border-neo-black">
                      Sec
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-right bg-primary p-4 border-3 border-neo-black shadow-neo-sm -rotate-2 w-full md:w-auto rounded-xl">
                <p className="text-neo-black text-xs font-bold uppercase tracking-widest mb-1">
                  Total Pool Value
                </p>
                <p className={`text-5xl font-display text-neo-black ${pendingRevealClass}`}>
                  {poolValueText}
                </p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="border-5 border-neo-black bg-white p-6 flex flex-col justify-between group hover:-translate-y-1 hover:shadow-neo transition-all rounded-xl relative overflow-hidden">
              <div className="flex justify-between items-start mb-6 relative z-10">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 bg-primary rounded-full flex items-center justify-center border-4 border-neo-black">
                    <span className="material-symbols-outlined text-neo-black text-4xl">
                      currency_bitcoin
                    </span>
                  </div>
                  <span className="text-4xl font-display">BTC</span>
                </div>
                <span className="bg-[#0bda0b] text-white border-3 border-neo-black px-3 py-1 text-xl font-display uppercase transform rotate-2">
                  +1.2%
                </span>
              </div>
              <div className="relative z-10 bg-gray-100 p-4 border-3 border-neo-black rounded-lg">
                <p className="text-neo-black/60 text-sm font-bold uppercase mb-1">Current Price</p>
                <p className="text-4xl lg:text-5xl font-display tracking-tighter">$64,230.50</p>
              </div>
            </div>
            <div className="border-5 border-neo-black bg-secondary p-6 flex flex-col justify-between relative overflow-hidden shadow-neo rounded-xl">
              <div className="absolute -right-10 -bottom-10 opacity-30">
                <span className="material-symbols-outlined text-white text-[180px]">
                  show_chart
                </span>
              </div>
              <div className="flex justify-between items-start mb-6 relative z-10">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center border-4 border-neo-black">
                    <span className="material-symbols-outlined text-neo-black text-4xl">token</span>
                  </div>
                  <span className="text-4xl font-display text-white">ETH</span>
                </div>
                <span className="bg-white text-neo-black border-3 border-neo-black px-3 py-1 text-xl font-display uppercase transform -rotate-2">
                  -0.4%
                </span>
              </div>
              <div className="relative z-10 bg-white p-4 border-3 border-neo-black rounded-lg">
                <p className="text-neo-black/60 text-sm font-bold uppercase mb-1">Current Price</p>
                <p className="text-4xl lg:text-5xl font-display tracking-tighter">$3,450.00</p>
              </div>
            </div>
          </div>
          <div className="border-6 border-neo-black bg-white p-8 relative shadow-neo rounded-2xl">
            <div className="absolute -top-5 left-8 bg-neo-black text-white px-4 py-2 border-3 border-white transform -rotate-1 shadow-md z-10">
              <h3 className="text-2xl font-display uppercase flex items-center gap-2">
                Place Your Position
              </h3>
            </div>
            <div className="flex flex-col gap-8 mt-6">
              <div className="flex flex-col gap-3">
                <label className="text-lg font-display uppercase text-neo-black ml-1">
                  Wager Amount (ETH) - Fixed
                </label>
                <div className="flex relative group">
                  <input
                    className="w-full bg-gray-100 border-4 border-neo-black text-neo-black font-display text-4xl p-6 focus:ring-0 focus:border-secondary focus:bg-white placeholder-neo-black/20 rounded-xl"
                    readOnly
                    value={STAKE_ETH}
                    type="number"
                  />
                  <button
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-display bg-neo-black text-white px-4 py-2 border-2 border-transparent rounded-lg uppercase opacity-70 cursor-not-allowed"
                    disabled
                    type="button"
                  >
                    FIXED
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-8">
                <button
                  className="group relative bg-[#0bda0b] border-5 border-neo-black h-32 flex flex-col items-center justify-center shadow-neo active:shadow-none active:translate-x-[8px] active:translate-y-[8px] transition-all rounded-xl hover:bg-[#39ff39]"
                  onClick={() => handleLocalSubmit('up')}
                  type="button"
                >
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-neo-black text-5xl font-bold group-hover:-translate-y-2 transition-transform">
                      arrow_upward
                    </span>
                    <span className="text-neo-black font-display text-4xl uppercase tracking-tighter">Up</span>
                  </div>
                  <span
                    className={`bg-white px-2 border-2 border-neo-black text-neo-black text-sm font-bold uppercase mt-2 shadow-sm transform -rotate-2 ${pendingRevealClass}`}
                  >
                    {upOddsLabel}
                  </span>
                </button>
                <button
                  className="group relative bg-[#ff3333] border-5 border-neo-black h-32 flex flex-col items-center justify-center shadow-neo active:shadow-none active:translate-x-[8px] active:translate-y-[8px] transition-all rounded-xl hover:bg-[#ff5555]"
                  onClick={() => handleLocalSubmit('down')}
                  type="button"
                >
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-white text-5xl font-bold group-hover:translate-y-2 transition-transform">
                      arrow_downward
                    </span>
                    <span className="text-white font-display text-4xl uppercase tracking-tighter">Down</span>
                  </div>
                  <span
                    className={`bg-white px-2 border-2 border-neo-black text-neo-black text-sm font-bold uppercase mt-2 shadow-sm transform rotate-2 ${pendingRevealClass}`}
                  >
                    {downOddsLabel}
                  </span>
                </button>
              </div>
              <div className="border-3 border-neo-black bg-gray-100 p-4 rounded-xl">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-display uppercase text-neo-black/60">
                    Local Submissions
                  </span>
                  <span className="text-xs font-bold uppercase text-neo-black/60">Stored locally</span>
                </div>
                {displaySubmissions.length ? (
                  <div className="mt-3 space-y-2">
                    {displaySubmissions.map((submission) => (
                      <div
                        className="flex items-center justify-between bg-white border-2 border-neo-black px-3 py-2 rounded-lg"
                        key={submission.id}
                      >
                        <span className="text-sm font-display uppercase">
                          Round #{submission.roundId}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-neo-black/70">
                            {submission.address ? formatAddress(submission.address) : 'Local'}
                          </span>
                          <span
                            className={
                              submission.direction === 'up'
                                ? 'bg-[#0bda0b] text-white text-xs font-display px-2 py-1 border-2 border-neo-black uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]'
                                : 'bg-[#ff3333] text-white text-xs font-display px-2 py-1 border-2 border-neo-black uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]'
                            }
                          >
                            {submission.direction.toUpperCase()}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-neo-black/60">No local submissions yet.</p>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="lg:col-span-4 flex flex-col gap-10">
          <div className="border-5 border-neo-black bg-white shadow-neo p-0 rounded-2xl overflow-hidden">
            <div className="bg-neo-black p-4 border-b-5 border-neo-black">
              <h3 className="text-white font-display uppercase text-2xl tracking-wide">Your Stats</h3>
            </div>
            <div className="p-6 flex flex-col gap-5">
              <div className="flex justify-between items-center border-b-2 border-neo-black/10 pb-3">
                <span className="text-neo-black/60 text-base font-bold uppercase font-display">Win Rate</span>
                <span className="font-display text-3xl bg-secondary text-white px-2 transform -rotate-1 border-2 border-neo-black">
                  68%
                </span>
              </div>
              <div className="flex justify-between items-center border-b-2 border-neo-black/10 pb-3">
                <span className="text-neo-black/60 text-base font-bold uppercase font-display">Total Wagered</span>
                <span className="font-display text-2xl">12.5 ETH</span>
              </div>
              <div className="flex justify-between items-center pt-1">
                <span className="text-neo-black/60 text-base font-bold uppercase font-display">Net Profit</span>
                <span className="font-display text-3xl text-[#0bda0b]">+4.2 ETH</span>
              </div>
            </div>
          </div>
          <div className="border-5 border-neo-black bg-white flex-grow flex flex-col min-h-[400px] shadow-neo rounded-2xl overflow-hidden">
            <div className="bg-secondary p-4 border-b-5 border-neo-black flex justify-between items-center">
              <h3 className="text-white font-display uppercase text-2xl tracking-wide">Live Feed</h3>
              <div className="flex gap-2">
                <div className="w-4 h-4 bg-[#0bda0b] border-2 border-neo-black rounded-full animate-pulse" />
              </div>
            </div>
            <div className="flex-grow overflow-y-auto custom-scrollbar bg-white">
              <div className="px-4 py-3 text-xs font-display uppercase text-neo-black/60 border-b-2 border-neo-black/10">
                Directions stay encrypted until reveal.
              </div>
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-gray-100 z-10 border-b-4 border-neo-black shadow-sm">
                  <tr>
                    <th className="p-4 text-sm font-display uppercase text-neo-black">User</th>
                    <th className="p-4 text-sm font-display uppercase text-neo-black text-center">Action</th>
                    <th className="p-4 text-sm font-display uppercase text-neo-black text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="text-base font-medium">
                  <tr className="border-b-2 border-neo-black/10 hover:bg-yellow-50 transition-colors">
                    <td className="p-4 font-mono font-bold text-neo-black/80">0x4a...92</td>
                    <td className="p-4 text-center">
                      <span className="bg-neo-black text-white text-xs font-display px-2 py-1 border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] uppercase">
                        BET
                      </span>
                    </td>
                    <td className="p-4 text-right font-display">{STAKE_ETH} ETH</td>
                  </tr>
                  <tr className="border-b-2 border-neo-black/10 hover:bg-yellow-50 transition-colors">
                    <td className="p-4 font-mono font-bold text-neo-black/80">0x8b...11</td>
                    <td className="p-4 text-center">
                      <span className="bg-neo-black text-white text-xs font-display px-2 py-1 border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] uppercase">
                        BET
                      </span>
                    </td>
                    <td className="p-4 text-right font-display">{STAKE_ETH} ETH</td>
                  </tr>
                  <tr className="border-b-2 border-neo-black/10 hover:bg-yellow-50 transition-colors">
                    <td className="p-4 font-mono font-bold text-neo-black/80">0x1c...ff</td>
                    <td className="p-4 text-center">
                      <span className="bg-neo-black text-white text-xs font-display px-2 py-1 border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] uppercase">
                        BET
                      </span>
                    </td>
                    <td className="p-4 text-right font-display">{STAKE_ETH} ETH</td>
                  </tr>
                  <tr className="border-b-2 border-neo-black/10 hover:bg-yellow-50 transition-colors">
                    <td className="p-4 font-mono font-bold text-neo-black/80">0x2d...aa</td>
                    <td className="p-4 text-center">
                      <span className="bg-neo-black text-white text-xs font-display px-2 py-1 border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] uppercase">
                        BET
                      </span>
                    </td>
                    <td className="p-4 text-right font-display">{STAKE_ETH} ETH</td>
                  </tr>
                  <tr className="border-b-2 border-neo-black/10 hover:bg-yellow-50 transition-colors">
                    <td className="p-4 font-mono font-bold text-neo-black/80">0x9e...44</td>
                    <td className="p-4 text-center">
                      <span className="bg-neo-black text-white text-xs font-display px-2 py-1 border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] uppercase">
                        BET
                      </span>
                    </td>
                    <td className="p-4 text-right font-display">{STAKE_ETH} ETH</td>
                  </tr>
                  <tr className="hover:bg-yellow-50 transition-colors">
                    <td className="p-4 font-mono font-bold text-neo-black/80">0x7a...bb</td>
                    <td className="p-4 text-center">
                      <span className="bg-neo-black text-white text-xs font-display px-2 py-1 border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] uppercase">
                        BET
                      </span>
                    </td>
                    <td className="p-4 text-right font-display">{STAKE_ETH} ETH</td>
                  </tr>
                  {totalsRevealed && (
                    <>
                      <tr className="border-b-2 border-neo-black/10 hover:bg-yellow-50 transition-colors">
                        <td className="p-4 font-mono font-bold text-neo-black/80">0x4a...92</td>
                        <td className="p-4 text-center">
                          <span className="bg-primary text-neo-black text-xs font-display px-2 py-1 border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] uppercase">
                            CLAIM
                          </span>
                        </td>
                        <td className="p-4 text-right font-display">0.018 ETH</td>
                      </tr>
                      <tr className="hover:bg-yellow-50 transition-colors">
                        <td className="p-4 font-mono font-bold text-neo-black/80">0x1c...ff</td>
                        <td className="p-4 text-center">
                          <span className="bg-primary text-neo-black text-xs font-display px-2 py-1 border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] uppercase">
                            CLAIM
                          </span>
                        </td>
                        <td className="p-4 text-right font-display">0.014 ETH</td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
      <footer className="border-t-6 border-neo-black bg-white py-10 mt-auto">
        <div className="max-w-[1440px] mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
          <p className="text-neo-black text-sm font-bold uppercase bg-primary px-3 py-1 border-2 border-neo-black shadow-[4px_4px_0px_0px_#000000]">
            © 2024 Predicate Market Inc.
          </p>
          <div className="flex gap-8">
            <a
              className="text-neo-black hover:text-secondary text-sm font-display uppercase border-b-4 border-transparent hover:border-secondary transition-all"
              href="#"
            >
              Terms of Service
            </a>
            <a
              className="text-neo-black hover:text-secondary text-sm font-display uppercase border-b-4 border-transparent hover:border-secondary transition-all"
              href="#"
            >
              Privacy Policy
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function LegacyBtcUpDownPage() {
  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);

  const [stakeAmount, setStakeAmount] = useState<bigint>(0n);
  const [currentRound, setCurrentRound] = useState<number | null>(null);
  const [roundId, setRoundId] = useState<number | null>(null);
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [totals, setTotals] = useState<{ up: number; down: number } | null>(null);
  const [pendingHandle, setPendingHandle] = useState<string>('');

  const contractAddress = useMemo(() => {
    if (!chainId) return '';
    return CONTRACT_ADDRESSES[chainId] || '';
  }, [chainId]);

  const ready = !!account && !!contractAddress && isInitialized;

  const connectWallet = async () => {
    setError('');
    setMessage('');
    if (!window.ethereum) {
      setError('No wallet found');
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
      setAccount(accounts[0]);
      setChainId(parseInt(chainIdHex, 16));
      setMessage('Wallet connected');
      await initializeFheInstance();
      setIsInitialized(true);
    } catch (err: any) {
      setError(err?.message || 'Wallet connection failed');
    }
  };

  const getProvider = () => new ethers.BrowserProvider(window.ethereum);

  const getContract = async (withSigner: boolean) => {
    const provider = getProvider();
    if (withSigner) {
      const signer = await provider.getSigner();
      return new ethers.Contract(contractAddress, CONTRACT_ABI, signer);
    }
    return new ethers.Contract(contractAddress, CONTRACT_ABI, provider);
  };

  const refreshRound = async () => {
    setError('');
    if (!contractAddress) return;
    try {
      const contract = await getContract(false);
      const round = await contract.getCurrentRound();
      const roundNumber = Number(round);
      setCurrentRound(roundNumber);
      if (roundId === null) {
        setRoundId(roundNumber + 1);
      }
      const stake = await contract.stakeAmount();
      setStakeAmount(stake);
    } catch (err: any) {
      setError(err?.message || 'Failed to load round');
    }
  };

  useEffect(() => {
    if (contractAddress && account) {
      refreshRound();
    }
  }, [contractAddress, account]);

  const placeBet = async () => {
    if (!ready || roundId === null) return;
    setError('');
    setMessage('Encrypting direction...');
    try {
      const encrypted = await createEncryptedInput(contractAddress, account, direction === 'up' ? 1 : 0);
      let encryptedData: any = encrypted.encryptedData;
      let proof: any = encrypted.proof;
      if (encryptedData instanceof Uint8Array) {
        encryptedData = ethers.hexlify(encryptedData);
      }
      if (proof instanceof Uint8Array) {
        proof = ethers.hexlify(proof);
      }
      const contract = await getContract(true);
      const tx = await contract.placeBet(roundId, encryptedData, proof, { value: stakeAmount });
      await tx.wait();
      setMessage('Bet placed');
    } catch (err: any) {
      setError(err?.message || 'Bet failed');
    }
  };

  const finalizeRound = async () => {
    if (!ready || roundId === null) return;
    setError('');
    setMessage('Finalizing round...');
    try {
      const contract = await getContract(true);
      const tx = await contract.finalizeRound(roundId);
      await tx.wait();
      setMessage('Round finalized');
    } catch (err: any) {
      setError(err?.message || 'Finalize failed');
    }
  };

  const requestReveal = async () => {
    if (!ready || roundId === null) return;
    setError('');
    setMessage('Requesting reveal...');
    try {
      const contract = await getContract(true);
      const tx = await contract.requestRoundReveal(roundId);
      await tx.wait();
      setMessage('Reveal requested');
    } catch (err: any) {
      setError(err?.message || 'Reveal request failed');
    }
  };

  const decryptTotals = async () => {
    if (!ready || roundId === null) return;
    setError('');
    setMessage('Decrypting totals...');
    try {
      const contract = await getContract(false);
      const handles = await contract.getRoundHandles(roundId);
      const totalUpHandle = handles[0];
      const totalDownHandle = handles[1];
      if (!totalUpHandle || !totalDownHandle) {
        throw new Error('Missing handles');
      }
      const { cleartexts, decryptionProof, values } = await decryptMultipleHandles(
        contractAddress,
        null,
        [totalUpHandle, totalDownHandle]
      );
      const writeContract = await getContract(true);
      const tx = await writeContract.resolveTotalsCallback(roundId, cleartexts, decryptionProof);
      await tx.wait();
      setTotals({ up: Number(values[0]), down: Number(values[1]) });
      setMessage('Totals revealed');
    } catch (err: any) {
      setError(err?.message || 'Decrypt totals failed');
    }
  };

  const requestClaim = async () => {
    if (!ready || roundId === null) return;
    setError('');
    setMessage('Requesting claim...');
    try {
      const contract = await getContract(true);
      const tx = await contract.requestClaim(roundId);
      await tx.wait();
      const readContract = await getContract(false);
      const pending = await readContract.getPendingClaim(roundId, account);
      if (pending[0]) {
        setPendingHandle(pending[1]);
      }
      setMessage('Claim requested');
    } catch (err: any) {
      setError(err?.message || 'Request claim failed');
    }
  };

  const decryptPayoutAndClaim = async () => {
    if (!ready || roundId === null) return;
    if (!pendingHandle) {
      setError('No pending handle');
      return;
    }
    setError('');
    setMessage('Decrypting payout...');
    try {
      const result = await fetchPublicDecryption([pendingHandle]);
      const clearValues = result?.clearValues || {};
      const rawValue = clearValues[pendingHandle] ?? Object.values(clearValues)[0];
      const payout = typeof rawValue === 'bigint' ? rawValue : BigInt(rawValue || 0);

      let cleartexts = result?.abiEncodedClearValues;
      if (!cleartexts) {
        const abiCoder = ethers.AbiCoder.defaultAbiCoder();
        cleartexts = abiCoder.encode(['uint64'], [payout]);
      }
      const proof = result?.decryptionProof;
      if (!proof) {
        throw new Error('Missing decryption proof');
      }

      const contract = await getContract(true);
      const tx = await contract.claimCallback(roundId, cleartexts, proof);
      await tx.wait();
      setMessage('Claim completed');
      setPendingHandle('');
    } catch (err: any) {
      setError(err?.message || 'Claim failed');
    }
  };

  return (
    <div className="p-8 space-y-6 text-white">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">BTC Up/Down FHEVM (First-claimer reveal)</h1>
        <p className="text-sm text-gray-400">
          Minimal flow: place bet → finalize → request reveal → decrypt totals → request claim → decrypt payout.
        </p>
      </div>

      <div className="space-y-2">
        <button className="btn-primary" onClick={connectWallet}>
          Connect Wallet
        </button>
        <div className="text-sm text-gray-400">
          {account ? `Account: ${account}` : 'Not connected'}
        </div>
        <div className="text-sm text-gray-400">
          {chainId ? `Chain ID: ${chainId}` : 'Chain ID: -'}
        </div>
        <div className="text-sm text-gray-400">
          {contractAddress ? `Contract: ${contractAddress}` : 'Contract: not set'}
        </div>
      </div>

      <div className="space-y-3">
        <div className="text-sm text-gray-400">
          Current round: {currentRound ?? '-'} | Target round: {roundId ?? (currentRound !== null ? currentRound + 1 : '-')}
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-sm text-gray-300">Round ID</label>
          <input
            className="border border-gray-700 bg-black px-2 py-1 text-sm"
            value={roundId ?? ''}
            onChange={(e) => setRoundId(Number(e.target.value))}
          />
          <button className="btn-secondary" onClick={refreshRound}>
            Refresh
          </button>
        </div>
        <div className="text-sm text-gray-400">
          Stake amount: {stakeAmount ? `${ethers.formatEther(stakeAmount)} ETH` : '-'}
        </div>
      </div>

      <div className="space-y-3 border border-gray-800 p-4">
        <h2 className="text-lg font-semibold">1) Place Bet</h2>
        <div className="flex gap-3">
          <button
            className={direction === 'up' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setDirection('up')}
          >
            Up
          </button>
          <button
            className={direction === 'down' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setDirection('down')}
          >
            Down
          </button>
          <button className="btn-primary" onClick={placeBet}>
            Place Bet
          </button>
        </div>
      </div>

      <div className="space-y-3 border border-gray-800 p-4">
        <h2 className="text-lg font-semibold">2) Finalize Round (Price Feed)</h2>
        <button className="btn-secondary" onClick={finalizeRound}>
          Finalize with Chainlink price
        </button>
      </div>

      <div className="space-y-3 border border-gray-800 p-4">
        <h2 className="text-lg font-semibold">3) Reveal Totals</h2>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={requestReveal}>
            Request Reveal
          </button>
          <button className="btn-secondary" onClick={decryptTotals}>
            Decrypt Totals + Submit
          </button>
        </div>
        {totals && (
          <div className="text-sm text-gray-400">
            Totals: up {totals.up} | down {totals.down}
          </div>
        )}
      </div>

      <div className="space-y-3 border border-gray-800 p-4">
        <h2 className="text-lg font-semibold">4) Claim</h2>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={requestClaim}>
            Request Claim
          </button>
          <button className="btn-secondary" onClick={decryptPayoutAndClaim}>
            Decrypt Payout + Claim
          </button>
        </div>
        {pendingHandle && (
          <div className="text-xs text-gray-500 break-all">Pending handle: {pendingHandle}</div>
        )}
      </div>

      {message && <div className="text-sm text-green-400">{message}</div>}
      {error && <div className="text-sm text-red-400">{error}</div>}
    </div>
  );
}
