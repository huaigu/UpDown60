const hre = require('hardhat');

const DEFAULTS = {
  stakeEth: '0.01',
  feeBps: '200',
  maxPriceAge: '3600',
  btcUsdFeed: '0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43',
};

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const stakeEth = process.env.STAKE_ETH || DEFAULTS.stakeEth;
  const feeBps = Number(process.env.FEE_BPS || DEFAULTS.feeBps);
  const maxPriceAge = Number(process.env.MAX_PRICE_AGE || DEFAULTS.maxPriceAge);
  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;
  const btcUsdFeed = process.env.BTC_USD_FEED || DEFAULTS.btcUsdFeed;

  const stakeWei = hre.ethers.parseEther(stakeEth);

  const factory = await hre.ethers.getContractFactory('BtcUpDownFHE');
  const contract = await factory.deploy(
    stakeWei,
    feeBps,
    feeRecipient,
    btcUsdFeed,
    maxPriceAge
  );
  await contract.waitForDeployment();
  const deployTx = contract.deploymentTransaction();
  const receipt = await deployTx.wait();
  const address = await contract.getAddress();

  console.log('BtcUpDownFHE deployed to:', address);
  console.log('Deploy tx:', deployTx.hash);
  console.log('Deploy block:', receipt?.blockNumber ?? 'unknown');
  console.log('Constructor args:', {
    stakeWei: stakeWei.toString(),
    feeBps,
    feeRecipient,
    btcUsdFeed,
    maxPriceAge,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
