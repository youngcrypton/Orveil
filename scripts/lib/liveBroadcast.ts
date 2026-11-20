import { ethers } from "ethers";
import * as dotenv from "dotenv";
import {
  simulateBatchSettlement,
  assertBatchReadyForBroadcast,
  DEFAULT_DIANA_RPC,
  DEFAULT_SETTLER_ADDRESS,
  DEFAULT_DEPLOYER_EVM,
  DEFAULT_FALLBACK_GAS_LIMIT,
  MAX_BLOCK_GAS_LIMIT
} from "./dryRunSimulation";
import {
  estimateCompliantGasPrice,
  DIANA_CHAIN_ID,
  DEFAULT_HEADROOM_PERCENT,
  DIANA_MIN_GAS_FLOOR_WEI
} from "./safetyGuards";
import { BatchCommitmentPayload } from "../../sequencer/batchSequencer";
import { OreVeilSettler, OreVeilSettler__factory } from "../../typechain-types/contracts/OreVeilSettler";

dotenv.config();

export const DIANA_EXPLORER_BASE = "https://explore.qore.network";
export const DEFAULT_CONFIRMATIONS = 1;
export const DEFAULT_BROADCAST_GAS_LIMIT = 3_500_000n;

export interface BroadcastOptions {
  provider?: ethers.Provider;
  signer?: ethers.Signer;
  privateKey?: string;
  settlerAddress?: string;
  gasHeadroomPercent?: number;
  customGasFloorWei?: bigint;
  gasLimit?: bigint;
  confirmations?: number;
  skipPreflightSimulation?: boolean;
  restUrl?: string;
}

export interface EmittedBatchSettledEvent {
  batchId: number;
  prevStateRoot: string;
  newStateRoot: string;
  withdrawalRoot: string;
  dataHash: string;
}

export interface BroadcastResult {
  success: boolean;
  batchId: number;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  gasUsed: bigint;
  effectiveGasPriceWei: bigint;
  totalFeeWei: bigint;
  totalFeeQor: string;
  deployerAddress: string;
  initialBalanceQor: string;
  finalBalanceQor: string;
  balanceDeltaQor: string;
  explorerUrl: string;
  latestBatchIdAfter: number;
  latestStateRootAfter: string;
  emittedBatchSettledEvent?: EmittedBatchSettledEvent;
  timestamp: string;
}

/**
 * Formats a canonical Diana block explorer link for a given transaction hash.
 */
export function formatDianaExplorerLink(txHash: string): string {
  return `${DIANA_EXPLORER_BASE}/tx/${txHash}`;
}

/**
 * Resolves an authorized deployer signer from options, explicit private key,
 * or process.env.DEPLOYER_PRIVATE_KEY (supporting either hex key or mnemonic phrase).
 */
export function resolveDeployerSigner(
  provider: ethers.Provider,
  options?: BroadcastOptions
): ethers.Signer {
  if (options?.signer) {
    return options.signer;
  }

  const rawKey = options?.privateKey || process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!rawKey) {
    throw new Error(
      "Missing deployer private key. Provide via options.signer, options.privateKey, or DEPLOYER_PRIVATE_KEY in .env"
    );
  }

  // Handle mnemonic seed phrase vs raw hex private key
  let wallet: ethers.Wallet;
  if (rawKey.includes(" ")) {
    wallet = ethers.Wallet.fromPhrase(rawKey, provider);
  } else {
    const formattedHex = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
    wallet = new ethers.Wallet(formattedHex, provider);
  }

  return wallet;
}

/**
 * Parses and decodes the on-chain BatchSettled event from transaction receipt logs.
 */
export function parseBatchSettledEvent(
  receiptLogs: readonly ethers.Log[],
  iface: ethers.Interface
): EmittedBatchSettledEvent | undefined {
  const eventFragment = iface.getEvent("BatchSettled");
  if (!eventFragment) return undefined;

  for (const log of receiptLogs) {
    if (log.topics[0] === eventFragment.topicHash) {
      try {
        const decoded = iface.decodeEventLog(eventFragment, log.data, log.topics);
        return {
          batchId: Number(decoded.batchId),
          prevStateRoot: decoded.prevStateRoot,
          newStateRoot: decoded.newStateRoot,
          withdrawalRoot: decoded.withdrawalRoot,
          dataHash: decoded.dataHash
        };
      } catch {
        continue;
      }
    }
  }

  return undefined;
}

/**
 * Dispatches a verified OreVeil rollup batch commitment to QoreChain Diana Testnet (Method 2).
 * 
 * Execution Pipeline:
 * 1. Executes Layer 4 pre-flight simulation (Method 1) as mandatory safety shield unless bypassed.
 * 2. Resolves authorized deployer wallet and queries initial balance.
 * 3. Decorates transaction with consensus-compliant gas pricing (>= 112.5 gwei) and chainId: 9800.
 * 4. Broadcasts settleBatch(...) carrying the 4,627-byte ML-DSA-87 signature to Layer 1.
 * 5. Awaits 1-block consensus confirmation on Diana Testnet.
 * 6. Measures gas used, QOR fee deducted, and captures explorer receipt.
 * 7. Extracts and decodes on-chain BatchSettled event and confirms state advancement (latestBatchId).
 */
export async function broadcastBatchSettlement(
  payload: BatchCommitmentPayload,
  options?: BroadcastOptions
): Promise<BroadcastResult> {
  const timestamp = new Date().toISOString();
  const provider =
    options?.provider ??
    new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
    });

  const settlerAddress = options?.settlerAddress || DEFAULT_SETTLER_ADDRESS;
  const signer = resolveDeployerSigner(provider, options);
  const deployerAddress = await signer.getAddress();

  // Step 1: Pre-Flight Simulation Gate (Method 1)
  if (!options?.skipPreflightSimulation) {
    const simReport = await simulateBatchSettlement(payload, {
      provider,
      settlerAddress,
      callerAddress: deployerAddress,
      gasHeadroomPercent: options?.gasHeadroomPercent,
      customGasFloorWei: options?.customGasFloorWei,
      restUrl: options?.restUrl
    });
    assertBatchReadyForBroadcast(simReport);
  }

  // Step 2: Query Initial Solvency & Balance
  const initialBalanceWei = await provider.getBalance(deployerAddress);
  const initialBalanceQor = ethers.formatEther(initialBalanceWei);

  // Step 3: Estimate Consensus-Compliant Gas Pricing (>= 112.5 gwei)
  const gasConfig = await estimateCompliantGasPrice(provider, {
    headroomPercent: options?.gasHeadroomPercent ?? DEFAULT_HEADROOM_PERCENT,
    customFloorWei: options?.customGasFloorWei ?? DIANA_MIN_GAS_FLOOR_WEI,
    restUrl: options?.restUrl
  });

  const gasLimit = options?.gasLimit ?? DEFAULT_BROADCAST_GAS_LIMIT;
  const settler = OreVeilSettler__factory.connect(settlerAddress, signer);

  // Step 4: Broadcast Live On-Chain Transaction to Diana Testnet
  const tx = await settler.settleBatch(
    BigInt(payload.batchId),
    payload.prevStateRoot,
    payload.newStateRoot,
    payload.withdrawalRoot,
    payload.dataHash,
    payload.signature,
    {
      gasPrice: gasConfig.effectiveGasPriceWei,
      gasLimit
    }
  );

  // Step 5: Await Diana Consensus Block Mining Confirmation
  const receipt = await tx.wait(options?.confirmations ?? DEFAULT_CONFIRMATIONS);
  if (!receipt) {
    throw new Error(`Transaction ${tx.hash} dropped or receipt unretrievable on Diana Testnet`);
  }

  // Step 6: Post-Mining Telemetry & Balance Delta
  const finalBalanceWei = await provider.getBalance(deployerAddress);
  const finalBalanceQor = ethers.formatEther(finalBalanceWei);

  const balanceDeltaWei =
    initialBalanceWei > finalBalanceWei
      ? initialBalanceWei - finalBalanceWei
      : 0n;
  const balanceDeltaQor = ethers.formatEther(balanceDeltaWei);

  const gasUsed = receipt.gasUsed;
  const effectiveGasPriceWei = receipt.gasPrice || gasConfig.effectiveGasPriceWei;
  const totalFeeWei = gasUsed * effectiveGasPriceWei;
  const totalFeeQor = ethers.formatEther(totalFeeWei);

  // Step 7: Parse Emitted Event and Audit Contract State Advancement
  const emittedBatchSettledEvent = parseBatchSettledEvent(receipt.logs, settler.interface);
  const latestBatchIdAfter = Number(await settler.latestBatchId());
  const latestStateRootAfter = await settler.latestStateRoot();

  const explorerUrl = formatDianaExplorerLink(receipt.hash);

  return {
    success: receipt.status === 1,
    batchId: payload.batchId,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    gasUsed,
    effectiveGasPriceWei,
    totalFeeWei,
    totalFeeQor,
    deployerAddress,
    initialBalanceQor,
    finalBalanceQor,
    balanceDeltaQor,
    explorerUrl,
    latestBatchIdAfter,
    latestStateRootAfter,
    emittedBatchSettledEvent,
    timestamp
  };
}

/**
 * Formats a BroadcastResult into a senior-grade ASCII summary block.
 */
export function formatBroadcastSummary(result: BroadcastResult): string {
  const effectiveGwei = (
    Number(result.effectiveGasPriceWei) / 1e9
  ).toFixed(2);

  return [
    "================================================================================",
    "             OREVEIL BATCH SETTLEMENT ON-CHAIN BROADCAST RECEIPT                ",
    "================================================================================",
    ` Status              : ${result.success ? "SUCCESS [MINED]" : "FAILED [REVERTED]"}`,
    ` Timestamp           : ${result.timestamp}`,
    ` Batch Sequence ID   : ${result.batchId} (On-chain latest: ${result.latestBatchIdAfter})`,
    "--------------------------------------------------------------------------------",
    " DIANA TESTNET RECEIPT TELEMETRY:",
    `   Transaction Hash  : ${result.txHash}`,
    `   Block Number      : ${result.blockNumber.toLocaleString()}`,
    `   Block Hash        : ${result.blockHash}`,
    `   Explorer URL      : ${result.explorerUrl}`,
    "--------------------------------------------------------------------------------",
    " GAS CONSUMPTION & ECONOMIC DEDUCTION:",
    `   Gas Used          : ${result.gasUsed.toLocaleString()} units`,
    `   Effective Gas Price: ${effectiveGwei} gwei (>= 100 gwei floor)`,
    `   Total Fee Burned  : ${result.totalFeeQor} QOR`,
    `   Deployer Wallet   : ${result.deployerAddress}`,
    `   Pre-Tx Balance    : ${result.initialBalanceQor} QOR`,
    `   Post-Tx Balance   : ${result.finalBalanceQor} QOR`,
    `   Actual Deducted   : -${result.balanceDeltaQor} QOR`,
    "--------------------------------------------------------------------------------",
    " POST-BROADCAST ON-CHAIN STATE:",
    `   Anchored State Root: ${result.latestStateRootAfter}`,
    ...(result.emittedBatchSettledEvent
      ? [
          `   Event Verified    : BatchSettled(batchId: ${result.emittedBatchSettledEvent.batchId}, withdrawalRoot: ${result.emittedBatchSettledEvent.withdrawalRoot.slice(0, 10)}...)`
        ]
      : []),
    "================================================================================"
  ].join("\n");
}
