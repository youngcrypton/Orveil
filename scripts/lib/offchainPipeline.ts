import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  OrderParams,
  SealedOrderEnvelope,
  KemKeypair,
  sealOrder,
  unsealOrder
} from "../../client/orderClient";
import {
  AccountLedger,
  executeBatchFBA,
  BatchExecutionResult,
  WithdrawalClaim
} from "../../sequencer/matchingEngine";
import {
  BatchSequencer,
  BatchCommitmentPayload,
  SequencerKeypair,
  DIANA_CHAIN_ID
} from "../../sequencer/batchSequencer";
import {
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SECRET_KEY_LENGTH
} from "@qorechain/qoresign";
import { ML_KEM_1024_PUBLIC_KEY_SIZE } from "@qorechain/sdk";
import {
  ML_KEM_1024_SECRET_KEY_SIZE
} from "../../client/orderClient";

export interface TraderIdentity {
  name: string;
  address: string;
  initialBalances: Map<string, bigint>;
}

export interface OffchainBatchConfig {
  batchId: number;
  epochId: number;
  chainId?: number;
  baseToken: string;
  quoteToken: string;
  orders: OrderParams[];
  withdrawals?: WithdrawalClaim[];
  dryRun?: boolean;
}

export interface OffchainBatchResult {
  config: OffchainBatchConfig;
  sealedEnvelopes: SealedOrderEnvelope[];
  executionResult: BatchExecutionResult;
  commitmentPayload: BatchCommitmentPayload;
  stateCheckpoint: string;
  verifiedLocally: boolean;
}

export interface OffchainPipelineOptions {
  sequencerDsaKeyPath?: string;
  sequencerKemKeyPath?: string;
  chainId?: number;
  settlerAddress?: string;
  dsaKeypair?: SequencerKeypair;
  kemKeypair?: KemKeypair;
  initialLedger?: AccountLedger;
}

export const DEFAULT_SETTLER_ADDRESS = "0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44";

/**
 * OffchainRollupPipeline
 * 
 * Production off-chain execution and state engine for OreVeil rollup:
 * 1. Manages deterministic trader setup and account ledger.
 * 2. Seals client orders into confidential envelopes (NIST FIPS 203 ML-KEM-1024 + AES-256-GCM).
 * 3. Decapsulates envelopes and clears orders via Frequent Batch Auction (FBA) at uniform price P*.
 * 4. Ensures strict zero-wei token conservation across all assets.
 * 5. Transitions binary Merkle state roots and Sparse Merkle withdrawal roots.
 * 6. Generates authentic NIST FIPS 204 (ML-DSA-87 / Dilithium-5) batch commitment signatures (4,627B).
 * 7. Supports state checkpointing and atomic rollback protection against execution anomalies.
 */
export class OffchainRollupPipeline {
  public chainId: number;
  public settlerAddress: string;
  public dsaKeypair: SequencerKeypair;
  public kemKeypair: KemKeypair;
  public sequencer: BatchSequencer;
  public ledger: AccountLedger;

  constructor(options?: OffchainPipelineOptions) {
    this.chainId = options?.chainId ?? DIANA_CHAIN_ID;
    this.settlerAddress = options?.settlerAddress || DEFAULT_SETTLER_ADDRESS;

    // 1. Initialize ML-DSA-87 Sequencer Keypair
    if (options?.dsaKeypair) {
      this.dsaKeypair = options.dsaKeypair;
    } else {
      const dsaPath =
        options?.sequencerDsaKeyPath ||
        path.join(process.cwd(), "deployments", "sequencer-key.json");
      if (!fs.existsSync(dsaPath)) {
        throw new Error(`Sequencer ML-DSA-87 keyfile not found at ${dsaPath}`);
      }
      const raw = JSON.parse(fs.readFileSync(dsaPath, "utf8"));
      const pubKey = Buffer.from(raw.publicKey.replace("0x", ""), "hex");
      const secKey = Buffer.from(raw.secretKey.replace("0x", ""), "hex");
      if (pubKey.length !== ML_DSA_87_PUBLIC_KEY_LENGTH) {
        throw new Error(`Invalid DSA public key length: ${pubKey.length}`);
      }
      if (secKey.length !== ML_DSA_87_SECRET_KEY_LENGTH) {
        throw new Error(`Invalid DSA secret key length: ${secKey.length}`);
      }
      this.dsaKeypair = { publicKey: pubKey, secretKey: secKey };
    }

    // 2. Initialize ML-KEM-1024 Sequencer Keypair
    if (options?.kemKeypair) {
      this.kemKeypair = options.kemKeypair;
    } else {
      const kemPath =
        options?.sequencerKemKeyPath ||
        path.join(process.cwd(), "deployments", "sequencer-kem-key.json");
      if (!fs.existsSync(kemPath)) {
        throw new Error(`Sequencer ML-KEM-1024 keyfile not found at ${kemPath}`);
      }
      const raw = JSON.parse(fs.readFileSync(kemPath, "utf8"));
      const pubKey = Buffer.from(raw.publicKey.replace("0x", ""), "hex");
      const secKey = Buffer.from(raw.secretKey.replace("0x", ""), "hex");
      if (pubKey.length !== ML_KEM_1024_PUBLIC_KEY_SIZE) {
        throw new Error(`Invalid KEM public key length: ${pubKey.length}`);
      }
      if (secKey.length !== ML_KEM_1024_SECRET_KEY_SIZE) {
        throw new Error(`Invalid KEM secret key length: ${secKey.length}`);
      }
      this.kemKeypair = { publicKey: pubKey, secretKey: secKey };
    }

    // 3. Initialize Batch Sequencer
    this.sequencer = new BatchSequencer(this.dsaKeypair, this.settlerAddress, this.chainId);

    // 4. Initialize Account Ledger
    this.ledger = options?.initialLedger ?? new AccountLedger();
  }

  /**
   * Generates a deterministic trader identity with checksummed EVM address.
   */
  public static createDeterministicTrader(
    name: string,
    initialBalances?: Array<{ asset: string; amount: bigint }>
  ): TraderIdentity {
    const seed = ethers.keccak256(ethers.toUtf8Bytes("oreveil-deterministic-trader-" + name));
    const wallet = new ethers.Wallet(seed);
    const balanceMap = new Map<string, bigint>();
    if (initialBalances) {
      for (const item of initialBalances) {
        balanceMap.set(item.asset.toLowerCase(), item.amount);
      }
    }
    return {
      name,
      address: wallet.address,
      initialBalances: balanceMap
    };
  }

  /**
   * Initializes the ledger by crediting deterministic trader accounts.
   */
  public initializeLedger(traders: TraderIdentity[]): AccountLedger {
    for (const trader of traders) {
      for (const [asset, amount] of trader.initialBalances.entries()) {
        if (amount > 0n) {
          this.ledger.credit(trader.address, asset, amount);
        }
      }
    }
    return this.ledger;
  }

  /**
   * Captures an atomic snapshot of current ledger balances.
   */
  public createCheckpoint(): string {
    const accounts = this.ledger.getAllAccounts();
    return JSON.stringify(
      accounts.map((a) => ({
        trader: a.trader,
        asset: a.asset,
        balance: a.balance.toString()
      }))
    );
  }

  /**
   * Restores ledger balances from a serialized snapshot.
   */
  public restoreCheckpoint(snapshot: string): void {
    const parsed = JSON.parse(snapshot) as Array<{
      trader: string;
      asset: string;
      balance: string;
    }>;
    const newLedger = new AccountLedger();
    for (const item of parsed) {
      const amt = BigInt(item.balance);
      if (amt > 0n) {
        newLedger.credit(item.trader, item.asset, amt);
      }
    }
    this.ledger = newLedger;
  }

  /**
   * Seals a set of client orders using NIST FIPS 203 (ML-KEM-1024) and AES-256-GCM.
   */
  public async sealOrders(
    orders: OrderParams[],
    epochId: number
  ): Promise<SealedOrderEnvelope[]> {
    const envelopes: SealedOrderEnvelope[] = [];
    for (const order of orders) {
      const env = await sealOrder(order, this.kemKeypair.publicKey, epochId, this.chainId);
      envelopes.push(env);
    }
    return envelopes;
  }

  /**
   * Decapsulates sealed envelopes using the sequencer's ML-KEM-1024 secret key.
   */
  public async decapsulateOrders(
    envelopes: SealedOrderEnvelope[]
  ): Promise<OrderParams[]> {
    const orders: OrderParams[] = [];
    for (const env of envelopes) {
      const order = await unsealOrder(env, this.kemKeypair.secretKey);
      orders.push(order);
    }
    return orders;
  }

  /**
   * Executes the complete off-chain rollup pipeline for a batch:
   * 1. Takes an atomic ledger checkpoint.
   * 2. Encrypts orders into sealed envelopes (client-side simulation).
   * 3. Decapsulates envelopes using sequencer KEM secret key.
   * 4. Executes FBA clearing at uniform price P* and checks zero wei leakage.
   * 5. Transitions binary Merkle state roots and Sparse Merkle withdrawal roots.
   * 6. Signs batch commitment with ML-DSA-87 (4,627 bytes).
   * 7. Validates signature locally via pqVerify.
   * 8. Reverts ledger state if dryRun is true or an anomaly occurs.
   */
  public async processBatch(config: OffchainBatchConfig): Promise<OffchainBatchResult> {
    const checkpoint = this.createCheckpoint();
    const effectiveChainId = config.chainId ?? this.chainId;

    try {
      // 1. Seal client orders
      const sealedEnvelopes = await this.sealOrders(config.orders, config.epochId);

      // 2. Decapsulate orders via sequencer KEM secret key
      const decapsulatedOrders = await this.decapsulateOrders(sealedEnvelopes);

      // 3. Execute FBA Clearing & State Transition
      const executionResult = executeBatchFBA(
        config.batchId,
        config.epochId,
        decapsulatedOrders,
        this.ledger,
        config.withdrawals ?? [],
        effectiveChainId
      );

      // 4. Assemble and sign batch commitment with ML-DSA-87
      const commitmentPayload = this.sequencer.prepareAndSignBatch(
        executionResult,
        config.batchId
      );

      // 5. Verify signature locally
      const verifiedLocally = this.sequencer.verifySignatureLocally(
        commitmentPayload.commitmentHash,
        commitmentPayload.signature
      );
      if (!verifiedLocally) {
        throw new Error("Local ML-DSA-87 signature verification failed for commitment payload");
      }

      // 6. Handle dryRun revert
      if (config.dryRun) {
        this.restoreCheckpoint(checkpoint);
      }

      return {
        config,
        sealedEnvelopes,
        executionResult,
        commitmentPayload,
        stateCheckpoint: checkpoint,
        verifiedLocally
      };
    } catch (err) {
      // Revert state atomically on failure
      this.restoreCheckpoint(checkpoint);
      throw err;
    }
  }

  public getLedger(): AccountLedger {
    return this.ledger;
  }

  public getStateRoot(): string {
    return this.ledger.computeStateRoot();
  }
}
