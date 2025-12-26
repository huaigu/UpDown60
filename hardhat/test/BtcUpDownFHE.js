const { expect } = require('chai');
const hre = require('hardhat');

const ROUND_SECONDS = 3600;

const setTime = async (timestamp) => {
  await hre.network.provider.send('evm_setNextBlockTimestamp', [timestamp]);
  await hre.network.provider.send('evm_mine');
};

const encryptDirection = async (contractAddress, user, direction) => {
  const input = hre.fhevm.createEncryptedInput(contractAddress, user.address);
  input.add32(direction);
  return input.encrypt();
};

async function deployFixture() {
  const [owner, alice, bob] = await hre.ethers.getSigners();
  const feedFactory = await hre.ethers.getContractFactory('MockAggregatorV3');
  const feed = await feedFactory.deploy();
  await feed.waitForDeployment();

  const stake = hre.ethers.parseEther('0.01');
  const feeBps = 200;
  const maxPriceAge = 3600;

  const contractFactory = await hre.ethers.getContractFactory('BtcUpDownFHE');
  const contract = await contractFactory.deploy(
    stake,
    feeBps,
    owner.address,
    await feed.getAddress(),
    maxPriceAge
  );
  await contract.waitForDeployment();

  await hre.fhevm.assertCoprocessorInitialized(contract, 'BtcUpDownFHE');

  return { contract, feed, stake, owner, alice, bob };
}

describe('BtcUpDownFHE', function () {
  it('tracks participants and stats across multiple bettors', async function () {
    const { contract, stake, alice, bob } = await deployFixture();
    const baseTime = 1_000_000;
    await setTime(baseTime);

    const currentRound = Math.floor(baseTime / ROUND_SECONDS);
    const targetRound = currentRound + 1;

    const contractAddress = await contract.getAddress();

    const encryptedAlice = await encryptDirection(contractAddress, alice, 1);
    const encryptedBob = await encryptDirection(contractAddress, bob, 0);

    await contract
      .connect(alice)
      .placeBet(targetRound, encryptedAlice.handles[0], encryptedAlice.inputProof, { value: stake });
    await contract
      .connect(bob)
      .placeBet(targetRound, encryptedBob.handles[0], encryptedBob.inputProof, { value: stake });

    expect(await contract.getParticipantCount()).to.eq(2n);
    const pageOne = await contract.getParticipants(0, 1);
    const pageTwo = await contract.getParticipants(1, 1);
    expect(pageOne[0]).to.eq(alice.address);
    expect(pageTwo[0]).to.eq(bob.address);

    const aliceStats = await contract.getUserStats(alice.address);
    expect(aliceStats[0]).to.eq(1n);
    expect(aliceStats[2]).to.eq(stake);

    const bobStats = await contract.getUserStats(bob.address);
    expect(bobStats[0]).to.eq(1n);
    expect(bobStats[2]).to.eq(stake);
  });

  it('pays stake on tie and records payout without win', async function () {
    const { contract, feed, stake, alice } = await deployFixture();
    const baseTime = 2_000_000;
    await setTime(baseTime);

    const currentRound = Math.floor(baseTime / ROUND_SECONDS);
    const targetRound = currentRound + 1;
    const contractAddress = await contract.getAddress();

    const encrypted = await encryptDirection(contractAddress, alice, 1);

    await contract
      .connect(alice)
      .placeBet(targetRound, encrypted.handles[0], encrypted.inputProof, { value: stake });

    const endTime = (targetRound + 1) * ROUND_SECONDS + 1;
    await setTime(endTime);

    await feed.setLatestRoundData(50_000, endTime);

    await expect(contract.connect(alice).finalizeRound(targetRound))
      .to.emit(contract, 'RoundFinalized')
      .withArgs(targetRound, 50_000, 50_000, 3);

    await expect(contract.connect(alice).requestClaim(targetRound))
      .to.emit(contract, 'ClaimPaid')
      .withArgs(targetRound, alice.address, stake);

    const stats = await contract.getUserStats(alice.address);
    expect(stats[1]).to.eq(0n);
    expect(stats[3]).to.eq(stake);
  });

  it('rejects betting for wrong round or wrong stake', async function () {
    const { contract, stake, alice } = await deployFixture();
    const baseTime = 3_000_000;
    await setTime(baseTime);

    const currentRound = Math.floor(baseTime / ROUND_SECONDS);
    const targetRound = currentRound + 1;
    const contractAddress = await contract.getAddress();
    const encrypted = await encryptDirection(contractAddress, alice, 1);

    await expect(
      contract
        .connect(alice)
        .placeBet(currentRound, encrypted.handles[0], encrypted.inputProof, { value: stake })
    ).to.be.revertedWith('Bet next round only');

    await expect(
      contract
        .connect(alice)
        .placeBet(targetRound, encrypted.handles[0], encrypted.inputProof, { value: stake - 1n })
    ).to.be.revertedWith('Incorrect stake');
  });

  it('prevents double betting in the same round', async function () {
    const { contract, stake, alice } = await deployFixture();
    const baseTime = 4_000_000;
    await setTime(baseTime);

    const currentRound = Math.floor(baseTime / ROUND_SECONDS);
    const targetRound = currentRound + 1;
    const contractAddress = await contract.getAddress();
    const encrypted = await encryptDirection(contractAddress, alice, 1);

    await contract
      .connect(alice)
      .placeBet(targetRound, encrypted.handles[0], encrypted.inputProof, { value: stake });

    await expect(
      contract
        .connect(alice)
        .placeBet(targetRound, encrypted.handles[0], encrypted.inputProof, { value: stake })
    ).to.be.revertedWith('Already bet');
  });

  it('finalizes via upkeep and rejects stale prices', async function () {
    const { contract, feed } = await deployFixture();
    const baseTime = ROUND_SECONDS * 3 + 10;
    await setTime(baseTime);

    const currentRound = Math.floor(baseTime / ROUND_SECONDS);
    const targetRound = currentRound - 1;

    await feed.setLatestRoundData(50_000, baseTime - 10_000);
    await expect(contract.finalizeRound(targetRound)).to.be.revertedWith('Stale price');

    await feed.setLatestRoundData(50_000, baseTime);
    const [needed, performData] = await contract.checkUpkeep('0x');
    expect(needed).to.eq(true);

    await expect(contract.performUpkeep(performData))
      .to.emit(contract, 'RoundFinalized')
      .withArgs(targetRound, 50_000, 50_000, 3);
  });

  it('reveals totals, accrues fee, and pays winners correctly', async function () {
    const { contract, feed, stake, alice, bob } = await deployFixture();
    const baseTime = 5_000_000;
    await setTime(baseTime);

    const currentRound = Math.floor(baseTime / ROUND_SECONDS);
    const targetRound = currentRound + 1;
    const contractAddress = await contract.getAddress();

    const encryptedAlice = await encryptDirection(contractAddress, alice, 1);
    const encryptedBob = await encryptDirection(contractAddress, bob, 0);

    await contract
      .connect(alice)
      .placeBet(targetRound, encryptedAlice.handles[0], encryptedAlice.inputProof, { value: stake });
    await contract
      .connect(bob)
      .placeBet(targetRound, encryptedBob.handles[0], encryptedBob.inputProof, { value: stake });

    await feed.setLatestRoundData(50_000, baseTime);
    await contract.finalizeRound(currentRound - 1);

    const endTime = (targetRound + 1) * ROUND_SECONDS + 1;
    await setTime(endTime);
    await feed.setLatestRoundData(60_000, endTime);
    await contract.finalizeRound(targetRound);

    await contract.requestRoundReveal(targetRound);
    const handles = await contract.getRoundHandles(targetRound);
    const totalsDecrypt = await hre.fhevm.publicDecrypt([handles[0], handles[1]]);
    await contract.resolveTotalsCallback(
      targetRound,
      totalsDecrypt.abiEncodedClearValues,
      totalsDecrypt.decryptionProof
    );

    const fee = (stake * 200n) / 10_000n;
    expect(await contract.feeAccrued()).to.eq(fee);

    await contract.connect(alice).requestClaim(targetRound);
    await contract.connect(bob).requestClaim(targetRound);

    const alicePending = await contract.getPendingClaim(targetRound, alice.address);
    const bobPending = await contract.getPendingClaim(targetRound, bob.address);

    const aliceDecrypt = await hre.fhevm.publicDecrypt([alicePending[1]]);
    const bobDecrypt = await hre.fhevm.publicDecrypt([bobPending[1]]);

    const expectedPayout = stake * 2n - fee;
    await expect(
      contract
        .connect(alice)
        .claimCallback(targetRound, aliceDecrypt.abiEncodedClearValues, aliceDecrypt.decryptionProof)
    )
      .to.emit(contract, 'ClaimPaid')
      .withArgs(targetRound, alice.address, expectedPayout);

    await expect(
      contract
        .connect(bob)
        .claimCallback(targetRound, bobDecrypt.abiEncodedClearValues, bobDecrypt.decryptionProof)
    )
      .to.emit(contract, 'ClaimPaid')
      .withArgs(targetRound, bob.address, 0);

    const aliceStats = await contract.getUserStats(alice.address);
    expect(aliceStats[1]).to.eq(1n);
    expect(aliceStats[3]).to.eq(expectedPayout);

    const bobStats = await contract.getUserStats(bob.address);
    expect(bobStats[1]).to.eq(0n);
    expect(bobStats[3]).to.eq(0n);
  });
});
