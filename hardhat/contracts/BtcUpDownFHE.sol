// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import { FHE, externalEuint32, euint32, euint64, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80);
}

interface AutomationCompatibleInterface {
    function checkUpkeep(bytes calldata checkData) external view returns (bool, bytes memory);
    function performUpkeep(bytes calldata performData) external;
}

contract BtcUpDownFHE is ZamaEthereumConfig, AutomationCompatibleInterface {
    uint256 public constant ROUND_SECONDS = 3600;

    enum Result {
        Unknown,
        Up,
        Down,
        Tie
    }

    struct Round {
        bool initialized;
        uint256 startTime;
        uint256 endTime;
        int256 startPrice;
        int256 endPrice;
        bool startPriceSet;
        Result result;
        bool resultSet;
        bool revealRequested;
        bool totalsRevealed;
        euint64 encTotalUp;
        euint64 encTotalDown;
        bytes32 totalUpHandle;
        bytes32 totalDownHandle;
        uint64 totalUp;
        uint64 totalDown;
        uint64 feeAmount;
    }

    struct Bet {
        bool exists;
        uint64 stake;
        euint32 direction;
        bool claimRequested;
        bool claimed;
    }

    struct UserStats {
        uint64 totalBets;
        uint64 totalWins;
        uint256 totalWagered;
        uint256 totalPayout;
    }

    address public owner;
    address public feeRecipient;
    uint16 public feeBps;
    uint64 public immutable stakeAmount;
    uint256 public feeAccrued;
    AggregatorV3Interface public immutable btcUsdFeed;
    uint256 public maxPriceAge;
    uint256 public lastFinalizedRoundId;
    bool public lastFinalizedRoundSet;
    int256 public lastRoundPrice;
    bool public lastRoundPriceSet;

    mapping(uint256 => Round) private rounds;
    mapping(uint256 => mapping(address => Bet)) private bets;
    mapping(uint256 => mapping(address => bytes32)) private claimHandles;
    mapping(address => UserStats) private userStats;
    mapping(address => bool) private isParticipant;
    address[] private participants;

    event RoundInitialized(uint256 indexed roundId, uint256 startTime, uint256 endTime);
    event BetPlaced(uint256 indexed roundId, address indexed user, uint64 stake);
    event RoundFinalized(uint256 indexed roundId, int256 startPrice, int256 endPrice, Result result);
    event RoundRevealRequested(uint256 indexed roundId, bytes32 totalUpHandle, bytes32 totalDownHandle);
    event TotalsRevealed(uint256 indexed roundId, uint64 totalUp, uint64 totalDown);
    event ClaimDecryptRequested(uint256 indexed roundId, address indexed user, bytes32 payoutHandle);
    event ClaimPaid(uint256 indexed roundId, address indexed user, uint64 payout);
    event FeeRecipientUpdated(address indexed recipient);
    event FeeBpsUpdated(uint16 feeBps);
    event MaxPriceAgeUpdated(uint256 maxPriceAge);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(
        uint64 _stakeAmount,
        uint16 _feeBps,
        address _feeRecipient,
        address _priceFeed,
        uint256 _maxPriceAge
    ) {
        require(_stakeAmount > 0, "Stake must be positive");
        require(_feeBps <= 2000, "Fee too high");
        require(_priceFeed != address(0), "Price feed required");
        owner = msg.sender;
        stakeAmount = _stakeAmount;
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        btcUsdFeed = AggregatorV3Interface(_priceFeed);
        maxPriceAge = _maxPriceAge;
    }

    function getCurrentRound() public view returns (uint256) {
        return block.timestamp / ROUND_SECONDS;
    }

    function getRoundState(uint256 roundId)
        external
        view
        returns (
            bool initialized,
            uint256 startTime,
            uint256 endTime,
            int256 startPrice,
            int256 endPrice,
            Result result,
            bool resultSet,
            bool revealRequested,
            bool totalsRevealed
        )
    {
        Round storage r = rounds[roundId];
        return (
            r.initialized,
            r.startTime,
            r.endTime,
            r.startPrice,
            r.endPrice,
            r.result,
            r.resultSet,
            r.revealRequested,
            r.totalsRevealed
        );
    }

    function getRoundTotals(uint256 roundId)
        external
        view
        returns (uint64 totalUp, uint64 totalDown, uint64 feeAmount)
    {
        Round storage r = rounds[roundId];
        return (r.totalUp, r.totalDown, r.feeAmount);
    }

    function getRoundHandles(uint256 roundId)
        external
        view
        returns (bytes32 totalUpHandle, bytes32 totalDownHandle)
    {
        Round storage r = rounds[roundId];
        return (r.totalUpHandle, r.totalDownHandle);
    }

    function getBet(uint256 roundId, address user)
        external
        view
        returns (bool exists, uint64 stake, bool claimRequested, bool claimed)
    {
        Bet storage b = bets[roundId][user];
        return (b.exists, b.stake, b.claimRequested, b.claimed);
    }

    function getPendingClaim(uint256 roundId, address user)
        external
        view
        returns (bool pending, bytes32 handle)
    {
        Bet storage b = bets[roundId][user];
        return (b.claimRequested && !b.claimed, claimHandles[roundId][user]);
    }

    function getParticipantCount() external view returns (uint256) {
        return participants.length;
    }

    function getParticipants(uint256 offset, uint256 limit) external view returns (address[] memory) {
        uint256 total = participants.length;
        if (offset >= total) {
            return new address[](0);
        }
        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        address[] memory result = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = participants[i];
        }
        return result;
    }

    function getUserStats(address user)
        external
        view
        returns (uint64 totalBets, uint64 totalWins, uint256 totalWagered, uint256 totalPayout)
    {
        UserStats storage stats = userStats[user];
        return (stats.totalBets, stats.totalWins, stats.totalWagered, stats.totalPayout);
    }

    function placeBet(
        uint256 roundId,
        externalEuint32 encryptedDirection,
        bytes calldata proof
    ) external payable {
        require(roundId == getCurrentRound() + 1, "Bet next round only");
        require(msg.value == stakeAmount, "Incorrect stake");

        _initRound(roundId);
        Round storage r = rounds[roundId];
        require(block.timestamp < r.startTime, "Round already started");

        Bet storage b = bets[roundId][msg.sender];
        require(!b.exists, "Already bet");

        euint32 dir = FHE.fromExternal(encryptedDirection, proof);
        euint64 stakeEnc = FHE.asEuint64(uint64(msg.value));
        euint32 one = FHE.asEuint32(1);
        euint32 zero = FHE.asEuint32(0);
        euint64 zeroStake = FHE.asEuint64(0);

        r.encTotalUp = FHE.add(r.encTotalUp, FHE.select(FHE.eq(dir, one), stakeEnc, zeroStake));
        r.encTotalDown = FHE.add(r.encTotalDown, FHE.select(FHE.eq(dir, zero), stakeEnc, zeroStake));

        FHE.allowThis(r.encTotalUp);
        FHE.allowThis(r.encTotalDown);

        b.exists = true;
        b.stake = uint64(msg.value);
        b.direction = dir;
        FHE.allowThis(b.direction);
        FHE.allow(b.direction, msg.sender);
        _trackParticipant(msg.sender);
        _recordBet(msg.sender, uint64(msg.value));

        emit BetPlaced(roundId, msg.sender, uint64(msg.value));
    }

    function getBetDirectionHandle(uint256 roundId, address user) external view returns (bytes32) {
        Bet storage b = bets[roundId][user];
        require(b.exists, "No bet");
        return FHE.toBytes32(b.direction);
    }

    function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData) {
        uint256 currentRound = getCurrentRound();
        if (currentRound == 0) {
            return (false, bytes(""));
        }
        uint256 targetRound = currentRound - 1;
        if (lastFinalizedRoundSet && targetRound <= lastFinalizedRoundId) {
            return (false, bytes(""));
        }
        Round storage r = rounds[targetRound];
        uint256 endTime = r.initialized ? r.endTime : (targetRound + 1) * ROUND_SECONDS;
        if (block.timestamp < endTime) {
            return (false, bytes(""));
        }
        return (true, abi.encode(targetRound));
    }

    function performUpkeep(bytes calldata performData) external {
        uint256 currentRound = getCurrentRound();
        require(currentRound > 0, "No completed round");
        uint256 targetRound = currentRound - 1;
        if (performData.length == 32) {
            uint256 decoded = abi.decode(performData, (uint256));
            if (decoded == targetRound) {
                _finalizeRoundFromFeed(decoded);
                return;
            }
        }
        _finalizeRoundFromFeed(targetRound);
    }

    function finalizeRound(uint256 roundId) external {
        _finalizeRoundFromFeed(roundId);
    }

    function requestRoundReveal(uint256 roundId) external {
        Round storage r = rounds[roundId];
        require(r.resultSet, "Result not set");
        require(!r.revealRequested, "Reveal requested");

        r.revealRequested = true;
        r.encTotalUp = FHE.makePubliclyDecryptable(r.encTotalUp);
        r.encTotalDown = FHE.makePubliclyDecryptable(r.encTotalDown);

        r.totalUpHandle = FHE.toBytes32(r.encTotalUp);
        r.totalDownHandle = FHE.toBytes32(r.encTotalDown);

        emit RoundRevealRequested(roundId, r.totalUpHandle, r.totalDownHandle);
    }

    function resolveTotalsCallback(
        uint256 roundId,
        bytes calldata cleartexts,
        bytes calldata decryptionProof
    ) external {
        Round storage r = rounds[roundId];
        require(r.revealRequested, "Reveal not requested");
        require(!r.totalsRevealed, "Totals already revealed");

        bytes32[] memory handles = new bytes32[](2);
        handles[0] = r.totalUpHandle;
        handles[1] = r.totalDownHandle;
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        (uint64 totalUp, uint64 totalDown) = abi.decode(cleartexts, (uint64, uint64));
        r.totalUp = totalUp;
        r.totalDown = totalDown;
        r.totalsRevealed = true;

        uint64 losingTotal = 0;
        uint64 winningTotal = 0;
        if (r.result == Result.Up) {
            winningTotal = totalUp;
            losingTotal = totalDown;
        } else if (r.result == Result.Down) {
            winningTotal = totalDown;
            losingTotal = totalUp;
        }

        if (winningTotal > 0 && r.result != Result.Tie) {
            r.feeAmount = uint64((uint256(losingTotal) * feeBps) / 10_000);
            feeAccrued += r.feeAmount;
        }

        emit TotalsRevealed(roundId, totalUp, totalDown);
    }

    function requestClaim(uint256 roundId) external {
        Round storage r = rounds[roundId];
        require(r.resultSet, "Result not set");

        Bet storage b = bets[roundId][msg.sender];
        require(b.exists, "No bet");
        require(!b.claimed, "Already claimed");
        require(!b.claimRequested, "Claim pending");

        uint64 stake = b.stake;
        if (r.result == Result.Tie) {
            b.claimed = true;
            _safeTransfer(msg.sender, stake);
            _recordPayout(msg.sender, stake, false);
            emit ClaimPaid(roundId, msg.sender, stake);
            return;
        }

        require(r.totalsRevealed, "Totals not revealed");

        uint64 winningTotal = r.result == Result.Up ? r.totalUp : r.totalDown;
        uint64 losingTotal = r.result == Result.Up ? r.totalDown : r.totalUp;

        if (winningTotal == 0) {
            b.claimed = true;
            _safeTransfer(msg.sender, stake);
            _recordPayout(msg.sender, stake, false);
            emit ClaimPaid(roundId, msg.sender, stake);
            return;
        }

        uint64 distributable = losingTotal > r.feeAmount ? losingTotal - r.feeAmount : 0;
        uint64 share = uint64((uint256(stake) * distributable) / winningTotal);
        uint64 payout = stake + share;

        euint32 resultEnc = FHE.asEuint32(r.result == Result.Up ? 1 : 0);
        ebool isWinner = FHE.eq(b.direction, resultEnc);
        euint64 payoutEnc = FHE.select(isWinner, FHE.asEuint64(payout), FHE.asEuint64(0));

        payoutEnc = FHE.makePubliclyDecryptable(payoutEnc);
        bytes32 payoutHandle = FHE.toBytes32(payoutEnc);
        claimHandles[roundId][msg.sender] = payoutHandle;
        b.claimRequested = true;

        emit ClaimDecryptRequested(roundId, msg.sender, payoutHandle);
    }

    function claimCallback(
        uint256 roundId,
        bytes calldata cleartexts,
        bytes calldata decryptionProof
    ) external {
        Round storage r = rounds[roundId];
        require(r.totalsRevealed, "Totals not revealed");

        Bet storage b = bets[roundId][msg.sender];
        require(b.exists, "No bet");
        require(b.claimRequested, "Claim not requested");
        require(!b.claimed, "Already claimed");

        bytes32 handle = claimHandles[roundId][msg.sender];
        require(handle != bytes32(0), "Missing handle");

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = handle;
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        uint64 payout = abi.decode(cleartexts, (uint64));
        b.claimed = true;

        if (payout > 0) {
            _safeTransfer(msg.sender, payout);
        }
        _recordPayout(msg.sender, payout, payout > b.stake);
        emit ClaimPaid(roundId, msg.sender, payout);
    }

    function withdrawFees() external {
        require(msg.sender == feeRecipient, "Only fee recipient");
        uint256 amount = feeAccrued;
        require(amount > 0, "No fees");
        feeAccrued = 0;
        _safeTransfer(msg.sender, amount);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        require(newFeeBps <= 2000, "Fee too high");
        feeBps = newFeeBps;
        emit FeeBpsUpdated(newFeeBps);
    }

    function setMaxPriceAge(uint256 newMaxPriceAge) external onlyOwner {
        maxPriceAge = newMaxPriceAge;
        emit MaxPriceAgeUpdated(newMaxPriceAge);
    }

    function _initRound(uint256 roundId) internal {
        Round storage r = rounds[roundId];
        if (r.initialized) {
            return;
        }
        r.initialized = true;
        r.startTime = roundId * ROUND_SECONDS;
        r.endTime = r.startTime + ROUND_SECONDS;
        r.encTotalUp = FHE.asEuint64(0);
        r.encTotalDown = FHE.asEuint64(0);
        FHE.allowThis(r.encTotalUp);
        FHE.allowThis(r.encTotalDown);
        emit RoundInitialized(roundId, r.startTime, r.endTime);
    }

    function _finalizeRoundFromFeed(uint256 roundId) internal {
        uint256 currentRound = getCurrentRound();
        require(currentRound > 0, "No completed round");
        require(roundId + 1 == currentRound, "Only latest round");
        if (lastFinalizedRoundSet) {
            require(roundId == lastFinalizedRoundId + 1, "Out of order");
        }

        _initRound(roundId);
        Round storage r = rounds[roundId];
        require(block.timestamp >= r.endTime, "Round not ended");
        require(!r.resultSet, "Already finalized");

        (, int256 price, , uint256 updatedAt, ) = btcUsdFeed.latestRoundData();
        require(price > 0, "Invalid price");
        require(block.timestamp - updatedAt <= maxPriceAge, "Stale price");

        int256 startPrice = r.startPrice;
        if (!r.startPriceSet) {
            startPrice = lastRoundPriceSet ? lastRoundPrice : price;
            r.startPrice = startPrice;
            r.startPriceSet = true;
        }
        r.endPrice = price;

        if (price > startPrice) {
            r.result = Result.Up;
        } else if (price < startPrice) {
            r.result = Result.Down;
        } else {
            r.result = Result.Tie;
        }
        r.resultSet = true;
        lastRoundPrice = price;
        lastRoundPriceSet = true;
        lastFinalizedRoundId = roundId;
        lastFinalizedRoundSet = true;

        emit RoundFinalized(roundId, r.startPrice, r.endPrice, r.result);
    }

    function _safeTransfer(address to, uint256 amount) internal {
        (bool success, ) = to.call{ value: amount }("");
        require(success, "Transfer failed");
    }

    function _trackParticipant(address user) internal {
        if (!isParticipant[user]) {
            isParticipant[user] = true;
            participants.push(user);
        }
    }

    function _recordBet(address user, uint64 stake) internal {
        UserStats storage stats = userStats[user];
        stats.totalBets += 1;
        stats.totalWagered += stake;
    }

    function _recordPayout(address user, uint64 payout, bool isWin) internal {
        UserStats storage stats = userStats[user];
        if (payout > 0) {
            stats.totalPayout += payout;
        }
        if (isWin) {
            stats.totalWins += 1;
        }
    }

    receive() external payable {}
}
