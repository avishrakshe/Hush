import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";
import * as path from "node:path";

// One .env at the monorepo root is shared by every package.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
const accounts = deployerKey ? [deployerKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    // eERC pins 0.8.27 exactly; Hush contracts use the same compiler so the whole tree builds with one solc.
    version: "0.8.27",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // C-Chain supports Cancun opcodes since the Etna upgrade.
      evmVersion: "cancun",
    },
  },
  networks: {
    // The in-process / `hardhat node` chain. By default every block must be stamped at least 1 s after the previous one,
    // so a burst of transactions (bootstrap, agents, e2e) pushes chain time minutes ahead of the wall clock — and then
    // EIP-3009 authorizations (valid ~60 s of wall time) look expired. Same-second blocks keep the clocks together.
    hardhat: {
      allowBlocksWithSameTimestamp: true,
    },
    // `pnpm node` + `pnpm deploy:local`: offline dry runs with the same role keys (funded via hardhat_setBalance).
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      accounts,
    },
    fuji: {
      url: process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
      chainId: 43113,
      accounts,
    },
    avalanche: {
      url: process.env.AVALANCHE_RPC_URL || "https://api.avax.network/ext/bc/C/rpc",
      chainId: 43114,
      accounts,
    },
  },
  etherscan: {
    // Snowtrace verification goes through Routescan's Etherscan-compatible API.
    apiKey: {
      avalancheFujiTestnet: process.env.SNOWTRACE_API_KEY || "snowtrace",
      avalanche: process.env.SNOWTRACE_API_KEY || "snowtrace",
    },
    customChains: [
      {
        network: "avalancheFujiTestnet",
        chainId: 43113,
        urls: {
          apiURL: "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan",
          browserURL: "https://testnet.snowtrace.io",
        },
      },
      {
        network: "avalanche",
        chainId: 43114,
        urls: {
          apiURL: "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan",
          browserURL: "https://snowtrace.io",
        },
      },
    ],
  },
  sourcify: { enabled: false },
  typechain: { outDir: "typechain-types", target: "ethers-v6" },
  gasReporter: { enabled: !!process.env.REPORT_GAS, currency: "USD" },
  mocha: { timeout: 120_000 },
};

export default config;
