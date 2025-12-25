'use client';

import { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import {
  createEncryptedInput,
  decryptMultipleHandles,
  fetchPublicDecryption,
  initializeFheInstance,
} from '../../src/lib/fhevmInstance';

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

export default function BtcUpDownPage() {
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
          Current round: {currentRound ?? '-'} | Target round:{' '}
          {roundId ?? (currentRound !== null ? currentRound + 1 : '-')}
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
