import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SECRET_KEY_LENGTH,
  isDegeneratePqPublicKey
} from "@qorechain/qoresign";
import {
  ML_KEM_1024_PUBLIC_KEY_SIZE,
  validateKemPublicKey
} from "@qorechain/sdk";

export type PreflightStatus = "PASSED" | "FAILED";

export interface CheckResult {
  name: string;
  passed: boolean;
  details: string;
  metric?: string | number | bigint;
}

export interface PreflightReport {
  status: PreflightStatus;
  timestamp: string;
  chainId: number;
  blockNumber: number;
  deployerAddress: string;
  deployerBalanceQor: string;
  contractAddress: string;
  contractBytecodeLength: number;
  sequencerDsaKeyLength: number;
  sequencerKemKeyLength: number;
  checks: CheckResult[];
}

export interface PreflightOptions {
  rpcUrl?: string;
  chainId?: number;
  contractAddress?: string;
  deployerAddress?: string;
  minBalanceQor?: bigint;
  dsaKeyPath?: string;
  kemKeyPath?: string;
  provider?: ethers.Provider;
  minBlockNumber?: number;
  minGasFloor?: bigint;
}

export const DEFAULT_DIANA_RPC = "https://evm-testnet.qore.host";
export const DEFAULT_CHAIN_ID = 9800;
export const DEFAULT_SETTLER_ADDRESS = "0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44";
export const DEFAULT_DEPLOYER_ADDRESS = "0x7DE7d6CC73002f44A76334392555C9A4dDc0B561";
export const DEFAULT_MIN_BALANCE_QOR = 5_000_000_000_000_000_000n; // 5 QOR (5 * 10^18 wei)
export const DEFAULT_MIN_BLOCK_NUMBER = 10_390_000;
export const DEFAULT_MIN_GAS_FLOOR = 100_000_000_000n; // 0.1 uqor = 100 gwei = 10^11 wei

/**
 * Executes a comprehensive pre-flight environment and account solvency audit
 * against QoreChain Diana Testnet and local post-quantum cryptographic identity files.
 */
export async function runPreflightCheck(options?: PreflightOptions): Promise<PreflightReport> {
  const timestamp = new Date().toISOString();
  const expectedChainId = options?.chainId ?? DEFAULT_CHAIN_ID;
  const contractAddress = options?.contractAddress || DEFAULT_SETTLER_ADDRESS;
  const deployerAddress = options?.deployerAddress || DEFAULT_DEPLOYER_ADDRESS;
  const minBalance = options?.minBalanceQor ?? DEFAULT_MIN_BALANCE_QOR;
  const minBlock = options?.minBlockNumber ?? DEFAULT_MIN_BLOCK_NUMBER;
  const minGas = options?.minGasFloor ?? DEFAULT_MIN_GAS_FLOOR;

  const dsaKeyPath =
    options?.dsaKeyPath || path.join(process.cwd(), "deployments", "sequencer-key.json");
  const kemKeyPath =
    options?.kemKeyPath || path.join(process.cwd(), "deployments", "sequencer-kem-key.json");

  const provider =
    options?.provider ||
    new ethers.JsonRpcProvider(options?.rpcUrl || DEFAULT_DIANA_RPC);

  const checks: CheckResult[] = [];

  let detectedChainId = 0;
  let detectedBlockNumber = 0;
  let deployerBalanceQor = "0";
  let contractBytecodeLength = 0;
  let sequencerDsaKeyLength = 0;
  let sequencerKemKeyLength = 0;

  // 1. RPC Connection & Chain ID Check
  try {
    const network = await provider.getNetwork();
    detectedChainId = Number(network.chainId);
    const passed = detectedChainId === expectedChainId;
    checks.push({
      name: "RPC Connection & Chain ID",
      passed,
      details: passed
        ? `Connected to chainId ${detectedChainId} (expected ${expectedChainId})`
        : `Chain ID mismatch: detected ${detectedChainId}, expected ${expectedChainId}`,
      metric: detectedChainId
    });
  } catch (err: any) {
    checks.push({
      name: "RPC Connection & Chain ID",
      passed: false,
      details: `Failed to connect to RPC: ${err?.message || String(err)}`
    });
  }

  // 2. Block Liveness Check
  try {
    detectedBlockNumber = await provider.getBlockNumber();
    const passed = detectedBlockNumber >= minBlock;
    checks.push({
      name: "Block Liveness",
      passed,
      details: passed
        ? `Latest block height is ${detectedBlockNumber} (threshold >= ${minBlock})`
        : `Block height ${detectedBlockNumber} below threshold ${minBlock}`,
      metric: detectedBlockNumber
    });
  } catch (err: any) {
    checks.push({
      name: "Block Liveness",
      passed: false,
      details: `Failed to query block number: ${err?.message || String(err)}`
    });
  }

  // 3. Minimum Gas Price Floor Check
  try {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    const passed = gasPrice >= minGas;
    checks.push({
      name: "Gas Price Floor",
      passed,
      details: passed
        ? `Current gas price is ${ethers.formatUnits(gasPrice, "gwei")} gwei (${gasPrice.toString()} wei, floor >= ${ethers.formatUnits(minGas, "gwei")} gwei)`
        : `Gas price ${ethers.formatUnits(gasPrice, "gwei")} gwei below minimum floor of ${ethers.formatUnits(minGas, "gwei")} gwei`,
      metric: gasPrice
    });
  } catch (err: any) {
    checks.push({
      name: "Gas Price Floor",
      passed: false,
      details: `Failed to query fee data: ${err?.message || String(err)}`
    });
  }

  // 4. Sequencer ML-DSA-87 Key Inspection
  try {
    if (!fs.existsSync(dsaKeyPath)) {
      throw new Error(`ML-DSA-87 key file not found at ${dsaKeyPath}`);
    }
    const dsaJson = JSON.parse(fs.readFileSync(dsaKeyPath, "utf8"));
    if (!dsaJson.publicKey || !dsaJson.secretKey) {
      throw new Error("ML-DSA-87 key file missing publicKey or secretKey fields");
    }

    const pubKeyBytes = Buffer.from(dsaJson.publicKey.replace("0x", ""), "hex");
    const secKeyBytes = Buffer.from(dsaJson.secretKey.replace("0x", ""), "hex");
    sequencerDsaKeyLength = pubKeyBytes.length;

    const validPubKey = pubKeyBytes.length === ML_DSA_87_PUBLIC_KEY_LENGTH;
    const validSecKey = secKeyBytes.length === ML_DSA_87_SECRET_KEY_LENGTH;
    const notDegenerate = !isDegeneratePqPublicKey(pubKeyBytes);

    const passed = validPubKey && validSecKey && notDegenerate;
    checks.push({
      name: "Sequencer ML-DSA-87 Key Integrity",
      passed,
      details: passed
        ? `NIST FIPS 204 (ML-DSA-87) key integrity verified (pubKey: ${pubKeyBytes.length}B, secKey: ${secKeyBytes.length}B, non-degenerate)`
        : `ML-DSA-87 key dimensions invalid (pubKey: ${pubKeyBytes.length}B/${ML_DSA_87_PUBLIC_KEY_LENGTH}B, secKey: ${secKeyBytes.length}B/${ML_DSA_87_SECRET_KEY_LENGTH}B, degenerate: ${!notDegenerate})`,
      metric: pubKeyBytes.length
    });
  } catch (err: any) {
    checks.push({
      name: "Sequencer ML-DSA-87 Key Integrity",
      passed: false,
      details: `ML-DSA-87 key inspection failed: ${err?.message || String(err)}`
    });
  }

  // 5. Sequencer ML-KEM-1024 Key Inspection
  try {
    if (!fs.existsSync(kemKeyPath)) {
      throw new Error(`ML-KEM-1024 key file not found at ${kemKeyPath}`);
    }
    const kemJson = JSON.parse(fs.readFileSync(kemKeyPath, "utf8"));
    if (!kemJson.publicKey) {
      throw new Error("ML-KEM-1024 key file missing publicKey field");
    }

    const pubKeyBytes = Buffer.from(kemJson.publicKey.replace("0x", ""), "hex");
    sequencerKemKeyLength = pubKeyBytes.length;

    const validLength = pubKeyBytes.length === ML_KEM_1024_PUBLIC_KEY_SIZE;
    validateKemPublicKey(pubKeyBytes);

    const passed = validLength;
    checks.push({
      name: "Sequencer ML-KEM-1024 Key Integrity",
      passed,
      details: passed
        ? `NIST FIPS 203 (ML-KEM-1024) key integrity verified (pubKey: ${pubKeyBytes.length}B, standard validated)`
        : `ML-KEM-1024 public key length mismatch: got ${pubKeyBytes.length}B, expected ${ML_KEM_1024_PUBLIC_KEY_SIZE}B`,
      metric: pubKeyBytes.length
    });
  } catch (err: any) {
    checks.push({
      name: "Sequencer ML-KEM-1024 Key Integrity",
      passed: false,
      details: `ML-KEM-1024 key inspection failed: ${err?.message || String(err)}`
    });
  }

  // 6. Deployer Wallet Solvency Check
  try {
    const balanceWei = await provider.getBalance(deployerAddress);
    deployerBalanceQor = ethers.formatEther(balanceWei);
    const passed = balanceWei >= minBalance;
    checks.push({
      name: "Deployer Solvency",
      passed,
      details: passed
        ? `Deployer wallet ${deployerAddress} holds ${deployerBalanceQor} QOR (threshold >= ${ethers.formatEther(minBalance)} QOR)`
        : `Deployer wallet ${deployerAddress} balance ${deployerBalanceQor} QOR below solvency floor ${ethers.formatEther(minBalance)} QOR`,
      metric: deployerBalanceQor
    });
  } catch (err: any) {
    checks.push({
      name: "Deployer Solvency",
      passed: false,
      details: `Failed to query deployer balance for ${deployerAddress}: ${err?.message || String(err)}`
    });
  }

  // 7. Settler Contract Bytecode Verification
  try {
    const bytecode = await provider.getCode(contractAddress);
    contractBytecodeLength = bytecode.length;
    const hasBytecode = bytecode !== "0x" && bytecode.length > 100;
    checks.push({
      name: "Settler Contract Bytecode",
      passed: hasBytecode,
      details: hasBytecode
        ? `Deployed bytecode verified at ${contractAddress} (${bytecode.length} hex chars, ~${Math.floor((bytecode.length - 2) / 2)} bytes)`
        : `No deployed bytecode found at address ${contractAddress} (returned ${bytecode})`,
      metric: bytecode.length
    });
  } catch (err: any) {
    checks.push({
      name: "Settler Contract Bytecode",
      passed: false,
      details: `Failed to query bytecode for ${contractAddress}: ${err?.message || String(err)}`
    });
  }

  const allPassed = checks.every((c) => c.passed);

  return {
    status: allPassed ? "PASSED" : "FAILED",
    timestamp,
    chainId: detectedChainId,
    blockNumber: detectedBlockNumber,
    deployerAddress,
    deployerBalanceQor,
    contractAddress,
    contractBytecodeLength,
    sequencerDsaKeyLength,
    sequencerKemKeyLength,
    checks
  };
}

/**
 * Formats a PreflightReport into a clean, human-readable terminal table and summary.
 */
export function formatPreflightReport(report: PreflightReport): string {
  const divider = "================================================================================";
  const subDivider = "--------------------------------------------------------------------------------";

  const lines: string[] = [
    divider,
    "  OreVeil Pre-Flight Environment & Account Solvency Report",
    divider,
    `Status:     [${report.status}]`,
    `Timestamp:  ${report.timestamp}`,
    `Chain ID:   ${report.chainId}`,
    `Block:      ${report.blockNumber}`,
    "",
    `Deployer Address:    ${report.deployerAddress}`,
    `Deployer Balance:    ${report.deployerBalanceQor} QOR`,
    `Settler Contract:    ${report.contractAddress} (${report.contractBytecodeLength} hex chars)`,
    `Sequencer DSA Key:   ${report.sequencerDsaKeyLength} bytes (ML-DSA-87 / Dilithium-5)`,
    `Sequencer KEM Key:   ${report.sequencerKemKeyLength} bytes (ML-KEM-1024 / Kyber-1024)`,
    subDivider,
    "Checks Breakdown:"
  ];

  for (let i = 0; i < report.checks.length; i++) {
    const c = report.checks[i];
    const tag = c.passed ? "[PASS]" : "[FAIL]";
    lines.push(`  ${tag} ${i + 1}. ${c.name}`);
    lines.push(`         ${c.details}`);
  }

  lines.push(divider);
  return lines.join("\n");
}
