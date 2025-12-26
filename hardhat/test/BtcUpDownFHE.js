const { expect } = require('chai');
const hre = require('hardhat');

const ROUND_SECONDS = 3600;

const setTime = async (timestamp) => {
  await hre.network.provider.send('evm_setNextBlockTimestamp', [timestamp]);
  await hre.network.provider.send('evm_mine');
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

    const inputAlice = hre.fhevm.createEncryptedInput(contractAddress, alice.address);
    inputAlice.add32(1);
    const encryptedAlice = await inputAlice.encrypt();

    const inputBob = hre.fhevm.createEncryptedInput(contractAddress, bob.address);
    inputBob.add32(0);
    const encryptedBob = await inputBob.encrypt();

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

    const input = hre.fhevm.createEncryptedInput(contractAddress, alice.address);
    input.add32(1);
    const encrypted = await input.encrypt();

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
});
