'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
  11155111: '0x837e0B7FAAaB99D3f4806d37699B5Ec8C4d67bbF',
};

const CONTRACT_ABI = [
  'event BetPlaced(uint256 indexed roundId, address indexed user, uint64 stake)',
  'event ClaimPaid(uint256 indexed roundId, address indexed user, uint64 payout)',
  'function stakeAmount() view returns (uint64)',
  'function feeBps() view returns (uint16)',
  'function getCurrentRound() view returns (uint256)',
  'function getRoundState(uint256 roundId) view returns (bool,uint256,uint256,int256,int256,uint8,bool,bool,bool)',
  'function getRoundTotals(uint256 roundId) view returns (uint64,uint64,uint64)',
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
const PUBLIC_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
const BTC_USD_FEED = '0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43';
const FEED_ABI = [
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function decimals() view returns (uint8)',
];
const SEPOLIA_CONFIG = {
  chainId: '0xaa36a7',
  chainName: 'Sepolia',
  nativeCurrency: {
    name: 'Sepolia Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  rpcUrls: [
    'https://ethereum-sepolia.publicnode.com',
    'https://rpc.sepolia.org',
    'https://sepolia.drpc.org',
    'https://sepolia.infura.io/v3/',
  ],
  blockExplorerUrls: ['https://sepolia.etherscan.io/'],
};
const STAKE_ETH = '0.01';
const LOCAL_SUBMISSIONS_KEY = 'btcUpDownLocalSubmissions';
const LOCAL_FEED_KEY = 'btcUpDownLiveFeed';
const LOCAL_FEED_BLOCK_KEY = 'btcUpDownLiveFeedLastBlock';

const formatAddress = (value: string) => {
  if (!value) return '';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

const formatEthValue = (value: string) => {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return value;
  return numeric.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

const formatPercent = (value: number) => {
  if (Number.isNaN(value)) return '--';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(2)}%`;
};

type LocalSubmission = {
  id: string;
  roundId: number;
  direction: 'up' | 'down';
  timestamp: number;
  address?: string;
};

type FeedEvent = {
  id: string;
  type: 'bet' | 'claim';
  user: string;
  roundId: number;
  amountEth: string;
  txHash: string;
  blockNumber: number;
  logIndex: number;
};

type RoundTotals = {
  totalUp: bigint;
  totalDown: bigint;
  feeAmount: bigint;
  result: number;
  resultSet: boolean;
  totalsRevealed: boolean;
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
  const contractAddress = useMemo(() => {
    if (!chainId) return '';
    return CONTRACT_ADDRESSES[chainId] || '';
  }, [chainId]);
  const readChainId = SEPOLIA_CHAIN_ID;
  const readContractAddress = CONTRACT_ADDRESSES[readChainId] || '';
  const hasReadContract = !!readContractAddress && readContractAddress !== ethers.ZeroAddress;
  const hasContract = !!contractAddress && contractAddress !== ethers.ZeroAddress;
  const [isInitializing, setIsInitializing] = useState(false);
  const [isSwitchingNetwork, setIsSwitchingNetwork] = useState(false);
  const [networkError, setNetworkError] = useState('');
  const [localSubmissions, setLocalSubmissions] = useState<LocalSubmission[]>([]);
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const [lastIndexedBlock, setLastIndexedBlock] = useState<number | null>(null);
  const [roundTotals, setRoundTotals] = useState<RoundTotals | null>(null);
  const [currentRound, setCurrentRound] = useState<number | null>(null);
  const [stakeAmount, setStakeAmount] = useState<bigint | null>(null);
  const [actionError, setActionError] = useState('');
  const [betLoading, setBetLoading] = useState(false);
  const [betLoadingText, setBetLoadingText] = useState('');
  const [btcPrice, setBtcPrice] = useState<string | null>(null);
  const [btcChangePct, setBtcChangePct] = useState<number | null>(null);
  const btcPriceRef = useRef<number | null>(null);
  const [blockTimestamp, setBlockTimestamp] = useState<number | null>(null);
  const [blockFetchedAt, setBlockFetchedAt] = useState<number | null>(null);
  const [clientNow, setClientNow] = useState(0);
  const isOnSepolia = chainId === SEPOLIA_CHAIN_ID;
  const publicProvider = useMemo(() => new ethers.JsonRpcProvider(PUBLIC_RPC_URL), []);
  const readProvider = useMemo(() => {
    if (isConnected && isOnSepolia && typeof window !== 'undefined' && window.ethereum) {
      return new ethers.BrowserProvider(window.ethereum);
    }
    return publicProvider;
  }, [isConnected, isOnSepolia, publicProvider]);
  const feedStorageKey = useMemo(() => {
    if (!readContractAddress || readContractAddress === ethers.ZeroAddress) return '';
    return `${LOCAL_FEED_KEY}:${readChainId}:${readContractAddress.toLowerCase()}`;
  }, [readChainId, readContractAddress]);
  const feedBlockKey = feedStorageKey ? `${feedStorageKey}:${LOCAL_FEED_BLOCK_KEY}` : '';
  const totalsRevealed = roundTotals?.totalsRevealed ?? false;
  const isPendingReveal = !roundTotals || !roundTotals.totalsRevealed || !roundTotals.resultSet;
  const stakeEth = stakeAmount ? ethers.formatEther(stakeAmount) : STAKE_ETH;
  const poolValueText = !isPendingReveal && roundTotals
    ? `${ethers.formatEther(roundTotals.totalUp + roundTotals.totalDown)} ETH`
    : 'Pending reveal';
  const pendingRevealClass = isPendingReveal ? 'font-black uppercase' : '';
  const btcPriceText = btcPrice ? `$${btcPrice}` : '$--';

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
    if (typeof window === 'undefined' || !feedStorageKey) return;
    const stored = window.localStorage.getItem(feedStorageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as FeedEvent[];
        if (Array.isArray(parsed)) {
          setFeedEvents(parsed);
        } else {
          setFeedEvents([]);
        }
      } catch (err) {
        console.warn('Failed to parse feed cache', err);
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
  }, [feedStorageKey, feedBlockKey]);

  useEffect(() => {
    if (typeof window === 'undefined' || !feedStorageKey) return;
    window.localStorage.setItem(feedStorageKey, JSON.stringify(feedEvents));
    if (lastIndexedBlock !== null) {
      window.localStorage.setItem(feedBlockKey, String(lastIndexedBlock));
    }
  }, [feedEvents, feedStorageKey, feedBlockKey, lastIndexedBlock]);

  useEffect(() => {
    setClientNow(Date.now());
    const interval = window.setInterval(() => {
      setClientNow(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let isActive = true;
    const fetchBlockTime = async () => {
      try {
        const latestBlock = await readProvider.getBlock('latest');
        if (!isActive || !latestBlock?.timestamp) return;
        const timestamp =
          typeof latestBlock.timestamp === 'number'
            ? latestBlock.timestamp
            : Number(latestBlock.timestamp);
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
  }, [readProvider]);

  useEffect(() => {
    let isActive = true;
    const loadContractData = async () => {
      try {
        if (!hasReadContract) return;
        const contract = getReadContract();
        const [stake, roundId] = await Promise.all([
          contract.stakeAmount(),
          contract.getCurrentRound(),
        ]);
        if (!isActive) return;
        setStakeAmount(stake);
        const roundNumber = Number(roundId);
        setCurrentRound(roundNumber);
        const revealRoundId = roundNumber > 0 ? roundNumber - 1 : 0;
        const [roundState, totals] = await Promise.all([
          contract.getRoundState(revealRoundId),
          contract.getRoundTotals(revealRoundId),
        ]);
        if (!isActive) return;
        setRoundTotals({
          totalUp: totals[0],
          totalDown: totals[1],
          feeAmount: totals[2],
          result: Number(roundState[5]),
          resultSet: roundState[6],
          totalsRevealed: roundState[8],
        });
      } catch (err) {
        console.warn('Failed to load contract data', err);
      }
    };

    loadContractData();
    const interval = window.setInterval(loadContractData, 12000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [hasReadContract, readContractAddress, readProvider]);

  useEffect(() => {
    if (!isConnected || isInitialized || isInitializing || !isOnSepolia) return;
    setIsInitializing(true);
    initialize().finally(() => {
      setIsInitializing(false);
    });
  }, [isConnected, isInitialized, isInitializing, initialize, isOnSepolia]);

  useEffect(() => {
    if (!readProvider) return;
    let isActive = true;
    const loadBtcPrice = async () => {
      try {
        const feed = new ethers.Contract(BTC_USD_FEED, FEED_ABI, readProvider);
        const [decimals, roundData] = await Promise.all([
          feed.decimals(),
          feed.latestRoundData(),
        ]);
        if (!isActive) return;
        const price = roundData[1];
        const numeric = Number(price) / 10 ** Number(decimals);
        if (Number.isNaN(numeric)) return;
        const formatted = new Intl.NumberFormat('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(numeric);
        setBtcPrice(formatted);
        if (btcPriceRef.current && btcPriceRef.current > 0) {
          const changePct = ((numeric - btcPriceRef.current) / btcPriceRef.current) * 100;
          setBtcChangePct(changePct);
        }
        btcPriceRef.current = numeric;
      } catch (err) {
        console.warn('Failed to load BTC price', err);
      }
    };

    loadBtcPrice();
    const interval = window.setInterval(loadBtcPrice, 15000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [readProvider]);

  useEffect(() => {
    if (hasReadContract) return;
    setRoundTotals(null);
    setCurrentRound(null);
    setStakeAmount(null);
    setFeedEvents([]);
    setLastIndexedBlock(null);
  }, [hasReadContract]);

  useEffect(() => {
    if (!hasReadContract || !feedStorageKey) return;
    let isActive = true;
    const contract = new ethers.Contract(readContractAddress, CONTRACT_ABI, readProvider);

    const syncFeed = async () => {
      try {
        const latestBlock = await readProvider.getBlockNumber();
        const fromBlock =
          lastIndexedBlock !== null
            ? lastIndexedBlock + 1
            : Math.max(latestBlock - 2000, 0);
        if (fromBlock > latestBlock) return;
        const [betEvents, claimEvents] = await Promise.all([
          contract.queryFilter(contract.filters.BetPlaced(), fromBlock, latestBlock),
          contract.queryFilter(contract.filters.ClaimPaid(), fromBlock, latestBlock),
        ]);
        if (!isActive) return;
        const mapped = [
          ...betEvents.map((event) => ({
            id: `${event.transactionHash}-${event.logIndex}`,
            type: 'bet' as const,
            user: event.args?.user as string,
            roundId: Number(event.args?.roundId ?? 0),
            amountEth: ethers.formatEther(event.args?.stake ?? 0n),
            txHash: event.transactionHash,
            blockNumber: event.blockNumber ?? 0,
            logIndex: event.logIndex ?? 0,
          })),
          ...claimEvents.map((event) => ({
            id: `${event.transactionHash}-${event.logIndex}`,
            type: 'claim' as const,
            user: event.args?.user as string,
            roundId: Number(event.args?.roundId ?? 0),
            amountEth: ethers.formatEther(event.args?.payout ?? 0n),
            txHash: event.transactionHash,
            blockNumber: event.blockNumber ?? 0,
            logIndex: event.logIndex ?? 0,
          })),
        ];

        if (mapped.length) {
          setFeedEvents((prev) => {
            const merged = new Map<string, FeedEvent>();
            [...prev, ...mapped].forEach((item) => {
              merged.set(item.id, item);
            });
            return Array.from(merged.values())
              .sort((a, b) => {
                if (b.blockNumber !== a.blockNumber) {
                  return b.blockNumber - a.blockNumber;
                }
                return b.logIndex - a.logIndex;
              })
              .slice(0, 20);
          });
        }
        setLastIndexedBlock(latestBlock);
      } catch (err) {
        console.warn('Failed to sync live feed', err);
      }
    };

    syncFeed();
    const interval = window.setInterval(syncFeed, 15000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [
    hasReadContract,
    readContractAddress,
    readProvider,
    feedStorageKey,
    lastIndexedBlock,
  ]);

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

  const getProvider = () => new ethers.BrowserProvider(window.ethereum);

  const getReadContract = () => {
    return new ethers.Contract(readContractAddress, CONTRACT_ABI, readProvider);
  };

  const getWriteContract = async (addressOverride?: string) => {
    const provider = getProvider();
    const signer = await provider.getSigner();
    return new ethers.Contract(addressOverride || contractAddress, CONTRACT_ABI, signer);
  };

  const handleLocalSubmit = (directionValue: 'up' | 'down', roundIdOverride?: number) => {
    const targetRound =
      roundIdOverride ?? Math.floor(Date.now() / 1000 / ROUND_SECONDS) + 1;
    const newSubmission: LocalSubmission = {
      id: `${targetRound}-${Date.now()}`,
      roundId: targetRound,
      direction: directionValue,
      timestamp: Date.now(),
      address: address || undefined,
    };
    setLocalSubmissions((prev) => [newSubmission, ...prev].slice(0, 6));
  };

  const handlePlaceBet = async (directionValue: 'up' | 'down') => {
    setActionError('');
    if (betLoading) return;
    setBetLoading(true);
    try {
      if (!window.ethereum) {
        throw new Error('No wallet found');
      }
      if (!isConnected) {
        setBetLoadingText('Connecting wallet...');
        await handleConnect();
      }
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      const userAddress = accounts?.[0];
      if (!userAddress) {
        throw new Error('Wallet not connected');
      }
      const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
      const connectedChainId = parseInt(chainIdHex, 16);
      if (connectedChainId !== SEPOLIA_CHAIN_ID) {
        throw new Error('Switch to Sepolia to place a bet');
      }
      const addressForChain = CONTRACT_ADDRESSES[connectedChainId] || '';
      if (!addressForChain || addressForChain === ethers.ZeroAddress) {
        throw new Error('Contract address missing');
      }
      if (!isInitialized) {
        setBetLoadingText('Initializing FHEVM...');
        await initialize();
      }
      setBetLoadingText('Preparing encrypted input...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      setBetLoadingText('Encrypting with FHEVM...');
      const contract = await getWriteContract(addressForChain);
      const latestRound = currentRound ?? Number(await contract.getCurrentRound());
      const targetRound = latestRound + 1;
      const encrypted = await createEncryptedInput(
        addressForChain,
        userAddress,
        directionValue === 'up' ? 1 : 0
      );
      let encryptedData: any = encrypted.encryptedData;
      let proof: any = encrypted.proof;
      if (encryptedData instanceof Uint8Array) {
        encryptedData = ethers.hexlify(encryptedData);
      }
      if (proof instanceof Uint8Array) {
        proof = ethers.hexlify(proof);
      }
      const value = stakeAmount ?? ethers.parseEther(STAKE_ETH);
      setBetLoadingText('Submitting bet...');
      const tx = await contract.placeBet(targetRound, encryptedData, proof, { value });
      await tx.wait();
      handleLocalSubmit(directionValue, targetRound);
    } catch (err: any) {
      setActionError(err?.message || 'Bet failed');
    } finally {
      setBetLoading(false);
      setBetLoadingText('');
    }
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
  const odds = useMemo(() => {
    if (!roundTotals || !roundTotals.totalsRevealed || !roundTotals.resultSet) {
      return { up: 'Pending reveal', down: 'Pending reveal' };
    }

    if (roundTotals.result === 3) {
      return { up: '1.00x Refund', down: '1.00x Refund' };
    }

    const winningTotal =
      roundTotals.result === 1 ? roundTotals.totalUp : roundTotals.totalDown;
    const losingTotal =
      roundTotals.result === 1 ? roundTotals.totalDown : roundTotals.totalUp;
    const fee = roundTotals.feeAmount;
    const distributable = losingTotal > fee ? losingTotal - fee : 0n;
    const winningTotalEth = Number(ethers.formatEther(winningTotal));
    const distributableEth = Number(ethers.formatEther(distributable));
    const multiplier =
      winningTotalEth > 0 ? (winningTotalEth + distributableEth) / winningTotalEth : 1;
    const formattedMultiplier = `${multiplier.toFixed(2)}x Payout`;

    return roundTotals.result === 1
      ? { up: formattedMultiplier, down: 'No payout' }
      : { up: 'No payout', down: formattedMultiplier };
  }, [roundTotals]);
  const upOddsLabel = odds.up;
  const downOddsLabel = odds.down;
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
  const displayRoundId = currentRound ?? 9284;
  const displayFeedEvents = feedEvents.slice(0, 6);
  const feedHint = !hasReadContract
    ? 'Contract address missing.'
    : !isConnected
      ? 'Public RPC active. No on-chain activity yet.'
      : 'No on-chain activity yet.';
  const roundResultId = currentRound && currentRound > 0 ? currentRound - 1 : null;
  const roundResultText = useMemo(() => {
    if (!roundResultId) return 'Round -- Pending';
    if (!roundTotals?.resultSet) return `Round #${roundResultId} Pending`;
    if (roundTotals.result === 1) return `Round #${roundResultId} UP`;
    if (roundTotals.result === 2) return `Round #${roundResultId} DOWN`;
    if (roundTotals.result === 3) return `Round #${roundResultId} TIE`;
    return `Round #${roundResultId} Pending`;
  }, [roundResultId, roundTotals]);
  const roundResultClass =
    roundTotals?.result === 1
      ? 'text-[#0bda0b]'
      : roundTotals?.result === 2
        ? 'text-[#ff3333]'
        : 'text-white';
  const canBet = isConnected && isOnSepolia && isInitialized && hasContract;
  const betHint =
    actionError ||
    (canBet
      ? 'Submit on-chain bet'
      : 'Connect wallet on Sepolia to submit on-chain');

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
              BTC<span className="text-secondary">.UPDOWN5</span>
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
          <span className={`mx-12 font-display text-2xl uppercase ${roundResultClass}`}>
            {roundResultText}
          </span>
          <span className={`mx-12 font-display text-2xl uppercase ${roundResultClass}`}>
            {roundResultText}
          </span>
          <span className={`mx-12 font-display text-2xl uppercase ${roundResultClass}`}>
            {roundResultText}
          </span>
          <span className={`mx-12 font-display text-2xl uppercase ${roundResultClass}`}>
            {roundResultText}
          </span>
          <span className={`mx-12 font-display text-2xl uppercase ${roundResultClass}`}>
            {roundResultText}
          </span>
          <span className={`mx-12 font-display text-2xl uppercase ${roundResultClass}`}>
            {roundResultText}
          </span>
        </div>
      </div>
      <main className="flex-grow w-full max-w-[1440px] mx-auto p-6 md:p-10 grid grid-cols-1 lg:grid-cols-12 gap-10">
        <div className="lg:col-span-8 flex flex-col gap-10">
          <div className="border-6 border-neo-black bg-white p-8 shadow-neo relative rounded-2xl">
            <div className="absolute -top-6 -right-4 bg-secondary text-white font-display px-6 py-2 border-3 border-neo-black uppercase text-lg transform rotate-6 shadow-neo-sm z-10">
              Round #{displayRoundId} Live
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
                <span
                  className={`border-3 border-neo-black px-3 py-1 text-xl font-display uppercase transform rotate-2 ${
                    btcChangePct === null
                      ? 'bg-white text-neo-black'
                      : btcChangePct >= 0
                        ? 'bg-[#0bda0b] text-white'
                        : 'bg-[#ff3333] text-white'
                  }`}
                >
                  {btcChangePct === null ? '--' : formatPercent(btcChangePct)}
                </span>
              </div>
              <div className="relative z-10 bg-gray-100 p-4 border-3 border-neo-black rounded-lg">
                <p className="text-neo-black/60 text-sm font-bold uppercase mb-1">Current Price</p>
                <p className="text-4xl lg:text-5xl font-display tracking-tighter">{btcPriceText}</p>
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
                    value={stakeEth}
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
                  className={`group relative bg-[#0bda0b] border-5 border-neo-black h-32 flex flex-col items-center justify-center shadow-neo transition-all rounded-xl hover:bg-[#39ff39] ${
                    betLoading ? 'opacity-60 cursor-not-allowed' : 'active:shadow-none active:translate-x-[8px] active:translate-y-[8px]'
                  }`}
                  onClick={() => handlePlaceBet('up')}
                  title={betHint}
                  type="button"
                  disabled={betLoading}
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
                  className={`group relative bg-[#ff3333] border-5 border-neo-black h-32 flex flex-col items-center justify-center shadow-neo transition-all rounded-xl hover:bg-[#ff5555] ${
                    betLoading ? 'opacity-60 cursor-not-allowed' : 'active:shadow-none active:translate-x-[8px] active:translate-y-[8px]'
                  }`}
                  onClick={() => handlePlaceBet('down')}
                  title={betHint}
                  type="button"
                  disabled={betLoading}
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
              {betLoading && (
                <div className="border-3 border-neo-black bg-neo-black text-primary font-display uppercase text-sm px-4 py-3 rounded-xl shadow-neo-sm animate-pulse">
                  {betLoadingText || 'Loading...'}
                </div>
              )}
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
                  {displayFeedEvents.length ? (
                    displayFeedEvents.map((event) => (
                      <tr
                        className="border-b-2 border-neo-black/10 hover:bg-yellow-50 transition-colors"
                        key={event.id}
                      >
                        <td className="p-4 font-mono font-bold text-neo-black/80">
                          {formatAddress(event.user)}
                        </td>
                        <td className="p-4 text-center">
                          <span
                            className={
                              event.type === 'claim'
                                ? 'bg-primary text-neo-black text-xs font-display px-2 py-1 border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] uppercase'
                                : 'bg-neo-black text-white text-xs font-display px-2 py-1 border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] uppercase'
                            }
                          >
                            {event.type === 'claim' ? 'CLAIM' : 'BET'}
                          </span>
                        </td>
                        <td className="p-4 text-right font-display">
                          {formatEthValue(event.amountEth)} ETH
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        className="p-4 text-center text-sm text-neo-black/60"
                        colSpan={3}
                      >
                        {feedHint}
                      </td>
                    </tr>
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
            © 2025 Predicate Market Inc.
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
