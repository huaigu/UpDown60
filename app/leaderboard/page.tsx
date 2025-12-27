'use client';

import { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import Link from 'next/link';

const SEPOLIA_CHAIN_ID = 11155111;
const CONTRACT_ADDRESS = '0x5F893Cf33715DbaC196229560418C709F0FFA6Ca';
const LOCAL_FEED_KEY = 'btcUpDownLiveFeed';
const LOCAL_FEED_BLOCK_KEY = 'btcUpDownLiveFeedLastBlock';
const STAKE_WEI = ethers.parseEther('0.01');

type FeedEvent = {
  id: string;
  type: 'bet' | 'claim' | 'round-init' | 'round-final';
  user?: string;
  roundId: number;
  amountEth?: string;
  txHash: string;
  blockNumber: number;
  logIndex: number;
};

type LeaderboardEntry = {
  address: string;
  bets: number;
  wagered: bigint;
  payout: bigint;
};

const formatShortAddress = (value: string) => {
  if (!value) return '';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

const formatEthValue = (value: string) => {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return value;
  return numeric.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

const formatEthBigint = (value: bigint) => formatEthValue(ethers.formatEther(value));

export default function LeaderboardPage() {
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const [lastIndexedBlock, setLastIndexedBlock] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.body.classList.add('btc-updown-body');
    return () => {
      document.body.classList.remove('btc-updown-body');
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const feedStorageKey = `${LOCAL_FEED_KEY}:${SEPOLIA_CHAIN_ID}:${CONTRACT_ADDRESS.toLowerCase()}`;
    const feedBlockKey = `${feedStorageKey}:${LOCAL_FEED_BLOCK_KEY}`;

    const loadCache = () => {
      const stored = window.localStorage.getItem(feedStorageKey);
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as FeedEvent[];
          setFeedEvents(Array.isArray(parsed) ? parsed : []);
        } catch (err) {
          console.warn('Failed to parse live feed cache', err);
          setFeedEvents([]);
        }
      } else {
        setFeedEvents([]);
      }
      const storedBlock = window.localStorage.getItem(feedBlockKey);
      if (storedBlock) {
        const parsedBlock = Number(storedBlock);
        setLastIndexedBlock(Number.isNaN(parsedBlock) ? null : parsedBlock);
      } else {
        setLastIndexedBlock(null);
      }
    };

    loadCache();
    const interval = window.setInterval(loadCache, 5000);
    const handleStorage = (event: StorageEvent) => {
      if (event.key === feedStorageKey || event.key === feedBlockKey) {
        loadCache();
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const leaderboard = useMemo(() => {
    const stats = new Map<string, LeaderboardEntry>();
    feedEvents.forEach((event) => {
      if (event.type !== 'bet' && event.type !== 'claim') return;
      const user = event.user?.toLowerCase();
      if (!user) return;
      const existing = stats.get(user) || {
        address: user,
        bets: 0,
        wagered: 0n,
        payout: 0n,
      };
      if (event.type === 'bet') {
        const amountWei = event.amountEth ? ethers.parseEther(event.amountEth) : STAKE_WEI;
        existing.bets += 1;
        existing.wagered += amountWei;
      } else if (event.type === 'claim') {
        const payoutWei = event.amountEth ? ethers.parseEther(event.amountEth) : 0n;
        existing.payout += payoutWei;
      }
      stats.set(user, existing);
    });

    return Array.from(stats.values()).sort((a, b) => {
      if (a.payout !== b.payout) return a.payout > b.payout ? -1 : 1;
      if (a.wagered !== b.wagered) return a.wagered > b.wagered ? -1 : 1;
      return a.address.localeCompare(b.address);
    });
  }, [feedEvents]);

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
              <span className="material-symbols-outlined text-primary text-4xl font-bold">
                query_stats
              </span>
            </div>
            <h1 className="text-4xl font-display tracking-tighter uppercase transform rotate-1">
              BTC<span className="text-secondary">UPDOWN60</span>
            </h1>
          </div>
          <nav className="hidden md:flex items-center gap-4">
            <a
              className="bg-white px-6 py-3 text-lg font-display uppercase border-3 border-neo-black shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
              href="#"
            >
              Markets
            </a>
            <Link
              className="bg-secondary text-white px-6 py-3 text-lg font-display uppercase border-3 border-neo-black shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
              href="/leaderboard"
            >
              Leaderboard
            </Link>
            <Link
              className="bg-white px-6 py-3 text-lg font-display uppercase border-3 border-neo-black shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
              href="/guide"
            >
              Guide
            </Link>
          </nav>
          <Link
            className="flex items-center gap-3 bg-secondary text-white px-8 py-4 font-display text-lg uppercase border-3 border-neo-black shadow-neo hover:translate-x-[4px] hover:translate-y-[4px] hover:shadow-neo-hover active:translate-x-[8px] active:translate-y-[8px] active:shadow-none transition-all rotate-1"
            href="/"
          >
            <span className="material-symbols-outlined text-[24px]">home</span>
            <span>Back to App</span>
          </Link>
        </div>
      </header>
      <main className="flex-grow w-full max-w-[1440px] mx-auto p-6 md:p-10 flex flex-col gap-8">
        <section className="border-6 border-neo-black bg-white p-8 shadow-neo rounded-2xl">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-secondary text-white border-3 border-neo-black flex items-center justify-center shadow-neo-sm -rotate-2">
                <span className="material-symbols-outlined text-3xl">emoji_events</span>
              </div>
              <h2 className="text-3xl font-display uppercase">Leaderboard</h2>
            </div>
            <div className="text-xs font-display uppercase text-neo-black/60">
              Synced block: {lastIndexedBlock ?? '--'}
            </div>
          </div>
          <p className="mt-4 text-sm text-neo-black/70">
            This page re-uses the Live Feed cache from the home page. Open the app to sync the
            latest events.
          </p>
        </section>

        <section className="border-6 border-neo-black bg-white p-0 shadow-neo rounded-2xl overflow-hidden">
          <div className="bg-neo-black px-6 py-4 flex items-center justify-between">
            <h3 className="text-white font-display uppercase text-2xl">Top Wallets</h3>
            <span className="text-primary text-xs font-display uppercase">On-chain only</span>
          </div>
          {leaderboard.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse table-fixed">
                <thead className="bg-gray-100 border-b-4 border-neo-black">
                  <tr>
                    <th className="p-4 text-xs font-display uppercase text-neo-black w-16">Rank</th>
                    <th className="p-4 text-xs font-display uppercase text-neo-black w-32">Wallet</th>
                    <th className="p-4 text-xs font-display uppercase text-neo-black text-right">Bets</th>
                    <th className="p-4 text-xs font-display uppercase text-neo-black text-right">Wagered</th>
                    <th className="p-4 text-xs font-display uppercase text-neo-black text-right">Payout</th>
                    <th className="p-4 text-xs font-display uppercase text-neo-black text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.slice(0, 12).map((entry, index) => {
                    const net = entry.payout - entry.wagered;
                    const netLabel = net >= 0n ? '+' : '-';
                    const netValue = net >= 0n ? net : -net;
                    return (
                      <tr
                        className="border-b-2 border-neo-black/10 hover:bg-yellow-50 transition-colors"
                        key={entry.address}
                      >
                        <td className="p-4 font-display text-sm text-neo-black">{index + 1}</td>
                        <td className="p-4 font-mono text-sm text-neo-black">
                          {formatShortAddress(entry.address)}
                        </td>
                        <td className="p-4 text-right font-display text-sm">{entry.bets}</td>
                        <td className="p-4 text-right font-display text-sm">
                          {formatEthBigint(entry.wagered)} ETH
                        </td>
                        <td className="p-4 text-right font-display text-sm">
                          {formatEthBigint(entry.payout)} ETH
                        </td>
                        <td className="p-4 text-right font-display text-sm">
                          {netLabel}
                          {formatEthBigint(netValue)} ETH
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-neo-black/60">
              No cached events yet. Open the home page to sync Live Feed data.
            </div>
          )}
        </section>

        <section className="border-5 border-neo-black bg-white p-6 rounded-2xl shadow-neo">
          <h3 className="text-xl font-display uppercase">How this is computed</h3>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-neo-black/80">
            <div className="border-3 border-neo-black bg-gray-100 p-4 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/60">Bets</p>
              <p className="mt-2">Counted from BetPlaced events.</p>
            </div>
            <div className="border-3 border-neo-black bg-gray-100 p-4 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/60">Payout</p>
              <p className="mt-2">Sum of ClaimPaid payouts.</p>
            </div>
            <div className="border-3 border-neo-black bg-gray-100 p-4 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/60">Net</p>
              <p className="mt-2">Payout minus total wagered.</p>
            </div>
          </div>
        </section>
      </main>
      <footer className="border-t-6 border-neo-black bg-white py-10 mt-auto">
        <div className="max-w-[1440px] mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
          <p className="text-neo-black text-sm font-bold uppercase bg-primary px-3 py-1 border-2 border-neo-black shadow-[4px_4px_0px_0px_#000000]">
            © 2025 Predicate Market Inc.
          </p>
          <div className="flex gap-8">
            <a
              className="text-neo-black hover:text-secondary text-sm font-display uppercase border-b-4 border-transparent hover:border-secondary transition-all"
              href="https://x.com/coder_chao"
              rel="noreferrer"
              target="_blank"
            >
              Twitter
            </a>
            <a
              className="text-neo-black hover:text-secondary text-sm font-display uppercase border-b-4 border-transparent hover:border-secondary transition-all"
              href="https://github.com/huaigu/UpDown60"
              rel="noreferrer"
              target="_blank"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
