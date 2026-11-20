import { expect } from "chai";
import { ethers } from "hardhat";
import {
  OffchainRollupPipeline,
  TraderIdentity,
  OffchainBatchConfig
} from "../../scripts/lib/offchainPipeline";
import { OrderParams, generateKemKeypair } from "../../client/orderClient";
import { BatchSequencer } from "../../sequencer/batchSequencer";
import {
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SIGNATURE_LENGTH
} from "@qorechain/qoresign";
import { ML_KEM_1024_PUBLIC_KEY_SIZE } from "@qorechain/sdk";

describe("Sub-Phase 3.1 Layer 2: Off-Chain Cryptographic Pipeline & Reversible State Validation", function () {
  this.timeout(30000);

  let pipeline: OffchainRollupPipeline;
  let alice: TraderIdentity;
  let bob: TraderIdentity;
  let carol: TraderIdentity;

  const NATIVE_QOR = ethers.ZeroAddress;
  const FUSD_TOKEN = "0x97143DCE481434C686e5c83E6D012dACfEc263CA";
  const CHAIN_ID = 9800;

  beforeEach(function () {
    // Instantiate pipeline with keys from deployments/
    pipeline = new OffchainRollupPipeline({ chainId: CHAIN_ID });

    // Setup deterministic traders with initial balances:
    // Alice: holds 10,000 fUSD (Quote token) to buy QOR
    // Bob: holds 500 QOR (Base token) to sell for fUSD
    // Carol: holds 5,000 fUSD and 200 QOR for liquidity
    alice = OffchainRollupPipeline.createDeterministicTrader("alice", [
      { asset: FUSD_TOKEN, amount: ethers.parseEther("10000") }
    ]);
    bob = OffchainRollupPipeline.createDeterministicTrader("bob", [
      { asset: NATIVE_QOR, amount: 500_000_000n } // 500 QOR (6 decimals)
    ]);
    carol = OffchainRollupPipeline.createDeterministicTrader("carol", [
      { asset: FUSD_TOKEN, amount: ethers.parseEther("5000") },
      { asset: NATIVE_QOR, amount: 200_000_000n } // 200 QOR (6 decimals)
    ]);

    pipeline.initializeLedger([alice, bob, carol]);
  });

  describe("Layer 1: Deterministic Identities & Confidential Order Sealing", function () {
    it("should generate deterministic checksummed EVM addresses for traders", function () {
      expect(ethers.isAddress(alice.address)).to.be.true;
      expect(ethers.isAddress(bob.address)).to.be.true;
      expect(ethers.isAddress(carol.address)).to.be.true;

      expect(alice.address).to.not.equal(bob.address);
      expect(bob.address).to.not.equal(carol.address);

      // Verify deterministic derivation repeatability
      const aliceRecomputed = OffchainRollupPipeline.createDeterministicTrader("alice");
      expect(aliceRecomputed.address).to.equal(alice.address);
    });

    it("should seal client orders into NIST FIPS 203 (ML-KEM-1024) envelopes with distinct IVs", async function () {
      const orders: OrderParams[] = [
        {
          trader: alice.address,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_TOKEN,
          side: "BUY",
          amount: 100_000_000n, // 100 QOR
          limitPrice: ethers.parseEther("2.0"), // $2.00 per QOR
          nonce: 1,
          expiryBlock: 10500000
        },
        {
          trader: bob.address,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_TOKEN,
          side: "SELL",
          amount: 100_000_000n, // 100 QOR
          limitPrice: ethers.parseEther("2.0"), // $2.00 per QOR
          nonce: 1,
          expiryBlock: 10500000
        }
      ];

      const envelopes = await pipeline.sealOrders(orders, 1);
      expect(envelopes).to.have.lengthOf(2);

      for (const env of envelopes) {
        expect(env.chainId).to.equal(CHAIN_ID);
        expect(env.epochId).to.equal(1);

        // KEM ciphertext length: 1,568 bytes -> 3,136 hex characters + 2 ("0x")
        const kemBytes = Buffer.from(env.kemCiphertext.replace("0x", ""), "hex");
        expect(kemBytes.length).to.equal(ML_KEM_1024_PUBLIC_KEY_SIZE);

        // AES-256-GCM IV length: 12 bytes -> 24 hex characters
        const ivBytes = Buffer.from(env.iv.replace("0x", ""), "hex");
        expect(ivBytes.length).to.equal(12);

        // AES-256-GCM authTag length: 16 bytes -> 32 hex characters
        const tagBytes = Buffer.from(env.authTag.replace("0x", ""), "hex");
        expect(tagBytes.length).to.equal(16);
      }

      // Assert zero IV reuse between distinct order envelopes
      expect(envelopes[0].iv).to.not.equal(envelopes[1].iv);
    });

    it("should instantiate pipeline cleanly using in-memory derived keypairs", function () {
      const dsaKey = BatchSequencer.generateKeypair();
      const kemKey = generateKemKeypair();
      const customPipeline = new OffchainRollupPipeline({
        dsaKeypair: dsaKey,
        kemKeypair: kemKey,
        chainId: 9800
      });

      expect(customPipeline.dsaKeypair.publicKey.length).to.equal(ML_DSA_87_PUBLIC_KEY_LENGTH);
      expect(customPipeline.kemKeypair.publicKey.length).to.equal(ML_KEM_1024_PUBLIC_KEY_SIZE);
      expect(customPipeline.chainId).to.equal(9800);
    });
  });

  describe("Layer 2: Decapsulation & FBA Clearing Parity with Zero Wei Leakage", function () {
    it("should decapsulate sealed envelopes with 100% field fidelity", async function () {
      const originalOrder: OrderParams = {
        trader: alice.address,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_TOKEN,
        side: "BUY",
        amount: 50_000_000n,
        limitPrice: ethers.parseEther("2.5"),
        nonce: 42,
        expiryBlock: 10600000
      };

      const [envelope] = await pipeline.sealOrders([originalOrder], 1);
      const [decapsulated] = await pipeline.decapsulateOrders([envelope]);

      expect(decapsulated.trader.toLowerCase()).to.equal(originalOrder.trader.toLowerCase());
      expect(decapsulated.baseToken.toLowerCase()).to.equal(originalOrder.baseToken.toLowerCase());
      expect(decapsulated.quoteToken.toLowerCase()).to.equal(originalOrder.quoteToken.toLowerCase());
      expect(decapsulated.side).to.equal(originalOrder.side);
      expect(decapsulated.amount).to.equal(originalOrder.amount);
      expect(decapsulated.limitPrice).to.equal(originalOrder.limitPrice);
      expect(decapsulated.nonce).to.equal(originalOrder.nonce);
      expect(decapsulated.expiryBlock).to.equal(originalOrder.expiryBlock);
    });

    it("should clear orders at uniform price P* and conserve tokens to the exact wei", async function () {
      // Alice buys 100 QOR at up to $2.20
      // Carol buys 50 QOR at up to $2.00
      // Bob sells 150 QOR at minimum $1.80
      const orders: OrderParams[] = [
        {
          trader: alice.address,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_TOKEN,
          side: "BUY",
          amount: 100_000_000n,
          limitPrice: ethers.parseEther("2.2"),
          nonce: 1,
          expiryBlock: 10500000
        },
        {
          trader: carol.address,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_TOKEN,
          side: "BUY",
          amount: 50_000_000n,
          limitPrice: ethers.parseEther("2.0"),
          nonce: 1,
          expiryBlock: 10500000
        },
        {
          trader: bob.address,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_TOKEN,
          side: "SELL",
          amount: 150_000_000n,
          limitPrice: ethers.parseEther("1.8"),
          nonce: 1,
          expiryBlock: 10500000
        }
      ];

      const config: OffchainBatchConfig = {
        batchId: 1,
        epochId: 1,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_TOKEN,
        orders
      };

      const result = await pipeline.processBatch(config);

      // Verify uniform clearing price execution
      expect(result.executionResult.clearingPrice).to.be.greaterThan(0n);
      expect(result.executionResult.totalVolume).to.equal(150_000_000n); // 150 QOR matched

      // Total base token conservation check: sum of debits === sum of credits
      let totalBaseCredited = 0n;
      let totalQuoteCredited = 0n;
      let totalBaseDebited = 0n;
      let totalQuoteDebited = 0n;

      for (const fill of result.executionResult.fills) {
        if (fill.side === "BUY") {
          totalBaseCredited += fill.baseAmountFilled;
          totalQuoteDebited += fill.quoteAmountFilled;
        } else {
          totalBaseDebited += fill.baseAmountFilled;
          totalQuoteCredited += fill.quoteAmountFilled;
        }
      }

      expect(totalBaseCredited).to.equal(totalBaseDebited);
      expect(totalQuoteCredited).to.equal(totalQuoteDebited);
    });
  });

  describe("Layer 3: Cryptographic State Continuity & Merkle Roots", function () {
    it("should advance state root monotonically and record valid Merkle transition", async function () {
      const stateRootBefore = pipeline.getStateRoot();
      expect(stateRootBefore).to.not.equal(ethers.ZeroHash);

      const config: OffchainBatchConfig = {
        batchId: 1,
        epochId: 1,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_TOKEN,
        orders: [
          {
            trader: alice.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "BUY",
            amount: 50_000_000n,
            limitPrice: ethers.parseEther("2.0"),
            nonce: 1,
            expiryBlock: 10500000
          },
          {
            trader: bob.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "SELL",
            amount: 50_000_000n,
            limitPrice: ethers.parseEther("2.0"),
            nonce: 1,
            expiryBlock: 10500000
          }
        ]
      };

      const result = await pipeline.processBatch(config);

      expect(result.executionResult.prevStateRoot).to.equal(stateRootBefore);
      expect(result.executionResult.newStateRoot).to.not.equal(stateRootBefore);
      expect(pipeline.getStateRoot()).to.equal(result.executionResult.newStateRoot);
    });

    it("should compute valid withdrawal root when withdrawal claims are present", async function () {
      const config: OffchainBatchConfig = {
        batchId: 1,
        epochId: 1,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_TOKEN,
        orders: [],
        withdrawals: [
          {
            index: 0,
            recipient: bob.address,
            asset: NATIVE_QOR,
            amount: 10_000_000n // 10 QOR withdrawal
          }
        ]
      };

      const result = await pipeline.processBatch(config);
      expect(result.executionResult.withdrawalRoot).to.not.equal(ethers.ZeroHash);
      expect(result.commitmentPayload.withdrawalRoot).to.equal(result.executionResult.withdrawalRoot);
    });

    it("should maintain sequential state root continuity across multiple consecutive batches", async function () {
      // Batch 1: Alice buys 20 QOR from Bob
      const batch1Config: OffchainBatchConfig = {
        batchId: 1,
        epochId: 1,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_TOKEN,
        orders: [
          {
            trader: alice.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "BUY",
            amount: 20_000_000n,
            limitPrice: ethers.parseEther("2.0"),
            nonce: 1,
            expiryBlock: 10500000
          },
          {
            trader: bob.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "SELL",
            amount: 20_000_000n,
            limitPrice: ethers.parseEther("2.0"),
            nonce: 1,
            expiryBlock: 10500000
          }
        ]
      };
      const result1 = await pipeline.processBatch(batch1Config);

      // Batch 2: Carol buys 10 QOR from Bob, taking Batch 1 newStateRoot as prevStateRoot
      const batch2Config: OffchainBatchConfig = {
        batchId: 2,
        epochId: 2,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_TOKEN,
        orders: [
          {
            trader: carol.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "BUY",
            amount: 10_000_000n,
            limitPrice: ethers.parseEther("2.0"),
            nonce: 1,
            expiryBlock: 10500000
          },
          {
            trader: bob.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "SELL",
            amount: 10_000_000n,
            limitPrice: ethers.parseEther("2.0"),
            nonce: 2,
            expiryBlock: 10500000
          }
        ]
      };
      const result2 = await pipeline.processBatch(batch2Config);

      expect(result2.executionResult.prevStateRoot).to.equal(result1.executionResult.newStateRoot);
      expect(result2.executionResult.newStateRoot).to.not.equal(result1.executionResult.newStateRoot);
      expect(result2.commitmentPayload.batchId).to.equal(2);
      expect(result2.verifiedLocally).to.be.true;
    });
  });

  describe("Layer 4: NIST FIPS 204 (ML-DSA-87) Batch Signing", function () {
    it("should sign batch commitment producing an authentic 4,627-byte signature", async function () {
      const config: OffchainBatchConfig = {
        batchId: 1,
        epochId: 1,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_TOKEN,
        orders: [
          {
            trader: alice.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "BUY",
            amount: 25_000_000n,
            limitPrice: ethers.parseEther("2.0"),
            nonce: 1,
            expiryBlock: 10500000
          },
          {
            trader: bob.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "SELL",
            amount: 25_000_000n,
            limitPrice: ethers.parseEther("2.0"),
            nonce: 1,
            expiryBlock: 10500000
          }
        ]
      };

      const result = await pipeline.processBatch(config);

      expect(result.verifiedLocally).to.be.true;
      const sigBytes = Buffer.from(result.commitmentPayload.signature.replace("0x", ""), "hex");
      expect(sigBytes.length).to.equal(ML_DSA_87_SIGNATURE_LENGTH);

      // Verify that the payload contains all required L1 fields
      expect(result.commitmentPayload.batchId).to.equal(1);
      expect(result.commitmentPayload.chainId).to.equal(CHAIN_ID);
      expect(result.commitmentPayload.commitmentHash).to.be.a("string");
      expect(result.commitmentPayload.commitmentHash).to.have.lengthOf(66);
    });

    it("should reject tampered commitment hash during local signature verification", async function () {
      const config: OffchainBatchConfig = {
        batchId: 1,
        epochId: 1,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_TOKEN,
        orders: []
      };

      const result = await pipeline.processBatch(config);
      const tamperedHash = ethers.keccak256(ethers.toUtf8Bytes("tampered-hash-payload"));

      const isValid = pipeline.sequencer.verifySignatureLocally(
        tamperedHash,
        result.commitmentPayload.signature
      );
      expect(isValid).to.be.false;
    });
  });

  describe("Layer 5: Atomic Checkpointing & State Reversibility", function () {
    it("should preserve pre-batch state unchanged when dryRun is enabled", async function () {
      const stateRootBefore = pipeline.getStateRoot();
      const aliceBalanceBefore = pipeline.ledger.getBalance(alice.address, FUSD_TOKEN);
      const bobBalanceBefore = pipeline.ledger.getBalance(bob.address, NATIVE_QOR);

      const config: OffchainBatchConfig = {
        batchId: 1,
        epochId: 1,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_TOKEN,
        orders: [
          {
            trader: alice.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "BUY",
            amount: 50_000_000n,
            limitPrice: ethers.parseEther("2.0"),
            nonce: 1,
            expiryBlock: 10500000
          },
          {
            trader: bob.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "SELL",
            amount: 50_000_000n,
            limitPrice: ethers.parseEther("2.0"),
            nonce: 1,
            expiryBlock: 10500000
          }
        ],
        dryRun: true // DRY RUN FLAG ACTIVE
      };

      const result = await pipeline.processBatch(config);

      // Verify that full execution outputs were generated
      expect(result.executionResult.totalVolume).to.equal(50_000_000n);
      expect(result.verifiedLocally).to.be.true;

      // Verify that ledger state was completely reverted to before
      expect(pipeline.getStateRoot()).to.equal(stateRootBefore);
      expect(pipeline.ledger.getBalance(alice.address, FUSD_TOKEN)).to.equal(aliceBalanceBefore);
      expect(pipeline.ledger.getBalance(bob.address, NATIVE_QOR)).to.equal(bobBalanceBefore);
    });

    it("should atomically roll back ledger state when execution encounters an error", async function () {
      const stateRootBefore = pipeline.getStateRoot();
      const aliceBalanceBefore = pipeline.ledger.getBalance(alice.address, FUSD_TOKEN);

      // Alice tries to buy more than her balance permits (1,000,000 QOR requires $2,000,000 fUSD, she only has $10,000)
      const config: OffchainBatchConfig = {
        batchId: 1,
        epochId: 1,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_TOKEN,
        orders: [
          {
            trader: alice.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "BUY",
            amount: 1_000_000_000_000n, // Excessive amount
            limitPrice: ethers.parseEther("2.0"),
            nonce: 1,
            expiryBlock: 10500000
          },
          {
            trader: bob.address,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_TOKEN,
            side: "SELL",
            amount: 1_000_000_000_000n,
            limitPrice: ethers.parseEther("2.0"),
            nonce: 1,
            expiryBlock: 10500000
          }
        ]
      };

      let errorThrown = false;
      try {
        await pipeline.processBatch(config);
      } catch (err: any) {
        errorThrown = true;
        expect(err.message).to.include("Insufficient balance");
      }

      expect(errorThrown).to.be.true;
      // Assert that state was completely restored to before the batch attempt
      expect(pipeline.getStateRoot()).to.equal(stateRootBefore);
      expect(pipeline.ledger.getBalance(alice.address, FUSD_TOKEN)).to.equal(aliceBalanceBefore);
    });
  });
});
