import { ethers } from "ethers";
import {
  fetchMinGasPriceUqor,
  recommendedGasPriceUqor,
  fetchEvmWindow
} from "@qorechain/sdk";

export const DIANA_CHAIN_ID = 9800;
export const DEFAULT_DIANA_REST = "https://api-testnet.qore.host";
export const DEFAULT_DIANA_RPC = "https://evm-testnet.qore.host";

// 0.1 uqor = 10^11 wei = 100 gwei
export const DIANA_MIN_GAS_FLOOR_WEI = 100_000_000_000n;
export const DEFAULT_HEADROOM_PERCENT = 12.5; // 112.5 gwei when floor is 100 gwei
export const DEFAULT_SETTLE_BATCH_GAS_LIMIT = 3_500_000n;

export const DEFAULT_DEPLOYER_EVM = "0x7DE7d6CC73002f44A76334392555C9A4dDc0B561";
export const DEFAULT_DEPLOYER_COSMOS = "qor10hnadnrnqqh5ffmrxsuj24wf5nwupdtp0zw8kt";

export interface GasConfig {
  minGasFloorWei: bigint;
  recommendedGasPriceWei: bigint;
  effectiveGasPriceWei: bigint;
  headroomPercent: number;
  gasPriceGwei: string;
}

export interface EvmWindowReport {
  found: boolean;
  live: boolean;
  address: string;
  openedHeight: bigint;
  expiryHeight: bigint;
  remainingBlocks: bigint;
  remainingTxs: bigint;
  remainingValue: bigint;
  statusText: string;
}

export interface GasOptions {
  headroomPercent?: number;
  restUrl?: string;
  customFloorWei?: bigint;
}

export interface WindowOptions {
  restUrl?: string;
  address?: string;
}

export interface DecorateOptions {
  gasLimit?: bigint;
  headroomPercent?: number;
  restUrl?: string;
  chainId?: number;
}

/**
 * Estimates consensus-compliant gas pricing for QoreChain Diana Testnet:
 * 1. Queries live EVM fee data and Cosmos REST feemarket parameters.
 * 2. Enforces the strict >= 0.1 uqor (100 gwei) floor.
 * 3. Applies calibrated headroom (default +12.5%) for 4.8KB post-quantum calldata payloads.
 */
export async function estimateCompliantGasPrice(
  provider: ethers.Provider,
  options?: GasOptions
): Promise<GasConfig> {
  const minFloor = options?.customFloorWei ?? DIANA_MIN_GAS_FLOOR_WEI;
  const headroom = options?.headroomPercent ?? DEFAULT_HEADROOM_PERCENT;
  const restUrl = options?.restUrl || DEFAULT_DIANA_REST;

  let networkPriceWei = minFloor;

  // 1. Query EVM JSON-RPC Fee Data
  try {
    const feeData = await provider.getFeeData();
    if (feeData.gasPrice && feeData.gasPrice > 0n) {
      networkPriceWei = feeData.gasPrice;
    }
  } catch {
    // Fall back to minFloor if EVM provider query fails
  }

  // 2. Query Cosmos REST Feemarket (if accessible)
  try {
    const minUqorStr = await fetchMinGasPriceUqor({ rest: restUrl });
    // 1 uqor = 10^12 wei, so 0.1 uqor = 10^11 wei = 100 gwei
    const minFromRestWei = ethers.parseUnits(minUqorStr, 12);
    if (minFromRestWei > minFloor) {
      networkPriceWei = minFromRestWei > networkPriceWei ? minFromRestWei : networkPriceWei;
    }
  } catch {
    // Non-fatal, minFloor remains enforced
  }

  // Enforce floor
  const baselineWei = networkPriceWei > minFloor ? networkPriceWei : minFloor;

  // Apply calibrated headroom: effective = baseline * (1 + headroom / 100)
  // Scaled integer arithmetic: (baseline * (1000 + headroom * 10)) / 1000
  const scaledMultiplier = BigInt(Math.round(1000 + headroom * 10));
  let effectiveGasPriceWei = (baselineWei * scaledMultiplier) / 1000n;

  if (effectiveGasPriceWei < minFloor) {
    effectiveGasPriceWei = minFloor;
  }

  // Recommended pricing
  const recommendedWei = (minFloor * 115n) / 100n; // 115 gwei

  return {
    minGasFloorWei: minFloor,
    recommendedGasPriceWei: recommendedWei,
    effectiveGasPriceWei,
    headroomPercent: headroom,
    gasPriceGwei: ethers.formatUnits(effectiveGasPriceWei, "gwei")
  };
}

/**
 * Audits the account's active EVM authorization window on Diana Testnet.
 */
export async function queryEvmWindowStatus(options?: WindowOptions): Promise<EvmWindowReport> {
  const restUrl = options?.restUrl || DEFAULT_DIANA_REST;
  const address = options?.address || DEFAULT_DEPLOYER_COSMOS;

  try {
    const raw = await fetchEvmWindow({ rest: restUrl, address });
    let statusText: string;

    if (raw.live) {
      statusText = `ACTIVE (Expires at block ${raw.expiryHeight}, ${raw.remainingBlocks} blocks remaining)`;
    } else if (raw.found) {
      statusText = `EXPIRED (Opened at block ${raw.openedHeight}, expired at block ${raw.expiryHeight})`;
    } else {
      statusText = "NO_RECORD_FOUND";
    }

    return {
      found: raw.found,
      live: raw.live,
      address,
      openedHeight: raw.openedHeight,
      expiryHeight: raw.expiryHeight,
      remainingBlocks: raw.remainingBlocks,
      remainingTxs: raw.remainingTxs,
      remainingValue: raw.remainingValue,
      statusText
    };
  } catch (err: any) {
    const isNotFound =
      err?.message &&
      (err.message.includes("404") ||
        err.message.includes("400") ||
        err.message.includes("not found") ||
        err.message.includes("does not exist"));

    return {
      found: false,
      live: false,
      address,
      openedHeight: 0n,
      expiryHeight: 0n,
      remainingBlocks: 0n,
      remainingTxs: 0n,
      remainingValue: 0n,
      statusText: isNotFound ? "NO_RECORD_FOUND" : `QUERY_ERROR: ${err?.message || String(err)}`
    };
  }
}

/**
 * Decorates an Ethers transaction request with consensus-compliant Diana parameters:
 * 1. Sets gasPrice >= 0.1 uqor (with calibrated headroom).
 * 2. Sets chainId strictly to 9800.
 * 3. Sets or estimates gasLimit.
 */
export async function decorateTransaction(
  tx: ethers.TransactionRequest,
  provider: ethers.Provider,
  options?: DecorateOptions
): Promise<ethers.TransactionRequest> {
  const decorated: ethers.TransactionRequest = { ...tx };
  const targetChainId = options?.chainId ?? DIANA_CHAIN_ID;

  // 1. Gas pricing decoration
  const gasConfig = await estimateCompliantGasPrice(provider, {
    headroomPercent: options?.headroomPercent,
    restUrl: options?.restUrl
  });

  decorated.gasPrice = gasConfig.effectiveGasPriceWei;
  decorated.chainId = targetChainId;

  // 2. Gas limit decoration
  if (options?.gasLimit) {
    decorated.gasLimit = options.gasLimit;
  } else if (!decorated.gasLimit) {
    try {
      const estimated = await provider.estimateGas(decorated);
      // Add 20% buffer on top of simulation
      decorated.gasLimit = (estimated * 120n) / 100n;
    } catch {
      decorated.gasLimit = DEFAULT_SETTLE_BATCH_GAS_LIMIT;
    }
  }

  return decorated;
}

/**
 * Formats a clean human-readable diagnostic report for gas and EVM authorization window status.
 */
export function formatSafetyReport(gas: GasConfig, win: EvmWindowReport): string {
  const divider = "================================================================================";
  const subDivider = "--------------------------------------------------------------------------------";

  return [
    divider,
    "  OreVeil Diana Gas & EVM Window Safety Guard Report",
    divider,
    `Chain ID:                  ${DIANA_CHAIN_ID}`,
    `Minimum Gas Floor:         ${ethers.formatUnits(gas.minGasFloorWei, "gwei")} gwei (${gas.minGasFloorWei} wei)`,
    `Effective Gas Price:       ${gas.gasPriceGwei} gwei (${gas.effectiveGasPriceWei} wei)`,
    `Applied Safety Headroom:   +${gas.headroomPercent}%`,
    subDivider,
    `EVM Authorization Target:  ${win.address}`,
    `EVM Window Status:         ${win.statusText}`,
    `Window Live on Diana:      ${win.live ? "[YES - HEALTHY]" : "[NO - EXPIRED/INACTIVE]"}`,
    `Remaining Blocks:          ${win.remainingBlocks}`,
    `Remaining Transactions:    ${win.remainingTxs}`,
    divider
  ].join("\n");
}
