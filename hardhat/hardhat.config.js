const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envFile = fs.readFileSync(envPath, "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

require("@fhevm/hardhat-plugin");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
require("@typechain/hardhat");
require("hardhat-deploy");
require("hardhat-gas-reporter");
require("solidity-coverage");

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

const normalizePrivateKey = (value) => {
  if (!value) return "";
  return value.startsWith("0x") ? value : `0x${value}`;
};

const HARDHAT_PRIVATE_KEYS = [
  normalizePrivateKey(PRIVATE_KEY),
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f7e99fdb5a906",
  "0x8b3a350cf5c34c9194ca3a9d52ad1ec9b8b6a3c4c6d97a6f4d8db36805b97e99",
  "0x92db14e403b83d41ef97e74fba8bb5f9b5eeb12893c9b474e545e6322f7b26b0",
].filter(Boolean);

/** @type {import('hardhat/config').HardhatUserConfig} */
const config = {
  defaultNetwork: "hardhat",
  namedAccounts: {
    deployer: 0,
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
  gasReporter: {
    currency: "USD",
    enabled: !!process.env.REPORT_GAS,
  },
  networks: {
    hardhat: {
      chainId: 31337,
      accounts: HARDHAT_PRIVATE_KEYS.map((privateKey) => ({
        privateKey,
        balance: "10000000000000000000000",
      })),
    },
    sepolia: {
      accounts: PRIVATE_KEY ? [normalizePrivateKey(PRIVATE_KEY)] : [],
      chainId: 11155111,
      url: "https://ethereum-sepolia-rpc.publicnode.com",
    },
  },
  paths: {
    artifacts: "./artifacts",
    cache: "./cache",
    sources: "./contracts",
    tests: "./test",
  },
  solidity: {
    version: "0.8.24",
    settings: {
      metadata: { bytecodeHash: "none" },
      optimizer: { enabled: true, runs: 800 },
      evmVersion: "cancun",
    },
  },
  typechain: {
    outDir: "types",
    target: "ethers-v6",
  },
};

module.exports = config;
