'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function GuidePage() {
  useEffect(() => {
    document.body.classList.add('btc-updown-body');
    return () => {
      document.body.classList.remove('btc-updown-body');
    };
  }, []);

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
              className="bg-white px-6 py-3 text-lg font-display uppercase border-3 border-neo-black shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
              href="/leaderboard"
            >
              Leaderboard
            </Link>
            <Link
              className="bg-secondary text-white px-6 py-3 text-lg font-display uppercase border-3 border-neo-black shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
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
      <main className="flex-grow w-full max-w-[1440px] mx-auto p-6 md:p-10 flex flex-col gap-10">
        <section className="border-6 border-neo-black bg-white p-8 shadow-neo rounded-2xl">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-secondary text-white border-3 border-neo-black flex items-center justify-center shadow-neo-sm -rotate-2">
              <span className="material-symbols-outlined text-3xl">menu_book</span>
            </div>
            <h2 className="text-3xl font-display uppercase">Guide</h2>
          </div>
          <p className="mt-4 text-base text-neo-black/80">
            This is a simple BTC Up/Down bet game with FHE. Your direction stays private until
            reveal. Everything runs on-chain, no server needed.
          </p>
          <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="border-3 border-neo-black bg-gray-100 p-4 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/60">Privacy</p>
              <p className="mt-2 text-sm">
                Up or Down is encrypted. Others only see HIDDEN.
              </p>
            </div>
            <div className="border-3 border-neo-black bg-gray-100 p-4 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/60">Serverless</p>
              <p className="mt-2 text-sm">
                All data lives in the contract. The UI can be replaced.
              </p>
            </div>
            <div className="border-3 border-neo-black bg-gray-100 p-4 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/60">Automatic</p>
              <p className="mt-2 text-sm">
                Chainlink Automation can finalize rounds after they end.
              </p>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="border-5 border-neo-black bg-white p-6 rounded-2xl shadow-neo">
            <h3 className="text-xl font-display uppercase">Round Basics</h3>
            <ul className="mt-4 space-y-3 text-sm text-neo-black/80">
              <li>Each round is 60 minutes.</li>
              <li>You can bet only the next round (fair timing).</li>
              <li>Bet amount is fixed.</li>
              <li>Result is Up, Down, or Tie.</li>
            </ul>
            <div className="mt-4 border-3 border-neo-black bg-primary px-4 py-3 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/70">
                Next round only = no last-minute advantage.
              </p>
            </div>
          </div>

          <div className="border-5 border-neo-black bg-white p-6 rounded-2xl shadow-neo">
            <h3 className="text-xl font-display uppercase">How to Bet</h3>
            <ol className="mt-4 space-y-3 text-sm text-neo-black/80 list-decimal list-inside">
              <li>Connect wallet on Sepolia.</li>
              <li>Pick Up or Down for the next round.</li>
              <li>Wait for the round to end (about 1 hour).</li>
              <li>Check the result in Live Feed.</li>
            </ol>
            <div className="mt-4 border-3 border-neo-black bg-gray-100 px-4 py-3 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/70">
                Your direction is private until you decrypt it.
              </p>
            </div>
          </div>
        </section>

        <section className="border-5 border-neo-black bg-white p-6 rounded-2xl shadow-neo">
          <h3 className="text-xl font-display uppercase">Reveal & Claim</h3>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-4 text-sm text-neo-black/80">
            <div className="border-3 border-neo-black bg-gray-100 p-4 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/60">1) Finalize</p>
              <p className="mt-2">
                After round end, result is set. Automation can do this.
              </p>
            </div>
            <div className="border-3 border-neo-black bg-gray-100 p-4 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/60">2) Reveal</p>
              <p className="mt-2">
                Someone calls reveal once per round to open totals.
              </p>
            </div>
            <div className="border-3 border-neo-black bg-gray-100 p-4 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/60">3) Decrypt</p>
              <p className="mt-2">
                The bettor can decrypt their own direction if needed.
              </p>
            </div>
            <div className="border-3 border-neo-black bg-gray-100 p-4 rounded-xl shadow-neo-sm">
              <p className="text-xs font-display uppercase text-neo-black/60">4) Claim</p>
              <p className="mt-2">
                Winners claim payout. Tie refunds the stake.
              </p>
            </div>
          </div>
          <div className="mt-5 border-3 border-neo-black bg-white px-4 py-3 rounded-xl shadow-neo-sm">
            <p className="text-xs font-display uppercase text-neo-black/70">
              Reveal is needed because totals are encrypted. It does not expose individual bets.
            </p>
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
