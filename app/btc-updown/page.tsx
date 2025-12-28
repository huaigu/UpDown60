'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { useAppKitNetwork } from '@reown/appkit/react';
import { sepolia } from '@reown/appkit/networks';
import {
  createEncryptedInput,
  decryptMultipleHandles,
  decryptValue,
  fetchPublicDecryption,
  initializeFheInstance,
} from '../../src/lib/fhevmInstance';
import { useFhevm } from '../providers/FhevmProvider';
import { useLiveFeed } from '../providers/LiveFeedProvider';
import type { FeedEvent } from '../providers/LiveFeedProvider';

const CONTRACT_ADDRESSES: Record<number, string> = {
  31337: '0x0000000000000000000000000000000000000000',
  11155111: '0x5F893Cf33715DbaC196229560418C709F0FFA6Ca',
};

const CONTRACT_ABI = [
  'event BetPlaced(uint256 indexed roundId, address indexed user, uint64 stake)',
  'event ClaimPaid(uint256 indexed roundId, address indexed user, uint64 payout)',
  'event RoundInitialized(uint256 indexed roundId, uint256 startTime, uint256 endTime)',
  'event RoundFinalized(uint256 indexed roundId, int256 startPrice, int256 endPrice, uint8 result)',
  'function stakeAmount() view returns (uint64)',
  'function feeBps() view returns (uint16)',
  'function getCurrentRound() view returns (uint256)',
  'function getRoundState(uint256 roundId) view returns (bool,uint256,uint256,int256,int256,uint8,bool,bool,bool)',
  'function getRoundTotals(uint256 roundId) view returns (uint64,uint64,uint64)',
  'function getRoundHandles(uint256 roundId) view returns (bytes32,bytes32)',
  'function getBet(uint256 roundId, address user) view returns (bool,uint64,bool,bool)',
  'function getBetDirectionHandle(uint256 roundId, address user) view returns (bytes32)',
  'function getPendingClaim(uint256 roundId, address user) view returns (bool,bytes32)',
  'function getUserStats(address user) view returns (uint64,uint64,uint256,uint256)',
  'function placeBet(uint256 roundId, bytes32 encryptedDirection, bytes proof) payable',
  'function finalizeRound(uint256 roundId)',
  'function requestRoundReveal(uint256 roundId)',
  'function resolveTotalsCallback(uint256 roundId, bytes cleartexts, bytes proof)',
  'function requestClaim(uint256 roundId)',
  'function claimCallback(uint256 roundId, bytes cleartexts, bytes proof)',
];

const ROUND_SECONDS = 3600;
const SEPOLIA_CHAIN_ID = 11155111;
const PUBLIC_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
const BINANCE_BTC_PRICE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';
const STAKE_ETH = '0.01';
const LOCAL_SUBMISSIONS_KEY = 'btcUpDownLocalSubmissionsV2';
const LOCAL_CLAIM_META_KEY = 'btcUpDownClaimMetaV2';
const LOCAL_LAST_ADDRESS_KEY = 'btcUpDownLastAddressV2';
const SEPOLIA_TX_URL = 'https://sepolia.etherscan.io/tx/';
const ROUND_TIMELINE_PAGE_SIZE = 6;

const formatAddress = (value: string) => {
  if (!value) return '';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

const formatShortAddress = (value: string) => {
  if (!value) return '';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

const normalizeAddress = (value?: string | null) => (value ? value.toLowerCase() : '');

const formatTxHash = (value?: string | null) => {
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

const formatChainlinkPrice = (value?: string | bigint | number | null) => {
  if (value === null || value === undefined) return '--';
  const numeric = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(numeric)) return '--';
  const price = numeric / 1e8;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(price);
};

const formatLocalTime = (timestamp?: number | null) => {
  if (!timestamp) return '--';
  const date = new Date(timestamp * 1000);
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

type LocalSubmission = {
  id: string;
  roundId: number;
  direction: 'up' | 'down' | 'unknown';
  timestamp: number;
  address?: string;
  txHash?: string;
};


type ClaimRoundMeta = {
  resultSet: boolean;
  totalsRevealed: boolean;
  result: number;
  betExists: boolean;
  claimRequested: boolean;
  claimed: boolean;
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
    walletProvider,
  } = useFhevm();
  const { switchNetwork } = useAppKitNetwork();
  const {
    feedEvents,
    lastIndexedBlock,
    feedSyncStatus,
    feedSyncProgress,
    feedSyncError,
    addFeedEvents,
  } = useLiveFeed();
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
  const [roundTotals, setRoundTotals] = useState<RoundTotals | null>(null);
  const [currentRound, setCurrentRound] = useState<number | null>(null);
  const [stakeAmount, setStakeAmount] = useState<bigint | null>(null);
  const [actionError, setActionError] = useState('');
  const [betLoading, setBetLoading] = useState(false);
  const [betLoadingText, setBetLoadingText] = useState('');
  const [hasActiveBet, setHasActiveBet] = useState(false);
  const [claimingRoundId, setClaimingRoundId] = useState<number | null>(null);
  const [claimStatusByRound, setClaimStatusByRound] = useState<Record<number, string>>({});
  const [claimErrorByRound, setClaimErrorByRound] = useState<Record<number, string>>({});
  const [claimMetaByRound, setClaimMetaByRound] = useState<Record<number, ClaimRoundMeta>>({});
  const [directionDecryptingRoundId, setDirectionDecryptingRoundId] = useState<number | null>(null);
  const [directionDecryptStatusByRound, setDirectionDecryptStatusByRound] = useState<Record<number, string>>({});
  const [directionDecryptErrorByRound, setDirectionDecryptErrorByRound] = useState<Record<number, string>>({});
  const [cachedAddress, setCachedAddress] = useState('');
  const [submissionsLoadedKey, setSubmissionsLoadedKey] = useState('');
  const [roundTimelinePage, setRoundTimelinePage] = useState(0);
  const [expandedActivityByRound, setExpandedActivityByRound] = useState<Record<number, boolean>>({});
  const [userStats, setUserStats] = useState<{
    totalBets: number;
    totalWins: number;
    totalWagered: bigint;
    totalPayout: bigint;
  } | null>(null);
  const [btcPrice, setBtcPrice] = useState<string | null>(null);
  const [btcChangePct, setBtcChangePct] = useState<number | null>(null);
  const btcPriceRef = useRef<number | null>(null);
  const placeCardRef = useRef<HTMLDivElement | null>(null);
  const [placeCardHeight, setPlaceCardHeight] = useState<number | null>(null);
  const [blockTimestamp, setBlockTimestamp] = useState<number | null>(null);
  const [blockFetchedAt, setBlockFetchedAt] = useState<number | null>(null);
  const [clientNow, setClientNow] = useState(0);
  const [isHydrated, setIsHydrated] = useState(false);
  const isOnSepolia = chainId === SEPOLIA_CHAIN_ID;
  const displayAddress = isHydrated ? address : '';
  const displayIsConnected = isHydrated ? isConnected : false;
  const displayIsConnecting = isHydrated ? isConnecting : false;
  const displayIsInitialized = isHydrated ? isInitialized : false;
  const displayChainId = isHydrated ? chainId : 0;
  const displayIsOnSepolia = displayChainId === SEPOLIA_CHAIN_ID;
  const publicProvider = useMemo(() => new ethers.JsonRpcProvider(PUBLIC_RPC_URL), []);
  const readProvider = useMemo(() => {
    if (isConnected && isOnSepolia && walletProvider) {
      return new ethers.BrowserProvider(walletProvider);
    }
    return publicProvider;
  }, [isConnected, isOnSepolia, publicProvider, walletProvider]);
  const lastAddressKey = useMemo(() => {
    if (!readContractAddress || readContractAddress === ethers.ZeroAddress) return '';
    return `${LOCAL_LAST_ADDRESS_KEY}:${readChainId}:${readContractAddress.toLowerCase()}`;
  }, [readChainId, readContractAddress]);
  const localSubmissionsKey = useMemo(() => {
    if (!readContractAddress || readContractAddress === ethers.ZeroAddress) return '';
    const owner = (address || cachedAddress || 'anon').toLowerCase();
    return `${LOCAL_SUBMISSIONS_KEY}:${readChainId}:${readContractAddress.toLowerCase()}:${owner}`;
  }, [address, cachedAddress, readChainId, readContractAddress]);
  const claimMetaStorageKey = useMemo(() => {
    if (!readContractAddress || readContractAddress === ethers.ZeroAddress) return '';
    const owner = (address || cachedAddress || '').toLowerCase();
    if (!owner) return '';
    return `${LOCAL_CLAIM_META_KEY}:${readChainId}:${readContractAddress.toLowerCase()}:${owner}`;
  }, [address, cachedAddress, readChainId, readContractAddress]);

  const persistClaimMeta = useCallback(
    (next: Record<number, ClaimRoundMeta>) => {
      if (typeof window === 'undefined' || !claimMetaStorageKey) return;
      try {
        window.localStorage.setItem(claimMetaStorageKey, JSON.stringify(next));
      } catch (err) {
        console.warn('Failed to persist claim metadata', err);
      }
    },
    [claimMetaStorageKey]
  );

  const updateClaimMeta = useCallback(
    (roundId: number, patch: Partial<ClaimRoundMeta>) => {
      setClaimMetaByRound((prev) => {
        const base: ClaimRoundMeta = prev[roundId] || {
          resultSet: false,
          totalsRevealed: false,
          result: 0,
          betExists: true,
          claimRequested: false,
          claimed: false,
        };
        const next = { ...prev, [roundId]: { ...base, ...patch } };
        persistClaimMeta(next);
        return next;
      });
    },
    [persistClaimMeta]
  );

  const totalsRevealed = roundTotals?.totalsRevealed ?? false;
  const isPendingReveal = !roundTotals || !roundTotals.totalsRevealed || !roundTotals.resultSet;
  const stakeEth = stakeAmount ? ethers.formatEther(stakeAmount) : STAKE_ETH;
  const targetRoundId = currentRound !== null ? currentRound + 1 : null;
  const poolValueText = !isPendingReveal && roundTotals
    ? `${ethers.formatEther(roundTotals.totalUp + roundTotals.totalDown)} ETH`
    : 'Pending reveal';
  const pendingRevealClass = isPendingReveal ? 'font-black uppercase' : '';
  const btcPriceText = btcPrice ? `$${btcPrice}` : '$--';
  const btcTrendLabel =
    btcChangePct === null ? '--' : btcChangePct > 0 ? 'UP' : btcChangePct < 0 ? 'DOWN' : 'FLAT';

  useEffect(() => {
    document.body.classList.add('btc-updown-body');
    return () => {
      document.body.classList.remove('btc-updown-body');
    };
  }, []);

  useEffect(() => {
    setUserStats(null);
    setHasActiveBet(false);
    setClaimMetaByRound({});
    setClaimStatusByRound({});
    setClaimErrorByRound({});
    setClaimingRoundId(null);
    setDirectionDecryptStatusByRound({});
    setDirectionDecryptErrorByRound({});
    setDirectionDecryptingRoundId(null);
  }, [address]);

  useEffect(() => {
    if (typeof window === 'undefined' || !lastAddressKey) return;
    const stored = window.localStorage.getItem(lastAddressKey);
    if (stored) {
      setCachedAddress(stored);
      return;
    }
    if (!address && readContractAddress && readContractAddress !== ethers.ZeroAddress) {
      const prefix = `${LOCAL_SUBMISSIONS_KEY}:${readChainId}:${readContractAddress.toLowerCase()}:`;
      const candidates = Object.keys(window.localStorage).filter((key) =>
        key.startsWith(prefix)
      );
      const inferred = candidates
        .map((key) => key.slice(prefix.length))
        .find((value) => value && value !== 'anon');
      if (inferred) {
        window.localStorage.setItem(lastAddressKey, inferred);
        setCachedAddress(inferred);
        return;
      }
    }
    setCachedAddress('');
  }, [address, lastAddressKey, readChainId, readContractAddress]);

  useEffect(() => {
    if (typeof window === 'undefined' || !lastAddressKey || !address) return;
    const normalized = address.toLowerCase();
    window.localStorage.setItem(lastAddressKey, normalized);
    setCachedAddress(normalized);
  }, [address, lastAddressKey]);

  useEffect(() => {
    if (typeof window === 'undefined' || !localSubmissionsKey) return;
    const stored = window.localStorage.getItem(localSubmissionsKey);
    let nextSubmissions: LocalSubmission[] = [];
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as LocalSubmission[];
        if (Array.isArray(parsed)) {
          nextSubmissions = parsed;
        }
      } catch (err) {
        console.warn('Failed to parse local submissions cache', err);
      }
    }
    if (!nextSubmissions.length && address) {
      const legacy = window.localStorage.getItem(LOCAL_SUBMISSIONS_KEY);
      if (legacy) {
        try {
          const parsed = JSON.parse(legacy) as LocalSubmission[];
          if (Array.isArray(parsed)) {
            const filtered = parsed.filter(
              (item) => item.address?.toLowerCase() === address.toLowerCase()
            );
            if (filtered.length) {
              nextSubmissions = filtered;
              window.localStorage.setItem(localSubmissionsKey, JSON.stringify(filtered));
            }
          }
        } catch (err) {
          console.warn('Failed to parse legacy submissions cache', err);
        }
      }
    }
    setLocalSubmissions(nextSubmissions);
    setSubmissionsLoadedKey(localSubmissionsKey);
  }, [localSubmissionsKey, address]);

  useEffect(() => {
    if (typeof window === 'undefined' || !claimMetaStorageKey) return;
    const stored = window.localStorage.getItem(claimMetaStorageKey);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as Record<number, ClaimRoundMeta>;
      if (parsed && typeof parsed === 'object') {
        setClaimMetaByRound(parsed);
      }
    } catch (err) {
      console.warn('Failed to parse claim metadata cache', err);
    }
  }, [claimMetaStorageKey]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !localSubmissionsKey ||
      submissionsLoadedKey !== localSubmissionsKey
    ) {
      return;
    }
    window.localStorage.setItem(localSubmissionsKey, JSON.stringify(localSubmissions));
  }, [localSubmissions, localSubmissionsKey, submissionsLoadedKey]);

  useEffect(() => {
    if (!placeCardRef.current) return;
    const element = placeCardRef.current;
    const updateHeight = () => {
      setPlaceCardHeight(element.getBoundingClientRect().height);
    };
    updateHeight();
    const observer = new ResizeObserver(() => updateHeight());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
    if (!hasReadContract) {
      setClaimMetaByRound({});
      return;
    }
    const rounds = Array.from(new Set(localSubmissions.map((submission) => submission.roundId)));
    if (!rounds.length) {
      setClaimMetaByRound({});
      return;
    }
    let isActive = true;
    const resolvedAddress = address || cachedAddress;
    const addressLower = resolvedAddress?.toLowerCase() || '';
    const roundsForUser = addressLower
      ? rounds.filter((roundId) =>
          localSubmissions.some(
            (submission) =>
              submission.roundId === roundId &&
              submission.address?.toLowerCase() === addressLower
          )
        )
      : [];

    const loadClaimMeta = async () => {
      try {
        const contract = getReadContract();
        const entries = await Promise.all(
          rounds.map(async (roundId): Promise<[number, ClaimRoundMeta]> => {
            const state = await contract.getRoundState(roundId);
            let betInfo = null;
            if (roundsForUser.includes(roundId) && addressLower && resolvedAddress) {
              betInfo = await contract.getBet(roundId, resolvedAddress);
            }
            return [
              roundId,
              {
                resultSet: state[6],
                totalsRevealed: state[8],
                result: Number(state[5]),
                betExists: betInfo ? betInfo[0] : false,
                claimRequested: betInfo ? betInfo[2] : false,
                claimed: betInfo ? betInfo[3] : false,
              },
            ];
          })
        );
        if (!isActive) return;
        setClaimMetaByRound((prev) => {
          const next = { ...prev };
          entries.forEach(([roundId, meta]) => {
            next[roundId] = meta;
          });
          persistClaimMeta(next);
          return next;
        });
      } catch (err) {
        if (!isActive) return;
        console.warn('Failed to load claim metadata', err);
      }
    };

    loadClaimMeta();
    const interval = window.setInterval(loadClaimMeta, 15000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [hasReadContract, localSubmissions, address, cachedAddress, readProvider, readContractAddress, persistClaimMeta]);

  useEffect(() => {
    let isActive = true;
    const loadBetStatus = async () => {
      if (!hasReadContract || !address || targetRoundId === null) {
        if (isActive) {
          setHasActiveBet(false);
        }
        return;
      }
      try {
        const contract = getReadContract();
        const bet = await contract.getBet(targetRoundId, address);
        if (!isActive) return;
        setHasActiveBet(Boolean(bet[0]));
      } catch (err) {
        if (!isActive) return;
        console.warn('Failed to load bet status', err);
        setHasActiveBet(false);
      }
    };

    loadBetStatus();
    const interval = window.setInterval(loadBetStatus, 10000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [hasReadContract, address, targetRoundId, readProvider, readContractAddress]);

  useEffect(() => {
    let isActive = true;
    const loadUserStats = async () => {
      if (!hasReadContract || !address) {
        if (isActive) {
          setUserStats(null);
        }
        return;
      }
      try {
        const contract = getReadContract();
        const stats = await contract.getUserStats(address);
        if (!isActive) return;
        setUserStats({
          totalBets: Number(stats[0]),
          totalWins: Number(stats[1]),
          totalWagered: BigInt(stats[2]),
          totalPayout: BigInt(stats[3]),
        });
      } catch (err) {
        if (!isActive) return;
        console.warn('Failed to load user stats', err);
        setUserStats(null);
      }
    };

    loadUserStats();
    const interval = window.setInterval(loadUserStats, 15000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [hasReadContract, address, readProvider, readContractAddress]);

  useEffect(() => {
    if (!isConnected || isInitialized || isInitializing || !isOnSepolia) return;
    setIsInitializing(true);
    initialize().finally(() => {
      setIsInitializing(false);
    });
  }, [isConnected, isInitialized, isInitializing, initialize, isOnSepolia]);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    let isActive = true;
    const loadBtcPrice = async () => {
      try {
        const response = await fetch(BINANCE_BTC_PRICE_URL, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Binance price request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isActive) return;
        const numeric = Number(data?.price);
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
        console.warn('Failed to load BTC price from Binance', err);
      }
    };

    loadBtcPrice();
    const interval = window.setInterval(loadBtcPrice, 15000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, []);

  const parseReceiptLogs = (
    receipt: ethers.TransactionReceipt,
    iface: ethers.Interface,
    contractAddr: string
  ) => {
    const mapped: FeedEvent[] = [];
    receipt.logs.forEach((log) => {
      if (log.address.toLowerCase() !== contractAddr.toLowerCase()) return;
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (!parsed) return;
        const base = {
          id: `${log.transactionHash}-${log.index ?? 0}`,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber ?? 0,
          logIndex: log.index ?? 0,
        };
        if (parsed.name === 'BetPlaced') {
          mapped.push({
            ...base,
            type: 'bet',
            user: parsed.args?.user as string,
            roundId: Number(parsed.args?.roundId ?? 0),
            amountEth: ethers.formatEther(parsed.args?.stake ?? BigInt(0)),
          });
        } else if (parsed.name === 'ClaimPaid') {
          mapped.push({
            ...base,
            type: 'claim',
            user: parsed.args?.user as string,
            roundId: Number(parsed.args?.roundId ?? 0),
            amountEth: ethers.formatEther(parsed.args?.payout ?? BigInt(0)),
          });
        } else if (parsed.name === 'RoundInitialized') {
          mapped.push({
            ...base,
            type: 'round-init',
            roundId: Number(parsed.args?.roundId ?? 0),
            startTime: Number(parsed.args?.startTime ?? 0),
            endTime: Number(parsed.args?.endTime ?? 0),
          });
        } else if (parsed.name === 'RoundFinalized') {
          mapped.push({
            ...base,
            type: 'round-final',
            roundId: Number(parsed.args?.roundId ?? 0),
            startPrice: parsed.args?.startPrice?.toString?.(),
            endPrice: parsed.args?.endPrice?.toString?.(),
            result: Number(parsed.args?.result ?? 0),
          });
        }
      } catch (err) {
        return;
      }
    });
    return mapped;
  };

  useEffect(() => {
    if (!feedEvents.length) return;
    const owner = normalizeAddress(address || cachedAddress);
    if (!owner) return;
    const betEvents = feedEvents.filter(
      (event) => event.type === 'bet' && normalizeAddress(event.user) === owner
    );
    if (!betEvents.length) return;
    setLocalSubmissions((prev) => {
      const existingTx = new Set(
        prev.map((item) => normalizeAddress(item.txHash)).filter(Boolean)
      );
      const existingRoundIndex = new Map<number, number>();
      const next = [...prev];
      next.forEach((item, index) => {
        existingRoundIndex.set(item.roundId, index);
      });
      const additions: LocalSubmission[] = [];
      let updated = false;
      betEvents.forEach((event) => {
        const txKey = normalizeAddress(event.txHash);
        if (txKey && existingTx.has(txKey)) return;
        const existingIndex = existingRoundIndex.get(event.roundId);
        if (existingIndex !== undefined) {
          const current = next[existingIndex];
          let changedItem = current;
          if (!current.txHash && event.txHash) {
            changedItem = { ...changedItem, txHash: event.txHash };
          }
          if (!current.address && event.user) {
            changedItem = { ...changedItem, address: event.user };
          }
          if (changedItem !== current) {
            next[existingIndex] = changedItem;
            updated = true;
          }
          return;
        }
        additions.push({
          id: `${event.roundId}-${event.blockNumber}-${event.txHash}`,
          roundId: event.roundId,
          direction: 'unknown',
          timestamp: Date.now(),
          address: event.user || owner,
          txHash: event.txHash,
        });
      });
      if (!additions.length && !updated) return prev;
      return [...additions, ...next].slice(0, 6);
    });
  }, [feedEvents, address, cachedAddress]);

  useEffect(() => {
    if (hasReadContract) return;
    setRoundTotals(null);
    setCurrentRound(null);
    setStakeAmount(null);
  }, [hasReadContract]);

  const ensureSepolia = async () => {
    if (!walletProvider) {
      throw new Error('No wallet found');
    }
    if (chainId === SEPOLIA_CHAIN_ID) {
      return;
    }
    await switchNetwork(sepolia);
  };

  const getProvider = () => {
    if (!walletProvider) {
      throw new Error('No wallet found');
    }
    return new ethers.BrowserProvider(walletProvider);
  };

  const getReadContract = () => {
    return new ethers.Contract(readContractAddress, CONTRACT_ABI, readProvider);
  };

  const getWriteContract = async (addressOverride?: string) => {
    const provider = getProvider();
    const signer = await provider.getSigner();
    return new ethers.Contract(addressOverride || contractAddress, CONTRACT_ABI, signer);
  };

  const handleLocalSubmit = (
    directionValue: 'up' | 'down',
    roundIdOverride?: number,
    txHash?: string
  ) => {
    const targetRound =
      roundIdOverride ?? Math.floor(Date.now() / 1000 / ROUND_SECONDS) + 1;
    const owner = normalizeAddress(address || '');
    const txKey = normalizeAddress(txHash);
    setLocalSubmissions((prev) => {
      if (txKey && prev.some((item) => normalizeAddress(item.txHash) === txKey)) {
        return prev;
      }
      const existingIndex = prev.findIndex(
        (item) => item.roundId === targetRound && normalizeAddress(item.address) === owner
      );
      if (existingIndex !== -1) {
        const existing = prev[existingIndex];
        const nextItem = {
          ...existing,
          direction: directionValue,
          txHash: txHash || existing.txHash,
          address: existing.address || address || undefined,
        };
        const changed =
          nextItem.direction !== existing.direction ||
          nextItem.txHash !== existing.txHash ||
          nextItem.address !== existing.address;
        if (!changed) return prev;
        const next = [...prev];
        next[existingIndex] = nextItem;
        return next;
      }
      const newSubmission: LocalSubmission = {
        id: `${targetRound}-${Date.now()}`,
        roundId: targetRound,
        direction: directionValue,
        timestamp: Date.now(),
        address: address || undefined,
        txHash,
      };
      return [newSubmission, ...prev].slice(0, 6);
    });
  };

  const handlePlaceBet = async (directionValue: 'up' | 'down') => {
    setActionError('');
    if (betLoading || hasActiveBet) return;
    setBetLoading(true);
    try {
      if (!walletProvider) {
        throw new Error('No wallet found');
      }
      if (!isConnected) {
        setBetLoadingText('Connecting wallet...');
        await handleConnect();
      }
      const userAddress = address;
      if (!userAddress) {
        throw new Error('Wallet not connected');
      }
      const connectedChainId = chainId;
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
      if (tx?.hash) {
        handleLocalSubmit(directionValue, targetRound, tx.hash);
      }
      const receipt = await tx.wait();
      if (receipt) {
        const receiptEvents = parseReceiptLogs(receipt, contract.interface, addressForChain);
        if (receiptEvents.length || receipt.blockNumber) {
          addFeedEvents(receiptEvents, receipt.blockNumber);
        }
      }
      setHasActiveBet(true);
    } catch (err: any) {
      setActionError(err?.message || 'Bet failed');
    } finally {
      setBetLoading(false);
      setBetLoadingText('');
    }
  };

  const handleDecryptDirection = async (roundId: number) => {
    setDirectionDecryptErrorByRound((prev) => ({ ...prev, [roundId]: '' }));
    if (directionDecryptingRoundId !== null) return;
    setDirectionDecryptingRoundId(roundId);
    setDirectionDecryptStatusByRound((prev) => ({ ...prev, [roundId]: 'Preparing...' }));
    try {
      if (!walletProvider) {
        throw new Error('No wallet found');
      }
      if (!isConnected) {
        setDirectionDecryptStatusByRound((prev) => ({ ...prev, [roundId]: 'Connecting wallet...' }));
        await handleConnect();
      }
      const userAddress = address;
      if (!userAddress) {
        throw new Error('Wallet not connected');
      }
      const connectedChainId = chainId;
      if (connectedChainId !== SEPOLIA_CHAIN_ID) {
        throw new Error('Switch to Sepolia to decrypt');
      }
      const addressForChain = CONTRACT_ADDRESSES[connectedChainId] || '';
      if (!addressForChain || addressForChain === ethers.ZeroAddress) {
        throw new Error('Contract address missing');
      }
      if (!isInitialized) {
        setDirectionDecryptStatusByRound((prev) => ({ ...prev, [roundId]: 'Initializing FHEVM...' }));
        await initialize();
      }
      const readContract = getReadContract();
      const handle = await readContract.getBetDirectionHandle(roundId, userAddress);
      if (!handle || handle === ethers.ZeroHash) {
        throw new Error('Direction handle missing');
      }
      setDirectionDecryptStatusByRound((prev) => ({ ...prev, [roundId]: 'Decrypting...' }));
      const signer = await getProvider().getSigner();
      const value = await decryptValue(handle, addressForChain, signer);
      const directionValue = value === 1 ? 'up' : 'down';
      setLocalSubmissions((prev) =>
        prev.map((item) =>
          item.roundId === roundId ? { ...item, direction: directionValue } : item
        )
      );
      setDirectionDecryptStatusByRound((prev) => ({ ...prev, [roundId]: 'Decrypted' }));
    } catch (err: any) {
      setDirectionDecryptErrorByRound((prev) => ({
        ...prev,
        [roundId]: err?.message || 'Decrypt failed',
      }));
      setDirectionDecryptStatusByRound((prev) => ({ ...prev, [roundId]: '' }));
    } finally {
      setDirectionDecryptingRoundId(null);
    }
  };

  const handleClaimForRound = async (roundId: number) => {
    setClaimErrorByRound((prev) => ({ ...prev, [roundId]: '' }));
    if (claimingRoundId !== null) return;
    setClaimingRoundId(roundId);
    setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Preparing claim...' }));
    try {
      if (!walletProvider) {
        throw new Error('No wallet found');
      }
      if (!isConnected) {
        setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Connecting wallet...' }));
        await handleConnect();
      }
      const userAddress = address;
      if (!userAddress) {
        throw new Error('Wallet not connected');
      }
      const connectedChainId = chainId;
      if (connectedChainId !== SEPOLIA_CHAIN_ID) {
        throw new Error('Switch to Sepolia to claim');
      }
      const addressForChain = CONTRACT_ADDRESSES[connectedChainId] || '';
      if (!addressForChain || addressForChain === ethers.ZeroAddress) {
        throw new Error('Contract address missing');
      }
      if (!isInitialized) {
        setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Initializing FHEVM...' }));
        await initialize();
      }

      const readContract = getReadContract();
      const roundState = await readContract.getRoundState(roundId);
      const resultValue = Number(roundState[5]);
      const resultSet = roundState[6];
      const revealRequested = roundState[7];
      const totalsRevealed = roundState[8];

      if (!resultSet) {
        throw new Error('Result not set yet');
      }

      if (resultValue !== 3 && !totalsRevealed) {
        const writeContract = await getWriteContract(addressForChain);
        if (!revealRequested) {
          setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Requesting reveal...' }));
          const revealTx = await writeContract.requestRoundReveal(roundId);
          await revealTx.wait();
        }
        setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Decrypting totals...' }));
        const handles = await readContract.getRoundHandles(roundId);
        const totalUpHandle = handles[0];
        const totalDownHandle = handles[1];
        if (
          !totalUpHandle ||
          totalUpHandle === ethers.ZeroHash ||
          !totalDownHandle ||
          totalDownHandle === ethers.ZeroHash
        ) {
          throw new Error('Totals handles missing');
        }
        const result = await fetchPublicDecryption([totalUpHandle, totalDownHandle]);
        let cleartexts = result?.abiEncodedClearValues;
        if (!cleartexts) {
          const clearValues = result?.clearValues;
          if (!clearValues || typeof clearValues !== 'object') {
            throw new Error('Missing clear values for totals');
          }
          const rawUp = clearValues[totalUpHandle] ?? Object.values(clearValues)[0];
          const rawDown = clearValues[totalDownHandle] ?? Object.values(clearValues)[1];
          if (rawUp === undefined || rawDown === undefined) {
            throw new Error('Missing clear values for totals');
          }
          const totalUp = typeof rawUp === 'bigint' ? rawUp : BigInt(rawUp || 0);
          const totalDown = typeof rawDown === 'bigint' ? rawDown : BigInt(rawDown || 0);
          const abiCoder = ethers.AbiCoder.defaultAbiCoder();
          cleartexts = abiCoder.encode(['uint64', 'uint64'], [totalUp, totalDown]);
        }
        const proof = result?.decryptionProof;
        if (!proof) {
          throw new Error('Missing decryption proof');
        }

        setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Submitting reveal...' }));
        const resolveTx = await writeContract.resolveTotalsCallback(roundId, cleartexts, proof);
        await resolveTx.wait();
        updateClaimMeta(roundId, {
          resultSet: true,
          totalsRevealed: true,
          result: resultValue,
        });
      } else {
        updateClaimMeta(roundId, {
          resultSet: true,
          totalsRevealed,
          result: resultValue,
        });
      }

      let pending = await readContract.getPendingClaim(roundId, userAddress);
      if (!pending[0]) {
        setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Requesting claim...' }));
        const contract = await getWriteContract(addressForChain);
        const tx = await contract.requestClaim(roundId);
        await tx.wait();
        pending = await readContract.getPendingClaim(roundId, userAddress);
      }

      if (!pending[0]) {
        setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Claim completed' }));
        updateClaimMeta(roundId, { claimed: true });
        return;
      }

      updateClaimMeta(roundId, { claimRequested: true });

      const pendingHandle = pending[1];
      if (!pendingHandle || pendingHandle === ethers.ZeroHash) {
        setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Claim submitted' }));
        return;
      }

      setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Decrypting payout...' }));
      const result = await fetchPublicDecryption([pendingHandle]);
      let cleartexts = result?.abiEncodedClearValues;
      if (!cleartexts) {
        const clearValues = result?.clearValues || {};
        const rawValue = clearValues[pendingHandle] ?? Object.values(clearValues)[0];
        const payout = typeof rawValue === 'bigint' ? rawValue : BigInt(rawValue || 0);
        const abiCoder = ethers.AbiCoder.defaultAbiCoder();
        cleartexts = abiCoder.encode(['uint64'], [payout]);
      }
      const proof = result?.decryptionProof;
      if (!proof) {
        throw new Error('Missing decryption proof');
      }

      setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Submitting claim...' }));
      const contract = await getWriteContract(addressForChain);
      const claimTx = await contract.claimCallback(roundId, cleartexts, proof);
      await claimTx.wait();
      setClaimStatusByRound((prev) => ({ ...prev, [roundId]: 'Claim completed' }));
      updateClaimMeta(roundId, { claimed: true, claimRequested: true });
    } catch (err: any) {
      setClaimErrorByRound((prev) => ({
        ...prev,
        [roundId]: err?.message || 'Claim failed',
      }));
    } finally {
      setClaimingRoundId(null);
    }
  };

  const handleConnect = async () => {
    if (isConnecting || isInitializing || isSwitchingNetwork) return;
    setNetworkError('');
    try {
      setIsSwitchingNetwork(true);
      await connect();
      await ensureSepolia();
    } catch (err: any) {
      setNetworkError(err?.message || 'Failed to switch network');
    } finally {
      setIsSwitchingNetwork(false);
    }
  };

  const connectLabel = isSwitchingNetwork
    ? 'Switching...'
    : displayIsConnected
      ? displayIsInitialized
        ? 'Connected'
        : 'Initializing...'
      : displayIsConnecting
        ? 'Connecting...'
        : 'Connect';
  const connectSubLabel =
    displayIsConnected && displayAddress ? formatShortAddress(displayAddress) : '';

  const statusHint =
    walletError ||
    error ||
    networkError ||
    (displayAddress
      ? displayIsOnSepolia
        ? `Wallet: ${displayAddress}`
        : 'Switch to Sepolia'
      : displayIsInitialized
        ? 'FHEVM ready'
        : displayIsConnected
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
    const distributable = losingTotal > fee ? losingTotal - fee : BigInt(0);
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
  const displayTargetRoundId = targetRoundId ?? displayRoundId + 1;
  const isInitialSync = lastIndexedBlock === null;
  const feedHint = !hasReadContract
    ? 'Contract address missing.'
    : feedSyncError
      ? feedSyncError
        : isInitialSync
        ? feedSyncStatus || 'Syncing history from deployment...'
        : `Live. Synced to block #${lastIndexedBlock ?? '--'}. Round events, bets, and claims appear here.`;
  const roundGroups = useMemo(() => {
    const byRound = new Map<
      number,
      {
        roundId: number;
        init?: FeedEvent;
        final?: FeedEvent;
        activity: FeedEvent[];
        lastBlock: number;
        lastLogIndex: number;
      }
    >();
    const isNewer = (candidate: FeedEvent, existing?: FeedEvent) => {
      if (!existing) return true;
      if (candidate.blockNumber !== existing.blockNumber) {
        return candidate.blockNumber > existing.blockNumber;
      }
      return candidate.logIndex > existing.logIndex;
    };

    feedEvents.forEach((event) => {
      const existing = byRound.get(event.roundId);
      const base = existing || {
        roundId: event.roundId,
        init: undefined,
        final: undefined,
        activity: [],
        lastBlock: event.blockNumber,
        lastLogIndex: event.logIndex,
      };
      if (event.type === 'round-init' && isNewer(event, base.init)) {
        base.init = event;
      }
      if (event.type === 'round-final' && isNewer(event, base.final)) {
        base.final = event;
      }
      if (event.type === 'bet' || event.type === 'claim') {
        base.activity.push(event);
      }
      if (
        event.blockNumber > base.lastBlock ||
        (event.blockNumber === base.lastBlock && event.logIndex > base.lastLogIndex)
      ) {
        base.lastBlock = event.blockNumber;
        base.lastLogIndex = event.logIndex;
      }
      byRound.set(event.roundId, base);
    });

    return Array.from(byRound.values())
      .map((group) => ({
        ...group,
        activity: [...group.activity].sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber;
          return b.logIndex - a.logIndex;
        }),
      }))
      .sort((a, b) => {
        if (a.roundId !== b.roundId) return b.roundId - a.roundId;
        if (a.lastBlock !== b.lastBlock) return b.lastBlock - a.lastBlock;
        return b.lastLogIndex - a.lastLogIndex;
      });
  }, [feedEvents]);
  const totalRoundPages = Math.ceil(roundGroups.length / ROUND_TIMELINE_PAGE_SIZE);
  const activeRoundPage = Math.min(
    roundTimelinePage,
    Math.max(totalRoundPages - 1, 0)
  );
  const pagedRoundGroups = roundGroups.slice(
    activeRoundPage * ROUND_TIMELINE_PAGE_SIZE,
    activeRoundPage * ROUND_TIMELINE_PAGE_SIZE + ROUND_TIMELINE_PAGE_SIZE
  );
  const showTimelinePagination = totalRoundPages > 1;
  const hasFeedContent = roundGroups.length > 0;
  useEffect(() => {
    if (roundTimelinePage !== activeRoundPage) {
      setRoundTimelinePage(activeRoundPage);
    }
  }, [roundTimelinePage, activeRoundPage]);
  const roundResultId = currentRound && currentRound > 0 ? currentRound - 1 : null;
  const getFeedUserLabel = (event: FeedEvent) => {
    if (event.type === 'bet' || event.type === 'claim') {
      const user = event.user || '';
      if (normalizeAddress(user) && normalizeAddress(address) === normalizeAddress(user)) {
        return 'Me';
      }
      return formatShortAddress(user);
    }
    return 'SYSTEM';
  };
  const getRoundResultLabel = (value?: number) => {
    if (value === 1) return 'UP';
    if (value === 2) return 'DOWN';
    if (value === 3) return 'TIE';
    return '--';
  };
  const getRoundResultClass = (value?: number) => {
    if (value === 1) return 'bg-[#0bda0b] text-white';
    if (value === 2) return 'bg-[#ff3333] text-white';
    if (value === 3) return 'bg-gray-300 text-neo-black';
    return 'bg-white text-neo-black';
  };
  const recentRoundResults = useMemo(() => {
    const sortedResults = feedEvents
      .filter(
        (event) =>
          event.type === 'round-final' &&
          (event.result === 1 || event.result === 2 || event.result === 3)
      )
      .sort((a, b) => {
        if (a.roundId !== b.roundId) return b.roundId - a.roundId;
        if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber;
        return b.logIndex - a.logIndex;
      });

    const seen = new Set<number>();
    const results: Array<{ roundId: number; result: number }> = [];
    sortedResults.forEach((event) => {
      if (seen.has(event.roundId)) return;
      seen.add(event.roundId);
      results.push({ roundId: event.roundId, result: event.result as number });
    });

    if (
      roundResultId &&
      roundTotals?.resultSet &&
      (roundTotals.result === 1 || roundTotals.result === 2 || roundTotals.result === 3) &&
      !seen.has(roundResultId)
    ) {
      results.push({ roundId: roundResultId, result: roundTotals.result });
    }

    return results.sort((a, b) => b.roundId - a.roundId).slice(0, 10);
  }, [feedEvents, roundResultId, roundTotals]);
  const marqueeResults =
    recentRoundResults.length > 0
      ? [...recentRoundResults, ...recentRoundResults]
      : [];
  const winRateText = userStats
    ? userStats.totalBets > 0
      ? `${Math.round((userStats.totalWins / userStats.totalBets) * 100)}%`
      : '0%'
    : '--';
  const totalWageredText = userStats
    ? `${formatEthValue(ethers.formatEther(userStats.totalWagered))} ETH`
    : '--';
  const netProfitValue = userStats
    ? userStats.totalPayout - userStats.totalWagered
    : null;
  const netProfitText =
    netProfitValue === null
      ? '--'
      : `${netProfitValue > BigInt(0) ? '+' : netProfitValue < BigInt(0) ? '-' : ''}${formatEthValue(
          ethers.formatEther(netProfitValue < BigInt(0) ? -netProfitValue : netProfitValue)
        )} ETH`;
  const netProfitClass =
    netProfitValue === null
      ? 'text-neo-black'
      : netProfitValue > BigInt(0)
        ? 'text-[#0bda0b]'
        : netProfitValue < BigInt(0)
          ? 'text-[#ff3333]'
          : 'text-neo-black';
  const canBet = displayIsConnected && displayIsOnSepolia && displayIsInitialized && hasContract;
  const betDisabled = betLoading || !canBet || hasActiveBet;
  const betHint =
    actionError ||
    (hasActiveBet
      ? 'Already placed a bet for this round'
      : canBet
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
              BTC<span className="text-secondary">UPDOWN60</span>
            </h1>
          </div>
          <nav className="hidden md:flex items-center gap-4">
            <a
              className="bg-white px-6 py-3 text-lg font-display uppercase border-3 border-neo-black shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
              href="/"
            >
              Markets
            </a>
            <a
              className="bg-white px-6 py-3 text-lg font-display uppercase border-3 border-neo-black shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
              href="/leaderboard"
            >
              Leaderboard
            </a>
            <a
              className="bg-white px-6 py-3 text-lg font-display uppercase border-3 border-neo-black shadow-neo-sm hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all"
              href="/guide"
            >
              Guide
            </a>
          </nav>
          <button
            className="flex items-center gap-3 bg-secondary text-white px-8 py-4 font-display text-lg uppercase border-3 border-neo-black shadow-neo hover:translate-x-[4px] hover:translate-y-[4px] hover:shadow-neo-hover active:translate-x-[8px] active:translate-y-[8px] active:shadow-none transition-all rotate-1"
            onClick={handleConnect}
            title={statusHint}
            type="button"
          >
            <span className="material-symbols-outlined text-[24px]">wallet</span>
            <span className="flex flex-col leading-none items-start">
              <span>{connectLabel}</span>
              {connectSubLabel ? (
                <span className="mt-1 text-[10px] font-mono text-white/80">
                  {connectSubLabel}
                </span>
              ) : null}
            </span>
          </button>
        </div>
      </header>
      <div className="bg-neo-black border-b-6 border-neo-black overflow-hidden whitespace-nowrap py-3 flex items-center rotate-0">
        <div className="animate-marquee inline-flex items-center">
          {marqueeResults.length ? (
            marqueeResults.map((item, index) => (
              <div className="flex items-center gap-3 mx-8" key={`${item.roundId}-${index}`}>
                <span className="text-white/70 font-display text-sm uppercase tracking-[0.2em]">
                  Round #{item.roundId}
                </span>
                <span
                  className={`${getRoundResultClass(
                    item.result
                  )} px-3 py-1 border-2 border-neo-black shadow-neo-sm font-display text-lg uppercase`}
                >
                  {getRoundResultLabel(item.result)}
                </span>
              </div>
            ))
          ) : (
            <div className="flex items-center gap-3 mx-8">
              <span className="text-white/80 font-display text-lg uppercase">
                Awaiting results
              </span>
            </div>
          )}
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
                <div className="flex items-center gap-2 mb-3">
                  <span className="bg-secondary text-white text-[10px] font-display uppercase px-2 py-1 border-2 border-neo-black shadow-neo-sm">
                    Betting on #{displayTargetRoundId}
                  </span>
                  <span className="text-[10px] uppercase text-neo-black/60">
                    Next round only
                  </span>
                  <span
                    className="material-symbols-outlined text-[14px] text-neo-black/50"
                    title="Bets are placed for the next round to keep timing fair for everyone."
                  >
                    help
                  </span>
                </div>
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
                    btcChangePct === null || btcChangePct === 0
                      ? 'bg-white text-neo-black'
                      : btcChangePct > 0
                        ? 'bg-[#0bda0b] text-white'
                        : 'bg-[#ff3333] text-white'
                  }`}
                >
                  {btcTrendLabel}
                </span>
              </div>
              <div className="relative z-10 bg-gray-100 p-4 border-3 border-neo-black rounded-lg">
                <p className="text-neo-black/60 text-sm font-bold uppercase mb-1">
                  CEX Price (Binance)
                </p>
                <p className="text-4xl lg:text-5xl font-display tracking-tighter">{btcPriceText}</p>
                <p className="text-xs text-neo-black/60 mt-2">CEX price, not on-chain.</p>
              </div>
            </div>
            <div
              className="border-5 border-neo-black bg-gray-200 p-6 flex flex-col justify-between relative overflow-hidden shadow-neo rounded-xl opacity-70 grayscale pointer-events-none"
              aria-disabled="true"
            >
              <div className="absolute -right-10 -bottom-10 opacity-30">
                <span className="material-symbols-outlined text-neo-black/20 text-[180px]">
                  show_chart
                </span>
              </div>
              <div className="flex justify-between items-start mb-6 relative z-10">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center border-4 border-neo-black">
                    <span className="material-symbols-outlined text-neo-black text-4xl">token</span>
                  </div>
                  <span className="text-4xl font-display text-neo-black/70">ETH</span>
                </div>
                <span className="bg-gray-100 text-neo-black/70 border-3 border-neo-black px-3 py-1 text-xl font-display uppercase transform -rotate-2">
                  N/A
                </span>
              </div>
              <div className="relative z-10 bg-gray-100 p-4 border-3 border-neo-black rounded-lg">
                <p className="text-neo-black/60 text-sm font-bold uppercase mb-1">Current Price</p>
                <p className="text-4xl lg:text-5xl font-display tracking-tighter text-neo-black/70">
                  $3,450.00
                </p>
              </div>
            </div>
          </div>
          <div
            className="border-6 border-neo-black bg-white p-8 relative shadow-neo rounded-2xl"
            ref={placeCardRef}
          >
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
                    betDisabled ? 'opacity-60 cursor-not-allowed' : 'active:shadow-none active:translate-x-[8px] active:translate-y-[8px]'
                  }`}
                  onClick={() => handlePlaceBet('up')}
                  title={betHint}
                  type="button"
                  disabled={betDisabled}
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
                    betDisabled ? 'opacity-60 cursor-not-allowed' : 'active:shadow-none active:translate-x-[8px] active:translate-y-[8px]'
                  }`}
                  onClick={() => handlePlaceBet('down')}
                  title={betHint}
                  type="button"
                  disabled={betDisabled}
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
                    {displaySubmissions.map((submission) => {
                      const meta = claimMetaByRound[submission.roundId];
                      const addressLower = submission.address?.toLowerCase() || '';
                      const currentAddressLower = address?.toLowerCase() || '';
                      const hasActiveWallet = isConnected && !!currentAddressLower;
                      const isSameWallet = hasActiveWallet && !!addressLower && addressLower === currentAddressLower;
                      const canClaimBase = isSameWallet && isOnSepolia && hasContract;
                      const claimInFlight = claimingRoundId === submission.roundId;
                      const directionKnown = submission.direction === 'up' || submission.direction === 'down';
                      const canDecryptDirection = !directionKnown && isSameWallet && isOnSepolia && hasContract;
                      const decryptInFlight = directionDecryptingRoundId === submission.roundId;

                      let claimLabel = 'Pending';
                      let claimEnabled = false;
                      let claimBadgeClass = 'bg-gray-200 text-neo-black';

                      if (!hasActiveWallet) {
                        claimLabel = 'Connect wallet';
                      } else if (!submission.address) {
                        claimLabel = 'No wallet';
                      } else if (!isSameWallet) {
                        claimLabel = 'Wallet mismatch';
                      } else if (!meta) {
                        claimLabel = 'Checking...';
                      } else if (!meta.betExists) {
                        claimLabel = 'No bet';
                      } else if (meta.claimed) {
                        claimLabel = 'Claimed';
                        claimBadgeClass = 'bg-primary text-neo-black';
                      } else if (!meta.resultSet) {
                        claimLabel = 'Result pending';
                      } else if (meta.result === 3) {
                        claimLabel = meta.claimRequested ? 'Finalize' : 'Refund';
                        claimEnabled = canClaimBase;
                        claimBadgeClass = 'bg-secondary text-white';
                      } else if (!directionKnown) {
                        claimLabel = 'Decrypt to see';
                      } else {
                        const isWinner =
                          directionKnown &&
                          ((meta.result === 1 && submission.direction === 'up') ||
                            (meta.result === 2 && submission.direction === 'down'));
                        if (directionKnown && !isWinner) {
                          claimLabel = 'Lost';
                        } else if (!meta.totalsRevealed) {
                          claimLabel = 'Reveal & Claim';
                          claimEnabled = canClaimBase;
                          claimBadgeClass = 'bg-secondary text-white';
                        } else {
                          claimLabel = meta.claimRequested ? 'Finalize' : 'Claim';
                          claimEnabled = canClaimBase;
                          claimBadgeClass = 'bg-secondary text-white';
                        }
                      }

                      const claimStatus = claimStatusByRound[submission.roundId];
                      const claimError = claimErrorByRound[submission.roundId];
                      const decryptStatus = directionDecryptStatusByRound[submission.roundId];
                      const decryptError = directionDecryptErrorByRound[submission.roundId];
                      const txHash = submission.txHash;

                      return (
                        <div
                          className="flex items-center justify-between bg-white border-2 border-neo-black px-3 py-2 rounded-lg"
                          key={submission.id}
                        >
                          <div className="flex flex-col">
                            <span className="text-sm font-display uppercase">
                              Round #{submission.roundId}
                            </span>
                            <span className="text-xs text-neo-black/60 uppercase flex items-center gap-1 whitespace-nowrap">
                              <span className="material-symbols-outlined text-[14px]">
                                schedule
                              </span>
                              {formatLocalTime(submission.roundId * ROUND_SECONDS)}-
                              {formatLocalTime(submission.roundId * ROUND_SECONDS + ROUND_SECONDS)}
                            </span>
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono text-neo-black/70">
                                {submission.address ? formatAddress(submission.address) : 'Local'}
                              </span>
                              <span
                                className={
                                  submission.direction === 'up'
                                    ? 'bg-[#0bda0b] text-white text-xs font-display px-2 py-1 border-2 border-neo-black uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]'
                                    : submission.direction === 'down'
                                      ? 'bg-[#ff3333] text-white text-xs font-display px-2 py-1 border-2 border-neo-black uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]'
                                      : 'bg-gray-200 text-neo-black text-xs font-display px-2 py-1 border-2 border-neo-black uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]'
                                }
                              >
                                {submission.direction === 'unknown'
                                  ? 'HIDDEN'
                                  : submission.direction.toUpperCase()}
                              </span>
                              {canDecryptDirection ? (
                                <button
                                  className={`px-2 py-1 text-[10px] font-display uppercase border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all ${
                                    decryptInFlight
                                      ? 'bg-gray-200 text-neo-black cursor-not-allowed'
                                      : 'bg-white text-neo-black hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none'
                                  }`}
                                  disabled={decryptInFlight}
                                  onClick={() => handleDecryptDirection(submission.roundId)}
                                  type="button"
                                >
                                  {decryptInFlight ? 'Decrypting...' : 'Decrypt'}
                                </button>
                              ) : null}
                              {claimEnabled ? (
                                <button
                                  className={`px-2 py-1 text-xs font-display uppercase border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all ${
                                    claimInFlight
                                      ? 'bg-gray-200 text-neo-black cursor-not-allowed'
                                      : `${claimBadgeClass} hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none`
                                  }`}
                                  disabled={claimInFlight}
                                  onClick={() => handleClaimForRound(submission.roundId)}
                                  type="button"
                                >
                                  {claimInFlight ? 'Claiming...' : claimLabel}
                                </button>
                              ) : (
                                <span
                                  className={`px-2 py-1 text-xs font-display uppercase border-2 border-neo-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] ${claimBadgeClass}`}
                                >
                                  {claimLabel}
                                </span>
                              )}
                            </div>
                            {claimStatus ? (
                              <span className="text-[10px] text-neo-black/60 uppercase">
                                {claimStatus}
                              </span>
                            ) : null}
                            {decryptStatus ? (
                              <span className="text-[10px] text-neo-black/60 uppercase">
                                {decryptStatus}
                              </span>
                            ) : null}
                            {txHash ? (
                              <a
                                className="text-[10px] text-neo-black/60 uppercase hover:text-neo-black font-mono"
                                href={`${SEPOLIA_TX_URL}${txHash}`}
                                rel="noreferrer"
                                target="_blank"
                              >
                                Tx {formatTxHash(txHash)}
                              </a>
                            ) : null}
                            {claimError ? (
                              <span className="text-[10px] text-[#ff3333] uppercase">
                                {claimError}
                              </span>
                            ) : null}
                            {decryptError ? (
                              <span className="text-[10px] text-[#ff3333] uppercase">
                                {decryptError}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
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
                  {winRateText}
                </span>
              </div>
              <div className="flex justify-between items-center border-b-2 border-neo-black/10 pb-3">
                <span className="text-neo-black/60 text-base font-bold uppercase font-display">Total Wagered</span>
                <span className="font-display text-2xl">{totalWageredText}</span>
              </div>
              <div className="flex justify-between items-center pt-1">
                <span className="text-neo-black/60 text-base font-bold uppercase font-display">Net Profit</span>
                <span className={`font-display text-3xl ${netProfitClass}`}>{netProfitText}</span>
              </div>
            </div>
          </div>
          <div
            className="border-5 border-neo-black bg-white flex-grow flex flex-col min-h-[400px] shadow-neo rounded-2xl overflow-hidden"
            style={placeCardHeight ? { height: `${placeCardHeight}px` } : undefined}
          >
            <div className="bg-secondary p-4 border-b-5 border-neo-black flex justify-between items-center">
              <h3 className="text-white font-display uppercase text-2xl tracking-wide">Live Feed</h3>
              <div className="flex gap-2">
                <div className="w-4 h-4 bg-[#0bda0b] border-2 border-neo-black rounded-full animate-pulse" />
              </div>
            </div>
            <div className="flex-grow overflow-y-auto custom-scrollbar bg-white">
              <div className="px-4 py-3 text-xs font-display uppercase text-neo-black/60 border-b-2 border-neo-black/10 flex flex-col gap-1">
                <span>
                  Round events and user activity stream here. Directions stay encrypted until reveal.
                </span>
                {isInitialSync ? (
                  <span className="text-[10px] text-neo-black/50">
                    Sync progress: {feedSyncProgress ?? 0}% | Synced block: {lastIndexedBlock ?? '--'}
                  </span>
                ) : (
                  <span className="text-[10px] text-neo-black/50">
                    Synced block: {lastIndexedBlock ?? '--'}
                  </span>
                )}
              </div>
              {!hasFeedContent ? (
                <div className="p-4 text-center text-sm text-neo-black/60">{feedHint}</div>
              ) : (
                <div className="p-4 flex flex-col gap-6">
                  {roundGroups.length ? (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-display uppercase text-neo-black/60">
                          Round Timeline
                        </span>
                        {showTimelinePagination ? (
                          <div className="flex items-center gap-2 text-[10px] font-display uppercase text-neo-black/60">
                            <button
                              className={`border-2 border-neo-black px-2 py-1 shadow-neo-sm ${
                                activeRoundPage === 0
                                  ? 'bg-gray-200 text-neo-black/50 cursor-not-allowed'
                                  : 'bg-white text-neo-black hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none'
                              }`}
                              disabled={activeRoundPage === 0}
                              onClick={() =>
                                setRoundTimelinePage((prev) => Math.max(prev - 1, 0))
                              }
                              type="button"
                            >
                              Prev
                            </button>
                            <span>
                              Page {activeRoundPage + 1}/{totalRoundPages}
                            </span>
                            <button
                              className={`border-2 border-neo-black px-2 py-1 shadow-neo-sm ${
                                activeRoundPage >= totalRoundPages - 1
                                  ? 'bg-gray-200 text-neo-black/50 cursor-not-allowed'
                                  : 'bg-white text-neo-black hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none'
                              }`}
                              disabled={activeRoundPage >= totalRoundPages - 1}
                              onClick={() =>
                                setRoundTimelinePage((prev) =>
                                  Math.min(prev + 1, totalRoundPages - 1)
                                )
                              }
                              type="button"
                            >
                              Next
                            </button>
                          </div>
                        ) : null}
                      </div>
                      {pagedRoundGroups.map((group, index) => {
                        const isCompactRound = group.activity.length === 0;
                        const hasMoreActivity = group.activity.length > 2;
                        const isActivityExpanded = !!expandedActivityByRound[group.roundId];
                        const activityItems = isActivityExpanded
                          ? group.activity
                          : group.activity.slice(0, 2);
                        return (
                        <div
                          className={`border-3 border-neo-black rounded-xl shadow-neo-sm ${
                            index % 2 === 0 ? 'bg-gray-100' : 'bg-[#fff7d1]'
                          } ${isCompactRound ? 'p-2' : 'p-3'}`}
                          key={`round-${group.roundId}`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-display uppercase text-sm">
                              Round #{group.roundId}
                            </span>
                            {group.final ? (
                              <span
                                className={`${getRoundResultClass(
                                  group.final.result
                                )} px-3 py-1 border border-neo-black/60 text-xs font-display uppercase rounded-sm min-w-[88px] inline-flex justify-center`}
                              >
                                {getRoundResultLabel(group.final.result)}
                              </span>
                            ) : (
                              <span className="bg-white text-neo-black px-3 py-1 border border-neo-black/60 text-xs font-display uppercase rounded-sm min-w-[88px] inline-flex justify-center">
                                Pending
                              </span>
                            )}
                          </div>
                          {isCompactRound ? (
                            <div className="mt-2 flex items-center justify-between gap-2 text-[10px] uppercase text-neo-black/60">
                              <div className="flex items-center gap-1">
                                <span className="material-symbols-outlined text-[12px]">
                                  schedule
                                </span>
                                <span className="font-display">
                                  {group.init
                                    ? `${formatLocalTime(group.init.startTime)}-${formatLocalTime(
                                        group.init.endTime
                                      )}`
                                    : 'Pending'}
                                </span>
                              </div>
                              <div className="flex items-center gap-1">
                                <span className="material-symbols-outlined text-[12px]">
                                  flag
                                </span>
                                <span className="font-display">
                                  {group.final
                                    ? `$${formatChainlinkPrice(group.final.startPrice)}-${formatChainlinkPrice(
                                        group.final.endPrice
                                      )}`
                                    : 'Pending'}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-3 grid grid-cols-1 gap-2 text-xs">
                              <div className="flex items-center justify-between border-2 border-neo-black bg-white px-3 py-2 rounded-lg">
                                <div className="flex items-center gap-2">
                                  <span className="material-symbols-outlined text-[14px]">
                                    schedule
                                  </span>
                                  <span className="font-display uppercase text-neo-black/70">
                                    Start
                                  </span>
                                </div>
                                <span className="font-mono text-neo-black">
                                  {group.init
                                    ? `${formatLocalTime(group.init.startTime)}-${formatLocalTime(
                                        group.init.endTime
                                      )}`
                                    : 'Pending'}
                                </span>
                              </div>
                              <div className="border-2 border-neo-black bg-white px-3 py-2 rounded-lg">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <span className="material-symbols-outlined text-[14px]">
                                      bolt
                                    </span>
                                    <span className="font-display uppercase text-neo-black/70">
                                      Activity
                                    </span>
                                  </div>
                                  {hasMoreActivity ? (
                                    <button
                                      className="text-[10px] font-display uppercase text-neo-black/60 border-2 border-neo-black px-2 py-1 shadow-neo-sm bg-gray-100 hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none transition-all"
                                      type="button"
                                      onClick={() =>
                                        setExpandedActivityByRound((prev) => ({
                                          ...prev,
                                          [group.roundId]: !prev[group.roundId],
                                        }))
                                      }
                                    >
                                      {isActivityExpanded
                                        ? 'Show less'
                                        : `+${group.activity.length - 2} more`}
                                    </button>
                                  ) : null}
                                </div>
                                <div className="mt-2 flex flex-col gap-2">
                                  {activityItems.map((event) => {
                                    const finalResult = group.final?.result;
                                    const hasFinal =
                                      finalResult === 1 || finalResult === 2 || finalResult === 3;
                                    const isTie = finalResult === 3;
                                    let actionLabel = event.type === 'bet' ? 'BET' : 'PENDING';
                                    let actionClass = 'bg-gray-200 text-neo-black';
                                    if (hasFinal) {
                                      if (isTie) {
                                        actionLabel = 'TIE';
                                        actionClass = 'bg-gray-300 text-neo-black';
                                      } else if (event.type === 'claim') {
                                        actionLabel = 'WIN';
                                        actionClass = 'bg-[#0bda0b] text-white';
                                      } else {
                                        actionLabel = 'LOST';
                                        actionClass = 'bg-[#ff3333] text-white';
                                      }
                                    } else if (event.type === 'claim') {
                                      actionLabel = 'WIN';
                                      actionClass = 'bg-[#0bda0b] text-white';
                                    }
                                    return (
                                      <div
                                        className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-2 border-neo-black bg-gray-100 px-2 py-1 rounded-md"
                                        key={event.id}
                                      >
                                        <span className="font-mono text-[10px] text-neo-black w-[90px] truncate">
                                          {getFeedUserLabel(event)}
                                        </span>
                                        <span className="font-display text-[10px] text-center">
                                          {formatEthValue(event.amountEth || '0')} ETH
                                        </span>
                                        <span
                                          className={`${actionClass} text-[10px] font-display px-2 py-1 border border-neo-black/60 uppercase rounded-sm w-[72px] inline-flex justify-center`}
                                        >
                                          {actionLabel}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                              <div className="flex items-center justify-between border-2 border-neo-black bg-white px-3 py-2 rounded-lg">
                                <div className="flex items-center gap-2">
                                  <span className="material-symbols-outlined text-[14px]">
                                    flag
                                  </span>
                                  <span className="font-display uppercase text-neo-black/70">
                                    Final
                                  </span>
                                </div>
                                {group.final ? (
                                  <div className="flex items-center gap-2 flex-wrap justify-end">
                                    <span className="text-[10px] font-display uppercase text-neo-black/60">
                                      ${formatChainlinkPrice(group.final.startPrice)}-
                                      ${formatChainlinkPrice(group.final.endPrice)}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-[10px] font-display uppercase text-neo-black/60">
                                    Pending
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              )}
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

function LegacyBtcUpDownPage() {
  const { address, chainId, connect, walletProvider, isConnected } = useFhevm();
  const activeChainId = chainId || null;
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);

  const [stakeAmount, setStakeAmount] = useState<bigint>(BigInt(0));
  const [currentRound, setCurrentRound] = useState<number | null>(null);
  const [roundId, setRoundId] = useState<number | null>(null);
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [totals, setTotals] = useState<{ up: number; down: number } | null>(null);
  const [pendingHandle, setPendingHandle] = useState<string>('');

  const contractAddress = useMemo(() => {
    if (!activeChainId) return '';
    return CONTRACT_ADDRESSES[activeChainId] || '';
  }, [activeChainId]);

  const ready = !!address && !!contractAddress && isInitialized;

  useEffect(() => {
    if (!isConnected || !walletProvider || isInitialized) return;
    initializeFheInstance(walletProvider)
      .then(() => setIsInitialized(true))
      .catch((err: any) => {
        setError(err?.message || 'FHEVM initialization failed');
      });
  }, [isConnected, walletProvider, isInitialized]);

  const connectWallet = async () => {
    setError('');
    setMessage('');
    try {
      await connect();
      setMessage('Wallet connected');
    } catch (err: any) {
      setError(err?.message || 'Wallet connection failed');
    }
  };

  const getProvider = () => {
    if (!walletProvider) {
      throw new Error('No wallet found');
    }
    return new ethers.BrowserProvider(walletProvider);
  };

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
    if (contractAddress && address) {
      refreshRound();
    }
  }, [contractAddress, address]);

  const placeBet = async () => {
    if (!ready || roundId === null) return;
    setError('');
    setMessage('Encrypting direction...');
    try {
      const encrypted = await createEncryptedInput(
        contractAddress,
        address,
        direction === 'up' ? 1 : 0
      );
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
      const pending = await readContract.getPendingClaim(roundId, address);
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
          {address ? `Account: ${address}` : 'Not connected'}
        </div>
        <div className="text-sm text-gray-400">
          {activeChainId ? `Chain ID: ${activeChainId}` : 'Chain ID: -'}
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
