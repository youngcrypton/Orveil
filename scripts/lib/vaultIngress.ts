import { ethers } from "ethers";
import * as dotenv from "dotenv";
import {
  DIANA_CHAIN_ID,
  DIANA_MIN_GAS_FLOOR_WEI,
  DEFAULT_HEADROOM_PERCENT,
  estimateCompliantGasPrice
} from "./safetyGuards";
import {
  DEFAULT_DIANA_RPC,
  DEFAULT_SETTLER_ADDRESS,
  DEFAULT_DEPLOYER_EVM
} from "./dryRunSimulation";
import { resolveDeployerSigner } from "./liveBroadcast";
import { OreVeilSettler__factory } from "../../typechain-types/factories/contracts/OreVeilSettler__factory";

dotenv.config();

export const DEFAULT_DEPOSIT_GAS_LIMIT = 350_000n;
export const DIANA_EXPLORER_BASE = "https://explore.qore.network";

export interface DepositOptions {
  provider?: ethers.Provider;
  signer?: ethers.Signer;
  privateKey?: string;
  settlerAddress?: string;
  gasHeadroomPercent?: number;
  confirmations?: number;
  customGasLimit?: bigint;
  customGasFloorWei?: bigint;
}

export interface DepositSimulationReport {
  success: boolean;
  depositor: string;
  asset: string;
  amount: bigint;
  amountFormatted: string;
  simulatedGas: bigint;
  effectiveGasPriceWei: bigint;
  estimatedFeeQor: string;
  settlerAddress: string;
  timestamp: string;
  error?: string;
}

export interface DepositResult {
  status: "SUCCESS" | "FAILED";
  txHash: string;
  blockNumber: number;
  blockHash: string;
  depositor: string;
  asset: string;
  amount: bigint;
  amountFormatted: string;
  gasUsed: bigint;
  effectiveGasPriceWei: bigint;
  feeBurnedQor: string;
  contractBalanceBefore: bigint;
  contractBalanceAfter: bigint;
  userDepositsBefore: bigint;
  userDepositsAfter: bigint;
  explorerUrl: string;
  timestamp: string;
  eventVerified: boolean;
  error?: string;
}

export function formatDianaExplorerLink(txHash: string): string {
  const cleanHash = txHash.startsWith("0x") ? txHash : `0x${txHash}`;
  return `${DIANA_EXPLORER_BASE}/tx/${cleanHash}`;
}

export function isNativeAsset(asset: string): boolean {
  return (
    !asset ||
    asset === ethers.ZeroAddress ||
    asset.toLowerCase() === "0x0000000000000000000000000000000000000000"
  );
}

/**
 * Parses the on-chain Deposited event from transaction receipt logs.
 */
export function parseDepositEvent(
  receipt: ethers.TransactionReceipt,
  settlerAddress: string = DEFAULT_SETTLER_ADDRESS
): { depositor: string; asset: string; amount: bigint } | null {
  const settlerInterface = OreVeilSettler__factory.createInterface();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== settlerAddress.toLowerCase()) continue;
    try {
      const parsed = settlerInterface.parseLog({
        topics: [...log.topics],
        data: log.data
      });
      if (parsed && parsed.name === "Deposited") {
        return {
          depositor: parsed.args[0] as string,
          asset: parsed.args[1] as string,
          amount: BigInt(parsed.args[2])
        };
      }
    } catch {
      // Continue to next log if decoding fails for non-matching event
    }
  }
  return null;
}

/**
 * Simulates a deposit into OreVeilSettler via non-destructive EVM staticcall.
 */
export async function simulateDeposit(
  asset: string,
  amount: bigint,
  options?: DepositOptions
): Promise<DepositSimulationReport> {
  const provider =
    options?.provider ||
    new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
    });

  const settlerAddress = options?.settlerAddress || DEFAULT_SETTLER_ADDRESS;
  const settler = OreVeilSettler__factory.connect(settlerAddress, provider);

  const native = isNativeAsset(asset);
  const targetAsset = native ? ethers.ZeroAddress : asset;

  // Resolve depositor address (from signer or default deployer)
  let depositor = DEFAULT_DEPLOYER_EVM;
  try {
    const signer = options?.signer || resolveDeployerSigner(provider, options);
    depositor = await signer.getAddress();
  } catch {
    // Fall back to DEFAULT_DEPLOYER_EVM for read-only simulations
  }

  const gasConfig = await estimateCompliantGasPrice(provider, {
    headroomPercent: options?.gasHeadroomPercent,
    customFloorWei: options?.customGasFloorWei
  });

  try {
    let simulatedGas: bigint;
    if (native) {
      await settler.depositNative.staticCall({
        value: amount,
        from: depositor
      });
      try {
        simulatedGas = await settler.depositNative.estimateGas({
          value: amount,
          from: depositor
        });
      } catch {
        simulatedGas = options?.customGasLimit || DEFAULT_DEPOSIT_GAS_LIMIT;
      }
    } else {
      await settler.depositERC20.staticCall(targetAsset, amount, {
        from: depositor
      });
      try {
        simulatedGas = await settler.depositERC20.estimateGas(targetAsset, amount, {
          from: depositor
        });
      } catch {
        simulatedGas = options?.customGasLimit || DEFAULT_DEPOSIT_GAS_LIMIT;
      }
    }

    const estimatedFeeWei = simulatedGas * gasConfig.effectiveGasPriceWei;
    const estimatedFeeQor = ethers.formatEther(estimatedFeeWei);

    return {
      success: true,
      depositor,
      asset: targetAsset,
      amount,
      amountFormatted: native ? `${ethers.formatEther(amount)} QOR` : amount.toString(),
      simulatedGas,
      effectiveGasPriceWei: gasConfig.effectiveGasPriceWei,
      estimatedFeeQor,
      settlerAddress,
      timestamp: new Date().toISOString()
    };
  } catch (err: any) {
    return {
      success: false,
      depositor,
      asset: targetAsset,
      amount,
      amountFormatted: native ? `${ethers.formatEther(amount)} QOR` : amount.toString(),
      simulatedGas: 0n,
      effectiveGasPriceWei: gasConfig.effectiveGasPriceWei,
      estimatedFeeQor: "0.0",
      settlerAddress,
      timestamp: new Date().toISOString(),
      error: err?.message || String(err)
    };
  }
}

/**
 * Executes a live deposit into OreVeilSettler on QoreChain Diana Testnet.
 */
export async function executeDeposit(
  asset: string,
  amount: bigint,
  options?: DepositOptions
): Promise<DepositResult> {
  const provider =
    options?.provider ||
    new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
    });

  const settlerAddress = options?.settlerAddress || DEFAULT_SETTLER_ADDRESS;
  const signer = options?.signer || resolveDeployerSigner(provider, options);
  const depositor = await signer.getAddress();

  const native = isNativeAsset(asset);
  const targetAsset = native ? ethers.ZeroAddress : asset;

  const settlerReadOnly = OreVeilSettler__factory.connect(settlerAddress, provider);
  const settlerConnected = OreVeilSettler__factory.connect(settlerAddress, signer);

  // 1. Pre-deposit state audit
  const contractBalanceBefore = await provider.getBalance(settlerAddress);
  const userDepositsBefore = await settlerReadOnly.deposits(depositor, targetAsset);

  // 2. Gas pricing & decoration
  const gasConfig = await estimateCompliantGasPrice(provider, {
    headroomPercent: options?.gasHeadroomPercent,
    customFloorWei: options?.customGasFloorWei
  });
  const gasLimit = options?.customGasLimit || DEFAULT_DEPOSIT_GAS_LIMIT;

  // 3. Dispatch transaction
  let txResponse: ethers.TransactionResponse;
  if (native) {
    txResponse = await settlerConnected.depositNative({
      value: amount,
      gasPrice: gasConfig.effectiveGasPriceWei,
      gasLimit,
      chainId: DIANA_CHAIN_ID
    });
  } else {
    txResponse = await settlerConnected.depositERC20(targetAsset, amount, {
      gasPrice: gasConfig.effectiveGasPriceWei,
      gasLimit,
      chainId: DIANA_CHAIN_ID
    });
  }

  // 4. Await consensus mining
  const confirmations = options?.confirmations ?? 1;
  const receipt = await txResponse.wait(confirmations);
  if (!receipt) {
    throw new Error(`Transaction ${txResponse.hash} failed: receipt is null`);
  }

  // 5. Post-deposit state audit
  const contractBalanceAfter = await provider.getBalance(settlerAddress);
  const userDepositsAfter = await settlerReadOnly.deposits(depositor, targetAsset);

  // 6. Fee telemetry
  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = receipt.gasPrice ?? gasConfig.effectiveGasPriceWei;
  const feeBurnedWei = gasUsed * effectiveGasPrice;
  const feeBurnedQor = ethers.formatEther(feeBurnedWei);

  // 7. Event verification
  const parsedEvent = parseDepositEvent(receipt, settlerAddress);
  const eventVerified =
    parsedEvent !== null &&
    parsedEvent.depositor.toLowerCase() === depositor.toLowerCase() &&
    parsedEvent.asset.toLowerCase() === targetAsset.toLowerCase() &&
    parsedEvent.amount === amount;

  return {
    status: receipt.status === 1 ? "SUCCESS" : "FAILED",
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    depositor,
    asset: targetAsset,
    amount,
    amountFormatted: native ? `${ethers.formatEther(amount)} QOR` : amount.toString(),
    gasUsed,
    effectiveGasPriceWei: effectiveGasPrice,
    feeBurnedQor,
    contractBalanceBefore,
    contractBalanceAfter,
    userDepositsBefore,
    userDepositsAfter,
    explorerUrl: formatDianaExplorerLink(receipt.hash),
    timestamp: new Date().toISOString(),
    eventVerified
  };
}

export function formatDepositSimulationReport(report: DepositSimulationReport): string {
  const lines = [
    "================================================================================",
    "             OREVEIL MULTI-ASSET VAULT INGRESS DRY-RUN REHEARSAL                ",
    "================================================================================",
    ` Status              : ${report.success ? "PASS [SIMULATED]" : "FAILED [REVERTED]"}`,
    ` Timestamp           : ${report.timestamp}`,
    ` Target Settler      : ${report.settlerAddress}`,
    "--------------------------------------------------------------------------------",
    " DEPOSIT PARAMETERS:",
    `   Depositor         : ${report.depositor}`,
    `   Asset Identifier  : ${report.asset}`,
    `   Deposit Amount    : ${report.amountFormatted}`,
    "--------------------------------------------------------------------------------",
    " GAS CONSUMPTION & ECONOMIC ESTIMATION:",
    `   Simulated Gas     : ${report.simulatedGas.toLocaleString()} units`,
    `   Effective GasPrice: ${(Number(report.effectiveGasPriceWei) / 1e9).toFixed(2)} gwei (>= 100 gwei floor)`,
    `   Estimated Fee     : ${report.estimatedFeeQor} QOR`,
    "================================================================================"
  ];
  if (report.error) {
    lines.push(` ERROR REASON        : ${report.error}`);
    lines.push("================================================================================");
  }
  return lines.join("\n");
}

export function formatDepositSummary(result: DepositResult): string {
  const balanceGrowth = result.contractBalanceAfter - result.contractBalanceBefore;
  const userGrowth = result.userDepositsAfter - result.userDepositsBefore;

  return [
    "================================================================================",
    "             OREVEIL MULTI-ASSET VAULT INGRESS BROADCAST RECEIPT                ",
    "================================================================================",
    ` Status              : ${result.status} [MINED]`,
    ` Timestamp           : ${result.timestamp}`,
    "--------------------------------------------------------------------------------",
    " DIANA TESTNET RECEIPT TELEMETRY:",
    `   Transaction Hash  : ${result.txHash}`,
    `   Block Number      : ${result.blockNumber.toLocaleString()}`,
    `   Block Hash        : ${result.blockHash}`,
    `   Explorer URL      : ${result.explorerUrl}`,
    "--------------------------------------------------------------------------------",
    " DEPOSIT PARAMS & STATE GROWTH AUDIT:",
    `   Depositor         : ${result.depositor}`,
    `   Asset             : ${result.asset}`,
    `   Amount Deposited  : ${result.amountFormatted}`,
    `   Contract Bal Delta: +${ethers.formatEther(balanceGrowth)} QOR`,
    `   User Ledger Delta : +${ethers.formatEther(userGrowth)} QOR`,
    `   Event Verified    : ${result.eventVerified ? "YES (Deposited Event Mined)" : "NO"}`,
    "--------------------------------------------------------------------------------",
    " GAS CONSUMPTION & ECONOMIC DEDUCTION:",
    `   Gas Consumed      : ${result.gasUsed.toLocaleString()} units`,
    `   Effective GasPrice: ${(Number(result.effectiveGasPriceWei) / 1e9).toFixed(2)} gwei`,
    `   Fee Burned        : ${result.feeBurnedQor} QOR`,
    "================================================================================"
  ].join("\n");
}
