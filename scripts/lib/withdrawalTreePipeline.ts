import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import {
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SIGNATURE_LENGTH,
  pqVerify
} from "@qorechain/qoresign";
import {
  DIANA_CHAIN_ID,
  DIANA_MIN_GAS_FLOOR_WEI,
  estimateCompliantGasPrice
} from "./safetyGuards";
import {
  DEFAULT_DIANA_RPC,
  DEFAULT_SETTLER_ADDRESS,
  DEFAULT_DEPLOYER_EVM
} from "./dryRunSimulation";
import {
  BatchSequencer,
  SequencerKeypair
} from "../../sequencer/batchSequencer";
import { OreVeilSettler__factory } from "../../typechain-types/factories/contracts/OreVeilSettler__factory";

dotenv.config();

export interface WithdrawalEntry {
  withdrawalIndex: number;
  recipient: string;
  asset: string;
  amount: bigint;
  leafHash?: string;
  proof?: string[];
}

export interface WithdrawalTreeResult {
  root: string;
  leaves: string[];
  entries: WithdrawalEntry[];
}

export interface Batch2Commitment {
  batchId: number;
  prevStateRoot: string;
  newStateRoot: string;
  withdrawalRoot: string;
  dataHash: string;
  commitmentHash: string;
  signature: string;
  chainId: number;
  withdrawalEntries: WithdrawalEntry[];
}

export interface Batch2SimulationReport {
  success: boolean;
  batchId: number;
  prevStateRoot: string;
  newStateRoot: string;
  withdrawalRoot: string;
  simulatedGas: bigint;
  effectiveGasPriceWei: bigint;
  estimatedFeeQor: string;
  settlerAddress: string;
  timestamp: string;
  error?: string;
}

/**
 * Computes the domain-separated Merkle leaf for an on-chain withdrawal.
 * Strictly matches OreVeilSettler.sol line 206:
 * keccak256(abi.encodePacked(block.chainid, withdrawalIndex, recipient, asset, amount))
 */
export function computeWithdrawalLeaf(
  chainId: number,
  withdrawalIndex: number,
  recipient: string,
  asset: string,
  amount: bigint
): string {
  const normalizedAsset =
    !asset || asset === ethers.ZeroAddress || asset === ""
      ? ethers.ZeroAddress
      : ethers.getAddress(asset);

  return ethers.solidityPackedKeccak256(
    ["uint256", "uint256", "address", "address", "uint256"],
    [BigInt(chainId), BigInt(withdrawalIndex), ethers.getAddress(recipient), normalizedAsset, amount]
  );
}

/**
 * Commutative pair hashing matching OpenZeppelin MerkleProof.sol:
 * _hashPair(a, b) = a < b ? efficientHash(a, b) : efficientHash(b, a)
 */
export function hashPair(a: string, b: string): string {
  const aBig = BigInt(a);
  const bBig = BigInt(b);
  return aBig < bBig
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

/**
 * Cryptographic Binary Merkle Tree for L1 Rollup Withdrawals
 * Guaranteed 100% compatible with OpenZeppelin MerkleProof.verify.
 */
export class WithdrawalTree {
  public chainId: number;
  public entries: WithdrawalEntry[];
  public leaves: string[];
  public layers: string[][];

  constructor(entries: WithdrawalEntry[], chainId: number = DIANA_CHAIN_ID) {
    this.chainId = chainId;
    this.entries = entries.map((e) => ({ ...e }));
    this.leaves = [];
    this.layers = [];

    this.buildTree();
  }

  private buildTree(): void {
    if (this.entries.length === 0) {
      this.leaves = [];
      this.layers = [[ethers.ZeroHash]];
      return;
    }

    // Compute leaves
    this.leaves = this.entries.map((entry) => {
      const leaf = computeWithdrawalLeaf(
        this.chainId,
        entry.withdrawalIndex,
        entry.recipient,
        entry.asset,
        entry.amount
      );
      entry.leafHash = leaf;
      return leaf;
    });

    // Build layers
    this.layers = [this.leaves];
    while (this.layers[this.layers.length - 1].length > 1) {
      const current = this.layers[this.layers.length - 1];
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          next.push(hashPair(current[i], current[i + 1]));
        } else {
          next.push(current[i]);
        }
      }
      this.layers.push(next);
    }

    // Attach proofs to entries
    for (let i = 0; i < this.entries.length; i++) {
      this.entries[i].proof = this.getProof(i);
    }
  }

  public getRoot(): string {
    if (this.leaves.length === 0) return ethers.ZeroHash;
    return this.layers[this.layers.length - 1][0];
  }

  public getProof(index: number): string[] {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`Index ${index} out of bounds for tree with ${this.leaves.length} leaves`);
    }

    const proof: string[] = [];
    let idx = index;
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx]);
      }
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  public verifyProof(leaf: string, proof: string[]): boolean {
    const root = this.getRoot();
    let computed = leaf.startsWith("0x") ? leaf : `0x${leaf}`;
    for (const sibling of proof) {
      computed = hashPair(computed, sibling);
    }
    return computed.toLowerCase() === root.toLowerCase();
  }

  public getEntriesWithProofs(): WithdrawalEntry[] {
    return this.entries;
  }
}

/**
 * Loads the authentic ML-DSA-87 sequencer keypair.
 */
export function loadSequencerKeypair(): SequencerKeypair {
  const keyPath = path.join(process.cwd(), "deployments", "sequencer-key.json");
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Sequencer keyfile missing at ${keyPath}`);
  }
  const rawKey = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  const publicKeyBytes = ethers.getBytes(rawKey.publicKey);
  const secretKeyBytes = ethers.getBytes(rawKey.secretKey);

  if (publicKeyBytes.length !== ML_DSA_87_PUBLIC_KEY_LENGTH) {
    throw new Error(`Invalid sequencer pubkey length: ${publicKeyBytes.length}`);
  }

  return {
    publicKey: publicKeyBytes,
    secretKey: secretKeyBytes
  };
}

/**
 * Synchronizes with Diana Testnet and constructs Batch #2 carrying an active withdrawal root.
 */
export async function prepareBatch2Payload(options?: {
  provider?: ethers.Provider;
  settlerAddress?: string;
  withdrawals?: WithdrawalEntry[];
  customSequencerKey?: SequencerKeypair;
}): Promise<Batch2Commitment> {
  const provider =
    options?.provider ||
    new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
    });

  const settlerAddress = options?.settlerAddress || DEFAULT_SETTLER_ADDRESS;
  const settler = OreVeilSettler__factory.connect(settlerAddress, provider);

  // 1. Read live on-chain state
  const onChainLatestBatchId = Number(await settler.latestBatchId());
  const onChainLatestStateRoot = await settler.latestStateRoot();

  const targetBatchId = onChainLatestBatchId + 1;
  const prevStateRoot = onChainLatestStateRoot;

  // 2. Prepare withdrawal entries
  const defaultWithdrawals: WithdrawalEntry[] = [
    {
      withdrawalIndex: 0,
      recipient: DEFAULT_DEPLOYER_EVM,
      asset: ethers.ZeroAddress,
      amount: ethers.parseEther("1.0") // 1.0 QOR
    }
  ];

  const withdrawals = options?.withdrawals && options.withdrawals.length > 0
    ? options.withdrawals
    : defaultWithdrawals;

  // 3. Build Merkle Withdrawal Tree
  const tree = new WithdrawalTree(withdrawals, DIANA_CHAIN_ID);
  const withdrawalRoot = tree.getRoot();

  // 4. Compute state transition (Batch #2 state root)
  const newStateRoot = ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "bytes32", "uint256"],
      [prevStateRoot, withdrawalRoot, BigInt(targetBatchId)]
    )
  );

  // 5. Compute DA hash for Batch #2
  const dataHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify({
        batchId: targetBatchId,
        withdrawalsCount: withdrawals.length,
        withdrawalRoot
      })
    )
  );

  // 6. Compute commitment hash
  const commitmentHash = BatchSequencer.computeCommitmentHash(
    DIANA_CHAIN_ID,
    targetBatchId,
    prevStateRoot,
    newStateRoot,
    withdrawalRoot,
    dataHash
  );

  // 7. Sign commitment with NIST FIPS 204 (ML-DSA-87)
  const keypair = options?.customSequencerKey || loadSequencerKeypair();
  const sequencer = new BatchSequencer(keypair, settlerAddress, DIANA_CHAIN_ID);
  const signature = sequencer.signCommitment(commitmentHash);

  // Validate local signature parity
  const validLocal = sequencer.verifySignatureLocally(commitmentHash, signature);

  if (!validLocal) {
    throw new Error("Batch #2 ML-DSA-87 signature failed local pqVerify validation");
  }

  return {
    batchId: targetBatchId,
    prevStateRoot,
    newStateRoot,
    withdrawalRoot,
    dataHash,
    commitmentHash,
    signature,
    chainId: DIANA_CHAIN_ID,
    withdrawalEntries: tree.getEntriesWithProofs()
  };
}

/**
 * Simulates settlement of Batch #2 on Diana Testnet via non-destructive EVM staticcall.
 */
export async function simulateBatch2Settlement(
  commitment: Batch2Commitment,
  options?: {
    provider?: ethers.Provider;
    settlerAddress?: string;
  }
): Promise<Batch2SimulationReport> {
  const provider =
    options?.provider ||
    new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
    });

  const settlerAddress = options?.settlerAddress || DEFAULT_SETTLER_ADDRESS;
  const settler = OreVeilSettler__factory.connect(settlerAddress, provider);

  const gasConfig = await estimateCompliantGasPrice(provider);

  try {
    await settler.settleBatch.staticCall(
      commitment.batchId,
      commitment.prevStateRoot,
      commitment.newStateRoot,
      commitment.withdrawalRoot,
      commitment.dataHash,
      commitment.signature,
      {
        from: DEFAULT_DEPLOYER_EVM
      }
    );

    let simulatedGas = 450_000n;
    try {
      simulatedGas = await settler.settleBatch.estimateGas(
        commitment.batchId,
        commitment.prevStateRoot,
        commitment.newStateRoot,
        commitment.withdrawalRoot,
        commitment.dataHash,
        commitment.signature,
        {
          from: DEFAULT_DEPLOYER_EVM
        }
      );
    } catch {
      // Use fallback precompile gas estimate
    }

    const estimatedFeeWei = simulatedGas * gasConfig.effectiveGasPriceWei;

    return {
      success: true,
      batchId: commitment.batchId,
      prevStateRoot: commitment.prevStateRoot,
      newStateRoot: commitment.newStateRoot,
      withdrawalRoot: commitment.withdrawalRoot,
      simulatedGas,
      effectiveGasPriceWei: gasConfig.effectiveGasPriceWei,
      estimatedFeeQor: ethers.formatEther(estimatedFeeWei),
      settlerAddress,
      timestamp: new Date().toISOString()
    };
  } catch (err: any) {
    return {
      success: false,
      batchId: commitment.batchId,
      prevStateRoot: commitment.prevStateRoot,
      newStateRoot: commitment.newStateRoot,
      withdrawalRoot: commitment.withdrawalRoot,
      simulatedGas: 0n,
      effectiveGasPriceWei: gasConfig.effectiveGasPriceWei,
      estimatedFeeQor: "0.0",
      settlerAddress,
      timestamp: new Date().toISOString(),
      error: err?.message || String(err)
    };
  }
}

export function formatBatch2SimulationReport(report: Batch2SimulationReport): string {
  const lines = [
    "================================================================================",
    "       OREVEIL BATCH #2 WITH ACTIVE MERKLE WITHDRAWAL ROOT REHEARSAL            ",
    "================================================================================",
    ` Status              : ${report.success ? "PASS [SIMULATED]" : "FAILED [REVERTED]"}`,
    ` Timestamp           : ${report.timestamp}`,
    ` Settler Vault       : ${report.settlerAddress}`,
    "--------------------------------------------------------------------------------",
    " BATCH #2 COMMITMENT INVARIANTS:",
    `   Target Batch ID   : ${report.batchId}`,
    `   Prev State Root   : ${report.prevStateRoot}`,
    `   New State Root    : ${report.newStateRoot}`,
    `   Withdrawal Root   : ${report.withdrawalRoot}`,
    "--------------------------------------------------------------------------------",
    " GAS CONSUMPTION & ECONOMIC SOLVENCY:",
    `   Simulated Gas     : ${report.simulatedGas.toLocaleString()} units`,
    `   Effective GasPrice: ${(Number(report.effectiveGasPriceWei) / 1e9).toFixed(2)} gwei (>= 100 gwei floor)`,
    `   Estimated Fee     : ${report.estimatedFeeQor} QOR`,
    "================================================================================"
  ];
  if (report.error) {
    lines.push(` REVERT REASON       : ${report.error}`);
    lines.push("================================================================================");
  }
  return lines.join("\n");
}
