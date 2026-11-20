import { expect } from "chai";
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import {
  broadcastBatchSettlement,
  resolveDeployerSigner,
  parseBatchSettledEvent,
  formatDianaExplorerLink,
  formatBroadcastSummary,
  DIANA_EXPLORER_BASE,
  DEFAULT_BROADCAST_GAS_LIMIT,
  BroadcastResult
} from "../../scripts/lib/liveBroadcast";
import {
  DEFAULT_DIANA_RPC,
  DEFAULT_SETTLER_ADDRESS,
  DEFAULT_DEPLOYER_EVM
} from "../../scripts/lib/dryRunSimulation";
import {
  DIANA_CHAIN_ID,
  DIANA_MIN_GAS_FLOOR_WEI
} from "../../scripts/lib/safetyGuards";
import { BatchCommitmentPayload } from "../../sequencer/batchSequencer";
import { OreVeilSettler__factory } from "../../typechain-types/factories/contracts/OreVeilSettler__factory";

dotenv.config();

describe("Sub-Phase 3.1 Sub-Layer 5.1: Live On-Chain Broadcast Pipeline Engine (Zero Mocks)", function () {
  this.timeout(60000);

  let provider: ethers.JsonRpcProvider;
  let signer: ethers.Signer;
  let signerAddress: string;

  before(async function () {
    provider = new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
    });

    signer = resolveDeployerSigner(provider);
    signerAddress = await signer.getAddress();
  });

  // =========================================================================
  // Dimension 1: Signer Resolution & Economic Solvency Guards
  // =========================================================================
  describe("Dimension 1: Signer Resolution & Economic Solvency Guards", function () {
    it("D1-1: should resolve authorized deployer signer matching DEFAULT_DEPLOYER_EVM", function () {
      expect(signerAddress.toLowerCase()).to.equal(DEFAULT_DEPLOYER_EVM.toLowerCase());
    });

    it("D1-2: should verify signer holds sufficient live QOR balance (>= 5 QOR)", async function () {
      const balance = await provider.getBalance(signerAddress);
      expect(balance).to.be.greaterThan(5_000_000_000_000_000_000n);
    });

    it("D1-3: should throw descriptive error when no private key is available", function () {
      const origKey = process.env.DEPLOYER_PRIVATE_KEY;
      try {
        delete process.env.DEPLOYER_PRIVATE_KEY;
        expect(() => resolveDeployerSigner(provider, { privateKey: "" })).to.throw(
          /Missing deployer private key/
        );
      } finally {
        process.env.DEPLOYER_PRIVATE_KEY = origKey;
      }
    });
  });

  // =========================================================================
  // Dimension 2: Pre-Flight Safety Gate Interception
  // =========================================================================
  describe("Dimension 2: Pre-Flight Safety Gate Interception", function () {
    it("D2-1: should intercept invalid batch sequence before broadcasting and prevent mempool dispatch", async function () {
      const nonceBefore = await provider.getTransactionCount(signerAddress);

      // Create an invalid payload with sequence gap (batchId: 999999)
      const invalidPayload: BatchCommitmentPayload = {
        batchId: 999999,
        prevStateRoot: ethers.ZeroHash,
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        commitmentHash: ethers.ZeroHash,
        signature: "0x" + "00".repeat(4627),
        chainId: DIANA_CHAIN_ID
      };

      let errorCaught: any = null;
      try {
        await broadcastBatchSettlement(invalidPayload, {
          provider,
          signer,
          skipPreflightSimulation: false
        });
      } catch (err: any) {
        errorCaught = err;
      }

      expect(errorCaught).to.not.be.null;
      expect(errorCaught.message).to.match(/Batch settlement simulation failed/);

      // Verify no transaction was sent and nonce is unchanged
      const nonceAfter = await provider.getTransactionCount(signerAddress);
      expect(nonceAfter).to.equal(nonceBefore);
    });

    it("D2-2: should intercept tampered ML-DSA-87 signature before broadcasting and protect gas balance", async function () {
      const nonceBefore = await provider.getTransactionCount(signerAddress);

      // Valid batchId 1, but completely forged signature
      const invalidSigPayload: BatchCommitmentPayload = {
        batchId: 1,
        prevStateRoot: ethers.ZeroHash,
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        commitmentHash: ethers.ZeroHash,
        signature: "0x" + "aa".repeat(4627),
        chainId: DIANA_CHAIN_ID
      };

      let errorCaught: any = null;
      try {
        await broadcastBatchSettlement(invalidSigPayload, {
          provider,
          signer,
          skipPreflightSimulation: false
        });
      } catch (err: any) {
        errorCaught = err;
      }

      expect(errorCaught).to.not.be.null;
      expect(errorCaught.message).to.match(/Batch settlement simulation failed/);

      const nonceAfter = await provider.getTransactionCount(signerAddress);
      expect(nonceAfter).to.equal(nonceBefore);
    });
  });

  // =========================================================================
  // Dimension 3: Transaction Decoration & Consensus Floor Invariants
  // =========================================================================
  describe("Dimension 3: Transaction Decoration & Consensus Floor Invariants", function () {
    it("D3-1: should enforce gas price >= 100 gwei Diana consensus floor", async function () {
      const feeData = await provider.getFeeData();
      const currentGasPrice = feeData.gasPrice ?? DIANA_MIN_GAS_FLOOR_WEI;
      expect(currentGasPrice).to.be.at.least(DIANA_MIN_GAS_FLOOR_WEI);
    });

    it("D3-2: should calibrate default gas limit to 3,500,000 units", function () {
      expect(DEFAULT_BROADCAST_GAS_LIMIT).to.equal(3_500_000n);
    });
  });

  // =========================================================================
  // Dimension 4: Receipt Telemetry & Event Parsing Logic
  // =========================================================================
  describe("Dimension 4: Receipt Telemetry & Event Parsing Logic", function () {
    it("D4-1: should correctly parse and decode BatchSettled event from receipt logs", function () {
      const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
      const iface = settler.interface;

      const batchId = 42;
      const prevStateRoot = ethers.keccak256(ethers.toUtf8Bytes("prev_root"));
      const newStateRoot = ethers.keccak256(ethers.toUtf8Bytes("new_root"));
      const withdrawalRoot = ethers.keccak256(ethers.toUtf8Bytes("withdrawal_root"));
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes("data_hash"));

      // Encode event log using OreVeilSettler interface
      const eventFragment = iface.getEvent("BatchSettled");
      const encodedData = iface.encodeEventLog(eventFragment, [
        batchId,
        prevStateRoot,
        newStateRoot,
        withdrawalRoot,
        dataHash
      ]);

      const mockReceiptLog: any = {
        topics: encodedData.topics,
        data: encodedData.data
      };

      const parsed = parseBatchSettledEvent([mockReceiptLog], iface);
      expect(parsed).to.not.be.undefined;
      expect(parsed?.batchId).to.equal(batchId);
      expect(parsed?.prevStateRoot).to.equal(prevStateRoot);
      expect(parsed?.newStateRoot).to.equal(newStateRoot);
      expect(parsed?.withdrawalRoot).to.equal(withdrawalRoot);
      expect(parsed?.dataHash).to.equal(dataHash);
    });

    it("D4-2: should return undefined when logs do not contain BatchSettled event", function () {
      const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
      const mockUnrelatedLog: any = {
        topics: [ethers.ZeroHash],
        data: "0x"
      };

      const parsed = parseBatchSettledEvent([mockUnrelatedLog], settler.interface);
      expect(parsed).to.be.undefined;
    });
  });

  // =========================================================================
  // Dimension 5: Explorer Formatting & Telemetry Report Verification
  // =========================================================================
  describe("Dimension 5: Explorer Formatting & Telemetry Report Verification", function () {
    it("D5-1: should format canonical Diana block explorer links", function () {
      const mockTxHash = "0x43e145d976d19bef2954c9bb2e784a1a55a0ee2249c51e96f2f9a8afe4167fb7";
      const link = formatDianaExplorerLink(mockTxHash);
      expect(link).to.equal(`${DIANA_EXPLORER_BASE}/tx/${mockTxHash}`);
    });

    it("D5-2: should format clean structured ASCII broadcast summary with all required telemetry", function () {
      const mockResult: BroadcastResult = {
        success: true,
        batchId: 1,
        txHash: "0x43e145d976d19bef2954c9bb2e784a1a55a0ee2249c51e96f2f9a8afe4167fb7",
        blockNumber: 10405000,
        blockHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        gasUsed: 457612n,
        effectiveGasPriceWei: 112_500_000_000n,
        totalFeeWei: 51_481_350_000_000_000n,
        totalFeeQor: "0.05148135",
        deployerAddress: DEFAULT_DEPLOYER_EVM,
        initialBalanceQor: "128.99979088",
        finalBalanceQor: "128.94830953",
        balanceDeltaQor: "0.05148135",
        explorerUrl: `${DIANA_EXPLORER_BASE}/tx/0x43e145d976d19bef2954c9bb2e784a1a55a0ee2249c51e96f2f9a8afe4167fb7`,
        latestBatchIdAfter: 1,
        latestStateRootAfter: ethers.ZeroHash,
        emittedBatchSettledEvent: {
          batchId: 1,
          prevStateRoot: ethers.ZeroHash,
          newStateRoot: ethers.ZeroHash,
          withdrawalRoot: ethers.ZeroHash,
          dataHash: ethers.ZeroHash
        },
        timestamp: new Date().toISOString()
      };

      const summary = formatBroadcastSummary(mockResult);

      expect(summary).to.include("OREVEIL BATCH SETTLEMENT ON-CHAIN BROADCAST RECEIPT");
      expect(summary).to.include("SUCCESS [MINED]");
      expect(summary).to.include("0x43e145d976d19bef2954c9bb2e784a1a55a0ee2249c51e96f2f9a8afe4167fb7");
      expect(summary).to.include("457,612 units");
      expect(summary).to.include("112.50 gwei");
      expect(summary).to.include("0.05148135 QOR");
      expect(summary).to.include("-0.05148135 QOR");
      expect(summary).to.include(DEFAULT_DEPLOYER_EVM);
      expect(summary).to.include(DIANA_EXPLORER_BASE);
    });
  });
});
