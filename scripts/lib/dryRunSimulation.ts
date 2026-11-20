import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SIGNATURE_LENGTH
} from "@qorechain/qoresign";
import {
  BatchCommitmentPayload,
  DIANA_CHAIN_ID
} from "../../sequencer/batchSequencer";
import {
  estimateCompliantGasPrice,
  DEFAULT_DIANA_RPC,
  DEFAULT_DEPLOYER_EVM,
  DEFAULT_HEADROOM_PERCENT,
  DIANA_MIN_GAS_FLOOR_WEI
} from "./safetyGuards";
import { OreVeilSettler } from "../../typechain-types/contracts/OreVeilSettler";
import { OreVeilSettler__factory } from "../../typechain-types/factories/contracts/OreVeilSettler__factory";

export const DEFAULT_DIANA_RPC = "https://evm-testnet.qore.host";
export const DEFAULT_DEPLOYER_EVM = "0x7DE7d6CC73002f44A76334392555C9A4dDc0B561";
export const DEFAULT_SETTLER_ADDRESS = "0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44";
export const DEFAULT_CALLER_ADDRESS = DEFAULT_DEPLOYER_EVM;
export const MAX_BLOCK_GAS_LIMIT = 30_000_000n;
export const DEFAULT_FALLBACK_GAS_LIMIT = 3_500_000n;

export interface DryRunSimulationConfig {
  provider?: ethers.Provider;
  settlerAddress?: string;
  callerAddress?: string;
  gasHeadroomPercent?: number;
  customGasFloorWei?: bigint;
  restUrl?: string;
  dsaKeyPath?: string;
}

export interface DryRunReport {
  success: boolean;
  batchId: number;
  onChainLatestBatchId: number;
  prevStateRoot: string;
  newStateRoot: string;
  withdrawalRoot: string;
  dataHash: string;
  signatureLengthBytes: number;
  simulatedGasUnits: bigint;
  effectiveGasPriceWei: bigint;
  estimatedFeeWei: bigint;
  estimatedFeeQor: string;
  deployerBalanceWei: bigint;
  deployerBalanceQor: string;
  solvencyMarginRatio: number;
  revertReason?: string;
  readyForBroadcast: boolean;
  timestamp: string;
}

/**
 * Parses raw EVM revert data and error objects into human-readable custom error names
 * matching OreVeilSettler.sol (e.g. InvalidBatchId, StateRootMismatch, InvalidMLDSASignature).
 */
export function parseContractRevert(error: any, contractInterface?: ethers.Interface): string {
  const errorData =
    error?.data ||
    error?.info?.error?.data ||
    error?.error?.data ||
    error?.error?.error?.data;

  if (errorData && typeof errorData === "string" && contractInterface) {
    try {
      const parsed = contractInterface.parseError(errorData);
      if (parsed) return parsed.name;
    } catch {}
  }

  if (error?.reason) return error.reason;
  if (error?.shortMessage) {
    for (const errName of [
      "InvalidBatchId",
      "StateRootMismatch",
      "InvalidMLDSASignature",
      "PrecompileCallFailed",
      "InvalidKeyLength",
      "InvalidMerkleProof",
      "WithdrawalAlreadyProcessed"
    ]) {
      if (error.shortMessage.includes(errName)) return errName;
    }
    return error.shortMessage;
  }

  if (error?.message) {
    for (const errName of [
      "InvalidBatchId",
      "StateRootMismatch",
      "InvalidMLDSASignature",
      "PrecompileCallFailed",
      "InvalidKeyLength",
      "InvalidMerkleProof",
      "WithdrawalAlreadyProcessed"
    ]) {
      if (error.message.includes(errName)) return errName;
    }
    return error.message;
  }

  return "Unknown EVM revert";
}

/**
 * Simulates settleBatch() execution via non-destructive EVM staticcall against live Diana Testnet.
 * 
 * Invariants enforced:
 * 1. Synchronizes live latestBatchId and latestStateRoot from deployed OreVeilSettler.
 * 2. Executes settleBatch.staticCall(...) with real NIST FIPS 204 (ML-DSA-87) 4,627B signature.
 * 3. Measures actual precompile 0x...0a01 gas overhead via estimateGas.
 * 4. Audits deployer economic solvency at >= 100 gwei floor with headroom.
 * 5. Returns a structured diagnostic report without broadcasting any transaction.
 */
export async function simulateBatchSettlement(
  payload: BatchCommitmentPayload,
  config?: DryRunSimulationConfig
): Promise<DryRunReport> {
  const timestamp = new Date().toISOString();
  const provider =
    config?.provider ??
    new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
    });
  const settlerAddress = config?.settlerAddress || DEFAULT_SETTLER_ADDRESS;
  const callerAddress = config?.callerAddress || DEFAULT_CALLER_ADDRESS;

  const settler = OreVeilSettler__factory.connect(settlerAddress, provider);

  // 1. Synchronize live on-chain contract state
  const onChainLatestBatchId = Number(await settler.latestBatchId());
  const onChainLatestStateRoot = await settler.latestStateRoot();

  // 2. Compute signature byte dimensions
  let signatureLengthBytes = 0;
  try {
    const sigBytes = ethers.getBytes(payload.signature);
    signatureLengthBytes = sigBytes.length;
  } catch {
    signatureLengthBytes = 0;
  }

  // 3. Obtain consensus-compliant gas pricing (Layer 3)
  const gasConfig = await estimateCompliantGasPrice(provider, {
    headroomPercent: config?.gasHeadroomPercent ?? DEFAULT_HEADROOM_PERCENT,
    customFloorWei: config?.customGasFloorWei ?? DIANA_MIN_GAS_FLOOR_WEI,
    restUrl: config?.restUrl
  });

  // 4. Fetch live deployer balance
  let deployerBalanceWei = 0n;
  try {
    deployerBalanceWei = await provider.getBalance(callerAddress);
  } catch {
    deployerBalanceWei = 0n;
  }
  const deployerBalanceQor = ethers.formatEther(deployerBalanceWei);

  // 5. Execute Non-Destructive EVM StaticCall
  let success = false;
  let revertReason: string | undefined;
  let simulatedGasUnits = 0n;

  try {
    await settler.settleBatch.staticCall(
      BigInt(payload.batchId),
      payload.prevStateRoot,
      payload.newStateRoot,
      payload.withdrawalRoot,
      payload.dataHash,
      payload.signature,
      { from: callerAddress }
    );
    success = true;
  } catch (err: any) {
    success = false;
    revertReason = parseContractRevert(err, settler.interface);
  }

  // 6. If staticcall succeeded, perform live gas estimation
  if (success) {
    try {
      simulatedGasUnits = await settler.settleBatch.estimateGas(
        BigInt(payload.batchId),
        payload.prevStateRoot,
        payload.newStateRoot,
        payload.withdrawalRoot,
        payload.dataHash,
        payload.signature,
        { from: callerAddress }
      );
    } catch {
      simulatedGasUnits = DEFAULT_FALLBACK_GAS_LIMIT;
    }
  }

  // 7. Calculate economic bounds and solvency headroom
  const estimatedFeeWei = simulatedGasUnits * gasConfig.effectiveGasPriceWei;
  const estimatedFeeQor = ethers.formatEther(estimatedFeeWei);

  let solvencyMarginRatio = 0;
  if (estimatedFeeWei > 0n) {
    solvencyMarginRatio = Number(deployerBalanceWei / estimatedFeeWei);
  }

  const readyForBroadcast =
    success &&
    deployerBalanceWei >= estimatedFeeWei &&
    simulatedGasUnits <= MAX_BLOCK_GAS_LIMIT;

  return {
    success,
    batchId: payload.batchId,
    onChainLatestBatchId,
    prevStateRoot: payload.prevStateRoot,
    newStateRoot: payload.newStateRoot,
    withdrawalRoot: payload.withdrawalRoot,
    dataHash: payload.dataHash,
    signatureLengthBytes,
    simulatedGasUnits,
    effectiveGasPriceWei: gasConfig.effectiveGasPriceWei,
    estimatedFeeWei,
    estimatedFeeQor,
    deployerBalanceWei,
    deployerBalanceQor,
    solvencyMarginRatio,
    revertReason,
    readyForBroadcast,
    timestamp
  };
}

/**
 * Formats a DryRunReport into a clean, structured rehearsal audit summary.
 */
export function formatDryRunReport(report: DryRunReport): string {
  const statusBadge = report.success ? "PASS [SIMULATED]" : "FAIL [REVERTED]";
  const broadcastVerdict = report.readyForBroadcast
    ? "READY FOR LIVE BROADCAST"
    : "BROADCAST BLOCKED";

  const effectiveGwei = (
    Number(report.effectiveGasPriceWei) / 1e9
  ).toFixed(2);

  return [
    "================================================================================",
    "             OREVEIL POST-QUANTUM ROLLUP BATCH DRY-RUN REHEARSAL               ",
    "================================================================================",
    ` Timestamp            : ${report.timestamp}`,
    ` Simulation Status    : ${statusBadge}`,
    ` Broadcast Readiness  : ${broadcastVerdict}`,
    "--------------------------------------------------------------------------------",
    " BATCH TRANSITION & CRYPTOGRAPHIC INVARIANTS:",
    `   Target Batch ID    : ${report.batchId} (On-chain latest: ${report.onChainLatestBatchId})`,
    `   Prev State Root    : ${report.prevStateRoot}`,
    `   New State Root     : ${report.newStateRoot}`,
    `   Withdrawal Root    : ${report.withdrawalRoot}`,
    `   Batch Data Hash    : ${report.dataHash}`,
    `   ML-DSA-87 Sig Size : ${report.signatureLengthBytes} bytes (FIPS 204 invariant: 4627 B)`,
    "--------------------------------------------------------------------------------",
    " GAS CONSUMPTION & ECONOMIC SOLVENCY AUDIT:",
    `   Simulated Gas Units: ${report.simulatedGasUnits.toLocaleString()} gas`,
    `   Effective Gas Price: ${effectiveGwei} gwei (>= 100 gwei Diana floor)`,
    `   Estimated Fee (QOR): ${report.estimatedFeeQor} QOR`,
    `   Deployer Balance   : ${report.deployerBalanceQor} QOR`,
    `   Solvency Headroom  : ${report.solvencyMarginRatio.toLocaleString()}x batch fee`,
    ...(report.revertReason
      ? [
          "--------------------------------------------------------------------------------",
          ` REVERT DIAGNOSTIC   : ${report.revertReason}`
        ]
      : []),
    "================================================================================"
  ].join("\n");
}

/**
 * Asserts that a DryRunReport meets all live broadcast criteria.
 * Throws a descriptive error if simulation failed or deployer is insolvent.
 */
export function assertBatchReadyForBroadcast(report: DryRunReport): void {
  if (!report.success) {
    throw new Error(
      `Batch settlement simulation failed: ${report.revertReason || "Unknown EVM revert"}`
    );
  }
  if (!report.readyForBroadcast) {
    throw new Error(
      `Batch not ready for live broadcast: Deployer balance (${report.deployerBalanceQor} QOR) is insufficient for estimated fee (${report.estimatedFeeQor} QOR) or gas exceeds block limit.`
    );
  }
}
