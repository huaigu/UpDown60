'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ethers } from 'ethers';

const SEPOLIA_CHAIN_ID = 11155111;
const CONTRACT_ADDRESS = '0x5F893Cf33715DbaC196229560418C709F0FFA6Ca';
const PUBLIC_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
const LOCAL_FEED_KEY = 'btcUpDownLiveFeedV2';
const LOCAL_FEED_BLOCK_KEY = 'btcUpDownLiveFeedLastBlockV2';
const LOCAL_DEPLOY_BLOCK_KEY = 'btcUpDownDeployBlockV2';
const LOCAL_FEED_FULL_SYNC_KEY = 'btcUpDownLiveFeedFullSyncV2';
const LOCAL_FEED_CURSOR_KEY = 'btcUpDownLiveFeedCursorV2';
const SEPOLIA_DEPLOY_BLOCK = 9922892;
const FULL_SYNC_BLOCK_CHUNK = 5000;

const CONTRACT_ABI = [
  'event BetPlaced(uint256 indexed roundId, address indexed user, uint64 stake)',
  'event ClaimPaid(uint256 indexed roundId, address indexed user, uint64 payout)',
  'event RoundInitialized(uint256 indexed roundId, uint256 startTime, uint256 endTime)',
  'event RoundFinalized(uint256 indexed roundId, int256 startPrice, int256 endPrice, uint8 result)',
];

export type FeedEvent = {
  id: string;
  type: 'bet' | 'claim' | 'round-init' | 'round-final';
  user?: string;
  roundId: number;
  amountEth?: string;
  startTime?: number;
  endTime?: number;
  startPrice?: string;
  endPrice?: string;
  result?: number;
  txHash: string;
  blockNumber: number;
  logIndex: number;
};

type LiveFeedContextValue = {
  feedEvents: FeedEvent[];
  lastIndexedBlock: number | null;
  feedSyncStatus: string;
  feedSyncProgress: number | null;
  feedSyncError: string;
  addFeedEvents: (incoming: FeedEvent[], blockNumber?: number | null) => void;
};

const LiveFeedContext = createContext<LiveFeedContextValue | null>(null);

const mergeFeedEvents = (prev: FeedEvent[], incoming: FeedEvent[]) => {
  if (!incoming.length) return prev;
  const merged = new Map<string, FeedEvent>();
  [...prev, ...incoming].forEach((item) => {
    merged.set(item.id, item);
  });
  const typePriority: Record<FeedEvent['type'], number> = {
    'round-init': 0,
    bet: 1,
    claim: 2,
    'round-final': 3,
  };
  return Array.from(merged.values())
    .sort((a, b) => {
      if (a.roundId !== b.roundId) {
        return b.roundId - a.roundId;
      }
      if (a.type !== b.type) {
        const priorityA = typePriority[a.type] ?? 9;
        const priorityB = typePriority[b.type] ?? 9;
        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }
      }
      if (b.blockNumber !== a.blockNumber) {
        return b.blockNumber - a.blockNumber;
      }
      return b.logIndex - a.logIndex;
    });
};

const getEventLogIndex = (event: { logIndex?: number; index?: number }) =>
  event.logIndex ?? event.index ?? 0;

const getEventArgs = (event: any) =>
  (event?.args as Record<string, unknown> | undefined) ?? undefined;

const normalizedContract = CONTRACT_ADDRESS.toLowerCase();
const feedStorageKey = `${LOCAL_FEED_KEY}:${SEPOLIA_CHAIN_ID}:${normalizedContract}`;
const feedBlockKey = `${feedStorageKey}:${LOCAL_FEED_BLOCK_KEY}`;
const deployBlockKey = `${LOCAL_DEPLOY_BLOCK_KEY}:${SEPOLIA_CHAIN_ID}:${normalizedContract}`;
const feedFullSyncKey = `${LOCAL_FEED_FULL_SYNC_KEY}:${SEPOLIA_CHAIN_ID}:${normalizedContract}`;
const feedCursorKey = `${LOCAL_FEED_CURSOR_KEY}:${SEPOLIA_CHAIN_ID}:${normalizedContract}`;

export function LiveFeedProvider({ children }: { children: ReactNode }) {
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const [lastIndexedBlock, setLastIndexedBlock] = useState<number | null>(null);
  const [feedSyncStatus, setFeedSyncStatus] = useState('');
  const [feedSyncProgress, setFeedSyncProgress] = useState<number | null>(null);
  const [feedSyncError, setFeedSyncError] = useState('');
  const [needsFullSync, setNeedsFullSync] = useState(true);
  const [fullSyncCursor, setFullSyncCursor] = useState<number | null>(null);
  const provider = useMemo(() => new ethers.JsonRpcProvider(PUBLIC_RPC_URL), []);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(feedStorageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as FeedEvent[];
        setFeedEvents(Array.isArray(parsed) ? parsed : []);
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
    const storedCursor = window.localStorage.getItem(feedCursorKey);
    const storedFullSync = window.localStorage.getItem(feedFullSyncKey);
    const hasFullSync = storedFullSync === 'true';
    setNeedsFullSync(!hasFullSync);
    if (hasFullSync) {
      setFullSyncCursor(null);
    } else if (storedCursor) {
      const parsedCursor = Number(storedCursor);
      setFullSyncCursor(Number.isNaN(parsedCursor) ? SEPOLIA_DEPLOY_BLOCK : parsedCursor);
    } else {
      setFullSyncCursor(SEPOLIA_DEPLOY_BLOCK);
    }
    hasLoadedRef.current = true;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const storedDeploy = window.localStorage.getItem(deployBlockKey);
    const storedNumber = storedDeploy ? Number(storedDeploy) : null;
    if (storedNumber && storedNumber !== SEPOLIA_DEPLOY_BLOCK) {
      window.localStorage.removeItem(feedBlockKey);
      window.localStorage.removeItem(feedStorageKey);
      window.localStorage.removeItem(feedFullSyncKey);
      window.localStorage.removeItem(feedCursorKey);
      setFeedEvents([]);
      setLastIndexedBlock(null);
      setNeedsFullSync(true);
      setFullSyncCursor(SEPOLIA_DEPLOY_BLOCK);
    }
    if (!storedDeploy && lastIndexedBlock !== null) {
      window.localStorage.removeItem(feedBlockKey);
      window.localStorage.removeItem(feedStorageKey);
      window.localStorage.removeItem(feedFullSyncKey);
      window.localStorage.removeItem(feedCursorKey);
      setFeedEvents([]);
      setLastIndexedBlock(null);
      setNeedsFullSync(true);
      setFullSyncCursor(SEPOLIA_DEPLOY_BLOCK);
    }
    window.localStorage.setItem(deployBlockKey, String(SEPOLIA_DEPLOY_BLOCK));
  }, [lastIndexedBlock]);

  useEffect(() => {
    if (typeof window === 'undefined' || !hasLoadedRef.current) return;
    window.localStorage.setItem(feedStorageKey, JSON.stringify(feedEvents));
    if (lastIndexedBlock !== null) {
      window.localStorage.setItem(feedBlockKey, String(lastIndexedBlock));
    }
  }, [feedEvents, lastIndexedBlock]);

  useEffect(() => {
    if (typeof window === 'undefined' || !hasLoadedRef.current) return;
    if (needsFullSync && fullSyncCursor !== null) {
      window.localStorage.setItem(feedCursorKey, String(fullSyncCursor));
    }
  }, [fullSyncCursor, needsFullSync]);

  const addFeedEvents = useCallback(
    (incoming: FeedEvent[], blockNumber?: number | null) => {
      if (incoming.length) {
        setFeedEvents((prev) => mergeFeedEvents(prev, incoming));
      }
      const incomingMax = incoming.reduce(
        (max, event) => Math.max(max, event.blockNumber),
        -1
      );
      const nextBlock =
        typeof blockNumber === 'number' ? blockNumber : incomingMax >= 0 ? incomingMax : null;
      if (nextBlock !== null && nextBlock !== undefined) {
        setLastIndexedBlock((prev) =>
          prev === null ? nextBlock : Math.max(prev, nextBlock)
        );
      }
    },
    []
  );

  useEffect(() => {
    let isActive = true;
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

    const syncFeed = async () => {
      try {
        const shouldFullSync = needsFullSync || lastIndexedBlock === null;
        if (shouldFullSync) {
          setFeedSyncStatus('Syncing history from deployment...');
          setFeedSyncProgress(null);
          setFeedSyncError('');
        }
        const latestBlock = await provider.getBlockNumber();
        const fromBlock = shouldFullSync
          ? SEPOLIA_DEPLOY_BLOCK <= latestBlock
            ? fullSyncCursor ?? SEPOLIA_DEPLOY_BLOCK
            : null
          : lastIndexedBlock !== null
            ? Math.max(lastIndexedBlock - 50, 0)
            : SEPOLIA_DEPLOY_BLOCK <= latestBlock
              ? SEPOLIA_DEPLOY_BLOCK
              : null;
        if (fromBlock === null) {
          setFeedSyncError('Feed sync paused (deployment block unavailable).');
          return;
        }
        const toBlock = shouldFullSync
          ? Math.min(fromBlock + FULL_SYNC_BLOCK_CHUNK, latestBlock)
          : latestBlock;
        if (shouldFullSync && latestBlock >= SEPOLIA_DEPLOY_BLOCK) {
          const progress = Math.min(
            100,
            Math.round(
              ((Math.min(toBlock, latestBlock) - SEPOLIA_DEPLOY_BLOCK) /
                Math.max(latestBlock - SEPOLIA_DEPLOY_BLOCK, 1)) *
                100
            )
          );
          setFeedSyncProgress(progress);
          setFeedSyncStatus(`Syncing history ${fromBlock}→${toBlock}`);
        }
        if (fromBlock > latestBlock) return;
        const [betEvents, claimEvents, initEvents, finalizeEvents] = await Promise.all([
          contract.queryFilter(contract.filters.BetPlaced(), fromBlock, toBlock),
          contract.queryFilter(contract.filters.ClaimPaid(), fromBlock, toBlock),
          contract.queryFilter(contract.filters.RoundInitialized(), fromBlock, toBlock),
          contract.queryFilter(contract.filters.RoundFinalized(), fromBlock, toBlock),
        ]);
        if (!isActive) return;
        const mapped: FeedEvent[] = [
          ...betEvents.map((event) => {
            const args = getEventArgs(event);
            return {
              id: `${event.transactionHash}-${getEventLogIndex(event)}`,
              type: 'bet' as const,
              user: args?.user as string,
              roundId: Number((args?.roundId as bigint | number | string) ?? 0),
              amountEth: ethers.formatEther(
                (args?.stake as bigint | number | string) ?? BigInt(0)
              ),
              txHash: event.transactionHash,
              blockNumber: event.blockNumber ?? 0,
              logIndex: getEventLogIndex(event),
            };
          }),
          ...claimEvents.map((event) => {
            const args = getEventArgs(event);
            return {
              id: `${event.transactionHash}-${getEventLogIndex(event)}`,
              type: 'claim' as const,
              user: args?.user as string,
              roundId: Number((args?.roundId as bigint | number | string) ?? 0),
              amountEth: ethers.formatEther(
                (args?.payout as bigint | number | string) ?? BigInt(0)
              ),
              txHash: event.transactionHash,
              blockNumber: event.blockNumber ?? 0,
              logIndex: getEventLogIndex(event),
            };
          }),
          ...initEvents.map((event) => {
            const args = getEventArgs(event);
            return {
              id: `${event.transactionHash}-${getEventLogIndex(event)}`,
              type: 'round-init' as const,
              roundId: Number((args?.roundId as bigint | number | string) ?? 0),
              startTime: Number((args?.startTime as bigint | number | string) ?? 0),
              endTime: Number((args?.endTime as bigint | number | string) ?? 0),
              txHash: event.transactionHash,
              blockNumber: event.blockNumber ?? 0,
              logIndex: getEventLogIndex(event),
            };
          }),
          ...finalizeEvents.map((event) => {
            const args = getEventArgs(event);
            return {
              id: `${event.transactionHash}-${getEventLogIndex(event)}`,
              type: 'round-final' as const,
              roundId: Number((args?.roundId as bigint | number | string) ?? 0),
              startPrice: (args?.startPrice as bigint | number | string | undefined)?.toString?.(),
              endPrice: (args?.endPrice as bigint | number | string | undefined)?.toString?.(),
              result: Number((args?.result as bigint | number | string) ?? 0),
              txHash: event.transactionHash,
              blockNumber: event.blockNumber ?? 0,
              logIndex: getEventLogIndex(event),
            };
          }),
        ];
        if (mapped.length) {
          setFeedEvents((prev) => mergeFeedEvents(prev, mapped));
        }
        setLastIndexedBlock((prev) =>
          prev === null ? toBlock : Math.max(prev, toBlock)
        );
        if (shouldFullSync) {
          if (toBlock >= latestBlock) {
            setFeedSyncStatus('');
            setFeedSyncProgress(null);
            setNeedsFullSync(false);
            setFullSyncCursor(null);
            if (typeof window !== 'undefined') {
              window.localStorage.setItem(feedFullSyncKey, 'true');
              window.localStorage.removeItem(feedCursorKey);
            }
            setLastIndexedBlock(latestBlock);
          } else {
            setFullSyncCursor(toBlock + 1);
          }
        }
        setFeedSyncError('');
      } catch (err) {
        console.warn('Failed to sync live feed', err);
        if (lastIndexedBlock === null) {
          setFeedSyncError('Live feed sync failed. Retrying...');
        }
      }
    };

    syncFeed();
    const interval = window.setInterval(syncFeed, 15000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [provider, lastIndexedBlock, needsFullSync, fullSyncCursor]);

  const value = useMemo<LiveFeedContextValue>(
    () => ({
      feedEvents,
      lastIndexedBlock,
      feedSyncStatus,
      feedSyncProgress,
      feedSyncError,
      addFeedEvents,
    }),
    [
      feedEvents,
      lastIndexedBlock,
      feedSyncStatus,
      feedSyncProgress,
      feedSyncError,
      addFeedEvents,
    ]
  );

  return <LiveFeedContext.Provider value={value}>{children}</LiveFeedContext.Provider>;
}

export const useLiveFeed = () => {
  const ctx = useContext(LiveFeedContext);
  if (!ctx) {
    throw new Error('useLiveFeed must be used within LiveFeedProvider');
  }
  return ctx;
};
