# BTC Up/Down DApp - FHEVM Contract Design (5-Min Rounds)

This document proposes a privacy-preserving Solidity design using Zama FHEVM for
encrypted up/down predictions, while keeping bet amounts public and enabling
fair rewards with Chainlink Automation.

## Goals
- Bets are placed for the NEXT 5-minute round only.
- Bet amount is public; direction (up/down) stays encrypted on-chain.
- Chainlink Automation finalizes rounds using a BTC price feed.
- Rewards are proportional to stake, with a platform fee on the losing pool.

## Round Model
- Define round length: `ROUND_SECONDS = 300`.
- Current round: `roundId = block.timestamp / 300`.
- Users can only bet on `roundId + 1` (next period).
- Store `startPrice` at round start and `endPrice` at round end.
- Result = up if `endPrice > startPrice`, else down (tie can be treated as down or refund).

## Storage Layout
```solidity
enum Result { Unknown, Up, Down, Tie }

struct Round {
    uint256 startTime;
    uint256 endTime;
    int256 startPrice;
    int256 endPrice;
    Result result;
    bool revealRequested;
    bool resolved;

    // Encrypted totals (publicly decryptable after round end)
    euint64 encTotalUp;    // total stake for Up
    euint64 encTotalDown;  // total stake for Down

    // Clear totals after decryption callback
    uint64 totalUp;
    uint64 totalDown;
}

struct Bet {
    uint64 stake;          // public stake
    euint32 direction;     // encrypted 0/1
    bool claimed;
}

mapping(uint256 => Round) public rounds;
mapping(uint256 => mapping(address => Bet)) public bets;
```

Notes:
- Use `euint64` for stake totals; require stakes in gwei or enforce max stake to
  stay within 64-bit. This keeps FHE operations within supported types.
- Direction is encrypted as 0 (Down) or 1 (Up).

## Bet Placement (Encrypted Direction)
Frontend:
- Use `createEncryptedInput(contractAddress, userAddress, direction)` from the
  FHEVM SDK. Direction is 0 or 1.
- Send `{ encryptedData, proof }` to the contract.

Solidity:
```solidity
function placeBet(
    uint256 roundId,
    externalEuint32 encryptedDir,
    bytes calldata proof
) external payable {
    require(roundId == getCurrentRound() + 1, "Bet next round only");
    require(msg.value > 0, "Stake required");

    euint32 dir = FHE.fromExternal(encryptedDir, proof);
    euint64 stakeEnc = FHE.asEuint64(uint64(msg.value));

    rounds[roundId].encTotalUp = FHE.add(
        rounds[roundId].encTotalUp,
        FHE.select(FHE.eq(dir, FHE.asEuint32(1)), stakeEnc, FHE.asEuint64(0))
    );
    rounds[roundId].encTotalDown = FHE.add(
        rounds[roundId].encTotalDown,
        FHE.select(FHE.eq(dir, FHE.asEuint32(0)), stakeEnc, FHE.asEuint64(0))
    );

    FHE.allowThis(rounds[roundId].encTotalUp);
    FHE.allowThis(rounds[roundId].encTotalDown);

    bets[roundId][msg.sender] = Bet({
        stake: uint64(msg.value),
        direction: dir,
        claimed: false
    });
}
```

## Finalization With Chainlink Automation
1. Automation triggers `finalizeRound(roundId)` after `endTime`.
2. Contract reads BTC price (via Chainlink feed) and sets `endPrice` and `result`.
3. Make encrypted totals publicly decryptable, emit handles.

```solidity
function requestRoundReveal(uint256 roundId) external {
    Round storage r = rounds[roundId];
    require(block.timestamp >= r.endTime, "Not ended");
    require(!r.revealRequested, "Already requested");

    r.revealRequested = true;
    r.encTotalUp = FHE.makePubliclyDecryptable(r.encTotalUp);
    r.encTotalDown = FHE.makePubliclyDecryptable(r.encTotalDown);

    emit RoundRevealRequested(
        roundId,
        FHE.toBytes32(r.encTotalUp),
        FHE.toBytes32(r.encTotalDown)
    );
}
```

Off-chain (relayer):
- Call `publicDecrypt([upHandle, downHandle])`, get `cleartexts` and `proof`.
- Call `resolveRoundCallback(roundId, cleartexts, proof)`.

```solidity
function resolveRoundCallback(
    uint256 roundId,
    bytes calldata cleartexts,
    bytes calldata proof
) external {
    Round storage r = rounds[roundId];
    require(r.revealRequested && !r.resolved, "Invalid state");

    bytes32[] memory handles = new bytes32[](2);
    handles[0] = FHE.toBytes32(r.encTotalUp);
    handles[1] = FHE.toBytes32(r.encTotalDown);
    FHE.checkSignatures(handles, cleartexts, proof);

    (uint64 totalUp, uint64 totalDown) = abi.decode(cleartexts, (uint64, uint64));
    r.totalUp = totalUp;
    r.totalDown = totalDown;
    r.resolved = true;
}
```

## Claim Flow (Recommended: Privacy-Preserving)
Problem: The contract must know winners without revealing encrypted direction.

Approach:
- Compute `isWinner` in encrypted form.
- Compute an encrypted payout using `FHE.select`.
- Request decryption of the payout, then transfer in a callback.

```solidity
function requestClaim(uint256 roundId) external {
    Round storage r = rounds[roundId];
    Bet storage b = bets[roundId][msg.sender];
    require(r.resolved, "Not resolved");
    require(!b.claimed, "Already claimed");

    uint64 winningTotal = (r.result == Result.Up) ? r.totalUp : r.totalDown;
    uint64 losingTotal = (r.result == Result.Up) ? r.totalDown : r.totalUp;
    require(winningTotal > 0, "No winners");

    uint64 fee = (losingTotal * feeBps) / 10_000;
    uint64 distributable = losingTotal - fee;
    uint64 payoutClear = b.stake + (uint64(uint256(b.stake) * distributable) / winningTotal);

    euint32 resultEnc = FHE.asEuint32(r.result == Result.Up ? 1 : 0);
    ebool isWinner = FHE.eq(b.direction, resultEnc);

    euint64 payoutEnc = FHE.select(
        isWinner,
        FHE.asEuint64(payoutClear),
        FHE.asEuint64(0)
    );

    FHE.allowThis(payoutEnc);
    bytes32 payoutHandle = FHE.toBytes32(payoutEnc);
    emit PayoutDecryptRequested(roundId, msg.sender, payoutHandle);

    b.claimed = true;
}
```

Relayer flow:
- Use `publicDecrypt([payoutHandle])` to get clear payout + proof.
- Call `claimCallback(roundId, user, cleartexts, proof)` to transfer funds.

This keeps the direction encrypted on-chain; only the fact that a user claimed
and got paid is visible.

## Alternative (Simpler, But Reveals Direction After Round)
If privacy after resolution is not required, you can accept plaintext `direction`
in `claim()` and verify it against the result. This removes per-claim decrypt
callbacks but reveals user intent post-round.

## Fee Handling
- `feeBps` set by admin (basis points).
- Fee is taken from the losing pool before distribution.
- `feeRecipient` can withdraw accumulated fees separately.

## Key Takeaways
- You do not need winner counts; total stake per side is enough.
- Keep directions encrypted, compute totals with FHE, and decrypt totals once per
  round via the relayer.
- If you want full privacy on individual claims, use per-claim decryption.
