import { ethers } from "ethers";
import * as crypto from "crypto";
import {
  pqKeyFromSeed,
  pqSign,
  pqVerify,
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SECRET_KEY_LENGTH,
  ML_DSA_87_SIGNATURE_LENGTH
} from "@qorechain/qoresign";
import { BatchExecutionResult } from "./matchingEngine";
import { OreVeilSettler } from "../typechain-types";

export const DIANA_CHAIN_ID = 9800;
export const DIANA_MIN_GAS_FLOOR = 100_000_000_000n; // 0.1 uqor (10^11 wei)

export interface BatchCommitmentPayload {
  batchId: number;
  prevStateRoot: string;
  newStateRoot: string;
  withdrawalRoot: string;
  dataHash: string;
  commitmentHash: string;
  signature: string; // 0x prefixed hex (4627 bytes -> 9254 hex chars + 2)
  chainId: number;
}

export interface SequencerKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * BatchSequencer
 * 
 * Production sequencer coordinator that:
 * 1. Synchronizes state with OreVeilSettler on L1.
 * 2. Assembles domain-separated commitment digests over FBA batch execution results.
 * 3. Signs commitments using NIST FIPS 204 (ML-DSA-87 / Dilithium-5) private keys (4,627 bytes).
 * 4. Simulates settlement via EVM staticcall and broadcasts settleBatch() transactions.
 */
export class BatchSequencer {
  public keypair: SequencerKeypair;
  public settlerAddress: string;
  public chainId: number;

  constructor(
    keypair: SequencerKeypair,
    settlerAddress: string,
    chainId = DIANA_CHAIN_ID
  ) {
    if (keypair.publicKey.length !== ML_DSA_87_PUBLIC_KEY_LENGTH) {
      throw new Error(
        `Invalid ML-DSA-87 public key length: expected ${ML_DSA_87_PUBLIC_KEY_LENGTH}, got ${keypair.publicKey.length}`
      );
    }
    if (keypair.secretKey.length !== ML_DSA_87_SECRET_KEY_LENGTH) {
      throw new Error(
        `Invalid ML-DSA-87 secret key length: expected ${ML_DSA_87_SECRET_KEY_LENGTH}, got ${keypair.secretKey.length}`
      );
    }
    this.keypair = keypair;
    this.settlerAddress = settlerAddress;
    this.chainId = chainId;
  }

  /**
   * Derive an ML-DSA-87 keypair deterministically or randomly.
   */
  public static generateKeypair(seed?: Uint8Array): SequencerKeypair {
    const rawSeed = seed ?? crypto.randomBytes(32);
    if (rawSeed.length !== 32) {
      throw new Error("ML-DSA-87 seed must be exactly 32 bytes");
    }
    const derived = pqKeyFromSeed(rawSeed);
    return {
      publicKey: derived.publicKey,
      secretKey: derived.secretKey
    };
  }

  /**
   * Compute the domain-separated batch commitment digest.
   * Matches OreVeilSettler.sol line 147:
   * keccak256(abi.encodePacked(block.chainid, batchId, prevStateRoot, newStateRoot, withdrawalRoot, dataHash))
   */
  public static computeCommitmentHash(
    chainId: number,
    batchId: number,
    prevStateRoot: string,
    newStateRoot: string,
    withdrawalRoot: string,
    dataHash: string
  ): string {
    const prev = prevStateRoot.startsWith("0x") ? prevStateRoot : "0x" + prevStateRoot;
    const next = newStateRoot.startsWith("0x") ? newStateRoot : "0x" + newStateRoot;
    const withRoot = withdrawalRoot.startsWith("0x") ? withdrawalRoot : "0x" + withdrawalRoot;
    const dHash = dataHash.startsWith("0x") ? dataHash : "0x" + dataHash;

    return ethers.solidityPackedKeccak256(
      ["uint256", "uint256", "bytes32", "bytes32", "bytes32", "bytes32"],
      [BigInt(chainId), BigInt(batchId), prev, next, withRoot, dHash]
    );
  }

  public getPublicKey(): Uint8Array {
    return this.keypair.publicKey;
  }

  public getPublicKeyHex(): string {
    return "0x" + Buffer.from(this.keypair.publicKey).toString("hex");
  }

  /**
   * Synchronize current state from the deployed OreVeilSettler contract.
   */
  public async syncState(
    settler: OreVeilSettler
  ): Promise<{ latestBatchId: bigint; latestStateRoot: string }> {
    const [latestBatchId, latestStateRoot] = await Promise.all([
      settler.latestBatchId(),
      settler.latestStateRoot()
    ]);
    return { latestBatchId, latestStateRoot };
  }

  /**
   * Locally sign a 32-byte commitment hash using ML-DSA-87.
   * Produces an exact 4,627-byte signature.
   */
  public signCommitment(commitmentHash: string): string {
    const hashBytes = ethers.getBytes(commitmentHash);
    const signatureBytes = pqSign(this.keypair.secretKey, hashBytes);
    if (signatureBytes.length !== ML_DSA_87_SIGNATURE_LENGTH) {
      throw new Error(
        `Invalid signature output length: expected ${ML_DSA_87_SIGNATURE_LENGTH}, got ${signatureBytes.length}`
      );
    }
    return "0x" + Buffer.from(signatureBytes).toString("hex");
  }

  /**
   * Locally verify an ML-DSA-87 signature over a commitment hash.
   */
  public verifySignatureLocally(
    commitmentHash: string,
    signatureHex: string,
    publicKey?: Uint8Array
  ): boolean {
    const pubKey = publicKey ?? this.keypair.publicKey;
    const hashBytes = ethers.getBytes(commitmentHash);
    const sigBytes = ethers.getBytes(signatureHex);
    return pqVerify(pubKey, hashBytes, sigBytes);
  }

  /**
   * Prepare, validate, and sign a batch execution result into a commitment payload.
   * Performs local signature verification before returning.
   */
  public prepareAndSignBatch(
    result: BatchExecutionResult,
    expectedBatchId?: number,
    expectedPrevStateRoot?: string
  ): BatchCommitmentPayload {
    if (expectedBatchId !== undefined && result.batchId !== expectedBatchId) {
      throw new Error(
        `Batch sequence mismatch: expected batchId ${expectedBatchId}, got ${result.batchId}`
      );
    }
    if (
      expectedPrevStateRoot !== undefined &&
      result.prevStateRoot.toLowerCase() !== expectedPrevStateRoot.toLowerCase()
    ) {
      throw new Error(
        `State root mismatch: expected prevStateRoot ${expectedPrevStateRoot}, got ${result.prevStateRoot}`
      );
    }

    const commitmentHash = BatchSequencer.computeCommitmentHash(
      this.chainId,
      result.batchId,
      result.prevStateRoot,
      result.newStateRoot,
      result.withdrawalRoot,
      result.dataHash
    );

    const signature = this.signCommitment(commitmentHash);

    // Verify locally as defense-in-depth
    const isValidLocal = this.verifySignatureLocally(commitmentHash, signature);
    if (!isValidLocal) {
      throw new Error("Local post-quantum signature verification failed");
    }

    return {
      batchId: result.batchId,
      prevStateRoot: result.prevStateRoot,
      newStateRoot: result.newStateRoot,
      withdrawalRoot: result.withdrawalRoot,
      dataHash: result.dataHash,
      commitmentHash,
      signature,
      chainId: this.chainId
    };
  }

  /**
   * Pre-flight simulation of settleBatch via EVM staticcall.
   */
  public async simulateSettlement(
    settler: OreVeilSettler,
    payload: BatchCommitmentPayload
  ): Promise<boolean> {
    try {
      await settler.settleBatch.staticCall(
        BigInt(payload.batchId),
        payload.prevStateRoot,
        payload.newStateRoot,
        payload.withdrawalRoot,
        payload.dataHash,
        payload.signature
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Submit settleBatch transaction to OreVeilSettler on-chain.
   * Automatically enforces Diana Testnet gas price floor.
   */
  public async submitBatch(
    settler: OreVeilSettler,
    payload: BatchCommitmentPayload,
    overrides?: ethers.Overrides
  ): Promise<ethers.ContractTransactionReceipt> {
    const gasOverrides: ethers.Overrides = {};

    // Apply Diana minimum gas floor if on Diana network
    if (this.chainId === DIANA_CHAIN_ID) {
      gasOverrides.maxFeePerGas = DIANA_MIN_GAS_FLOOR;
      gasOverrides.maxPriorityFeePerGas = DIANA_MIN_GAS_FLOOR;
    }

    const tx = await settler.settleBatch(
      BigInt(payload.batchId),
      payload.prevStateRoot,
      payload.newStateRoot,
      payload.withdrawalRoot,
      payload.dataHash,
      payload.signature,
      {
        ...gasOverrides,
        ...overrides
      }
    );

    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error(`Transaction ${tx.hash} was not mined`);
    }
    return receipt;
  }
}
