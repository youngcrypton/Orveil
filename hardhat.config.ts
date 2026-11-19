import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

function getAccounts(): string[] {
  const key = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!key) return [];
  if (key.includes(" ")) {
    try {
      const { ethers } = require("ethers");
      return [ethers.Wallet.fromPhrase(key).privateKey];
    } catch {
      return [];
    }
  }
  return [key.startsWith("0x") ? key : `0x${key}`];
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      viaIR: true
    }
  },
  networks: {
    hardhat: {
      chainId: 31337
    },
    diana: {
      url: "https://evm-testnet.qore.host",
      chainId: 9800,
      gasPrice: 110000000000, // 0.11 uqor
      accounts: getAccounts()
    }
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};

export default config;
