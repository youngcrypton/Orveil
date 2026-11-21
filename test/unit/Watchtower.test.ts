import { expect } from "chai";
import { ethers } from "ethers";
import {
  OreVeilWatchtower,
  DEFAULT_DIANA_RPC,
  DEFAULT_SETTLER_ADDRESS,
  DEFAULT_START_BLOCK,
  DEFAULT_DIANA_CHAIN_ID,
  ParsedBatchSettledEvent,
  FraudAlert,
  WatchtowerReport
} from "../../watchtower/watcher";

describe("Sub-Phase 4.1: Watchtower Replay Service & Verification Suite (Zero Mocks)", function () {
  this.timeout(60000);

  let watchtower: OreVeilWatchtower;
  let dianaProvider: ethers.JsonRpcProvider;

  const BATCH_1_STATE_ROOT = "0xee7f44e0fcdcf09951ea456e0d9f8b5276aec06384a82e2497675f3c40381e24";
  const BATCH_2_STATE_ROOT = "0xf376c36c3aa86fd06147ad291868cd35b28c338937f70fabc994aa0745c8608b";
  const BATCH_2_WITHDRAWAL_ROOT = "0xfd5acf917be2d0c2cb4cfecbb86fc9a630182549e25d4fd05590dfac074359d9";

  before(async function () {
    dianaProvider = new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DEFAULT_DIANA_CHAIN_ID)
    });

    watchtower = new OreVeilWatchtower({
      provider: dianaProvider,
      settlerAddress: DEFAULT_SETTLER_ADDRESS,
      startBlock: DEFAULT_START_BLOCK,
      chunkSize: 5000,
      chainId: DEFAULT_DIANA_CHAIN_ID
    });
  });

  // =========================================================================
  // Dimension 1: Diana L1 Connectivity & Batch Event Ingestion
  // =========================================================================
  describe("Dimension 1: Diana L1 Connectivity & Batch Event Ingestion", function () {
    it("D1-1: should connect to live Diana RPC and assert chain ID 9800 with active block height", async function () {
      const network = await watchtower.provider.getNetwork();
      expect(Number(network.chainId)).to.equal(DEFAULT_DIANA_CHAIN_ID);

      const blockNumber = await watchtower.provider.getBlockNumber();
      expect(blockNumber).to.be.greaterThan(10494000);
    });

    it("D1-2: should query live Diana Settler contract and sync on-chain BatchSettled events", async function () {
      const events = await watchtower.syncBatchEvents();
      expect(events.length).to.be.at.least(2);
      expect(watchtower.batches.size).to.be.at.least(2);
    });

    it("D1-3: should verify on-chain Batch #1 parameters match canonical records", async function () {
      const batch1 = watchtower.batches.get(1);
      expect(batch1).to.not.be.undefined;
      expect(batch1!.batchId).to.equal(1);
      expect(batch1!.prevStateRoot).to.equal(ethers.ZeroHash);
      expect(batch1!.newStateRoot.toLowerCase()).to.equal(BATCH_1_STATE_ROOT.toLowerCase());
      expect(batch1!.blockNumber).to.equal(10438858);
      expect(batch1!.transactionHash).to.match(/^0x[0-9a-fA-F]{64}$/);
    });

    it("D1-4: should verify on-chain Batch #2 parameters match canonical records", async function () {
      const batch2 = watchtower.batches.get(2);
      expect(batch2).to.not.be.undefined;
      expect(batch2!.batchId).to.equal(2);
      expect(batch2!.prevStateRoot.toLowerCase()).to.equal(BATCH_1_STATE_ROOT.toLowerCase());
      expect(batch2!.newStateRoot.toLowerCase()).to.equal(BATCH_2_STATE_ROOT.toLowerCase());
      expect(batch2!.withdrawalRoot.toLowerCase()).to.equal(BATCH_2_WITHDRAWAL_ROOT.toLowerCase());
      expect(batch2!.blockNumber).to.equal(10494583);
      expect(batch2!.transactionHash).to.match(/^0x[0-9a-fA-F]{64}$/);
    });
  });

  // =========================================================================
  // Dimension 2: Monotonic Sequence & Continuity Validation
  // =========================================================================
  describe("Dimension 2: Monotonic Sequence & Continuity Validation", function () {
    it("D2-1: should verify on-chain batch sequence 1 -> 2 is strictly unbroken and continuous", function () {
      const continuity = watchtower.verifyBatchContinuity();
      expect(continuity.valid).to.be.true;
      expect(continuity.checkedBatches).to.be.at.least(2);
      expect(continuity.errors).to.have.lengthOf(0);
    });

    it("D2-2: should detect and report sequence gaps in batch progression", function () {
      const syntheticGap: ParsedBatchSettledEvent[] = [
        {
          batchId: 1,
          prevStateRoot: ethers.ZeroHash,
          newStateRoot: BATCH_1_STATE_ROOT,
          withdrawalRoot: ethers.ZeroHash,
          dataHash: ethers.ZeroHash,
          blockNumber: 100,
          transactionHash: ethers.ZeroHash,
          logIndex: 0
        },
        {
          batchId: 3, // Skipped batch #2
          prevStateRoot: BATCH_1_STATE_ROOT,
          newStateRoot: BATCH_2_STATE_ROOT,
          withdrawalRoot: ethers.ZeroHash,
          dataHash: ethers.ZeroHash,
          blockNumber: 200,
          transactionHash: ethers.ZeroHash,
          logIndex: 0
        }
      ];

      const report = watchtower.verifyBatchContinuity(syntheticGap);
      expect(report.valid).to.be.false;
      expect(report.errors[0]).to.include("Sequence gap detected: Batch #3 immediately follows Batch #1");
    });

    it("D2-3: should detect and report broken state root continuity", function () {
      const syntheticBroken: ParsedBatchSettledEvent[] = [
        {
          batchId: 1,
          prevStateRoot: ethers.ZeroHash,
          newStateRoot: BATCH_1_STATE_ROOT,
          withdrawalRoot: ethers.ZeroHash,
          dataHash: ethers.ZeroHash,
          blockNumber: 100,
          transactionHash: ethers.ZeroHash,
          logIndex: 0
        },
        {
          batchId: 2,
          prevStateRoot: "0x1111111111111111111111111111111111111111111111111111111111111111", // Does not match batch #1 newStateRoot
          newStateRoot: BATCH_2_STATE_ROOT,
          withdrawalRoot: ethers.ZeroHash,
          dataHash: ethers.ZeroHash,
          blockNumber: 200,
          transactionHash: ethers.ZeroHash,
          logIndex: 0
        }
      ];

      const report = watchtower.verifyBatchContinuity(syntheticBroken);
      expect(report.valid).to.be.false;
      expect(report.errors[0]).to.include("State root continuity broken at Batch #2");
    });

    it("D2-4: should reject non-zero genesis state root for Batch #1", function () {
      const invalidGenesis: ParsedBatchSettledEvent[] = [
        {
          batchId: 1,
          prevStateRoot: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          newStateRoot: BATCH_1_STATE_ROOT,
          withdrawalRoot: ethers.ZeroHash,
          dataHash: ethers.ZeroHash,
          blockNumber: 100,
          transactionHash: ethers.ZeroHash,
          logIndex: 0
        }
      ];

      const report = watchtower.verifyBatchContinuity(invalidGenesis);
      expect(report.valid).to.be.false;
      expect(report.errors[0]).to.include("Batch #1 prevStateRoot must equal ZeroHash");
    });
  });

  // =========================================================================
  // Dimension 3: Deterministic Replay & Cryptographic Reconciliation
  // =========================================================================
  describe("Dimension 3: Deterministic Replay & Cryptographic Reconciliation", function () {
    it("D3-1: should successfully replay on-chain batches and certify state root convergence", async function () {
      const replay = await watchtower.replayStateTransitions();
      expect(replay.success).to.be.true;
      expect(replay.verifiedBatches).to.be.at.least(2);
      expect(replay.finalStateRoot.toLowerCase()).to.equal(BATCH_2_STATE_ROOT.toLowerCase());
      expect(watchtower.integrityStatus).to.equal("HEALTHY_AND_VERIFIED");
    });

    it("D3-2: should verify watchtower state tracking advances monotonically", function () {
      expect(watchtower.latestVerifiedBatchId).to.equal(2);
      expect(watchtower.latestVerifiedStateRoot.toLowerCase()).to.equal(BATCH_2_STATE_ROOT.toLowerCase());
    });

    it("D3-3: should handle empty batch list gracefully without mutations", async function () {
      const emptyWatchtower = new OreVeilWatchtower({
        provider: dianaProvider,
        startBlock: 20000000 // Future block with 0 events
      });

      const replay = await emptyWatchtower.replayStateTransitions([]);
      expect(replay.success).to.be.true;
      expect(replay.verifiedBatches).to.equal(0);
      expect(replay.finalStateRoot).to.equal(ethers.ZeroHash);
    });
  });

  // =========================================================================
  // Dimension 4: Adversarial Divergence & Fraud Challenge Generation
  // =========================================================================
  describe("Dimension 4: Adversarial Divergence & Fraud Challenge Generation", function () {
    it("D4-1: should return null when comparing identical honest roots", function () {
      const alert = watchtower.detectAdversarialDivergence(
        2,
        BATCH_2_STATE_ROOT,
        BATCH_2_STATE_ROOT
      );
      expect(alert).to.be.null;
    });

    it("D4-2: should detect adversarial state divergence and generate a structured FraudAlert", function () {
      const forgedRoot = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const expectedRoot = BATCH_2_STATE_ROOT;

      const alert = watchtower.detectAdversarialDivergence(
        2,
        forgedRoot,
        expectedRoot,
        { blockNumber: 10494583, transactionHash: "0x1c2f661c67a2bd1cc46e7ba7ffb68bf8086a5ac527e6fecc135c9f38d9150539" }
      );

      expect(alert).to.not.be.null;
      expect(alert!.batchId).to.equal(2);
      expect(alert!.onChainStateRoot).to.equal(forgedRoot);
      expect(alert!.expectedStateRoot).to.equal(expectedRoot);
      expect(alert!.reason).to.include("StateTransitionMismatch");
      expect(alert!.timestamp).to.be.a("string");
      expect(watchtower.integrityStatus).to.equal("DIVERGENT");
      expect(watchtower.divergentBatches).to.have.lengthOf(1);
    });

    it("D4-3: should abort replay and flag divergence when on-chain batch mismatches expected root", async function () {
      const override = new Map<number, string>();
      override.set(2, "0x9999999999999999999999999999999999999999999999999999999999999999"); // Honest expectation differs from on-chain

      const replay = await watchtower.replayStateTransitions(undefined, override);
      expect(replay.success).to.be.false;
      expect(replay.divergentBatchId).to.equal(2);
      expect(replay.divergenceReason).to.include("StateTransitionMismatch");
    });
  });

  // =========================================================================
  // Dimension 5: RPC Safety, Chunking & Telemetry Integrity
  // =========================================================================
  describe("Dimension 5: RPC Safety, Chunking & Telemetry Integrity", function () {
    it("D5-1: should scan event history in small chunk slices (chunkSize: 1000) without RPC errors", async function () {
      const chunkedWatcher = new OreVeilWatchtower({
        provider: dianaProvider,
        startBlock: 10438000,
        chunkSize: 1000
      });

      // Query from 10438000 to 10440000 (2 chunks)
      const events = await chunkedWatcher.syncBatchEvents(10438000, 10440000);
      expect(events.length).to.be.at.least(1);
      expect(events[0].batchId).to.equal(1);
      expect(chunkedWatcher.syncedBlock).to.equal(10440000);
    });

    it("D5-2: should ensure syncBatchEvents is idempotent across repeated invocations", async function () {
      const initialCount = watchtower.batches.size;
      await watchtower.syncBatchEvents(10438000, 10440000);
      expect(watchtower.batches.size).to.equal(initialCount);
    });

    it("D5-3: should export full WatchtowerReport with valid telemetry and status", async function () {
      const report: WatchtowerReport = await watchtower.getWatchtowerReport();
      expect(report.chainId).to.equal(DEFAULT_DIANA_CHAIN_ID);
      expect(report.settlerAddress.toLowerCase()).to.equal(DEFAULT_SETTLER_ADDRESS.toLowerCase());
      expect(report.totalBatchesProcessed).to.be.at.least(2);
      expect(report.latestVerifiedBatchId).to.equal(2);
      expect(report.latestVerifiedStateRoot.toLowerCase()).to.equal(BATCH_2_STATE_ROOT.toLowerCase());
      expect(report.latestBlock).to.be.greaterThan(10494000);
      expect(report.divergentBatches).to.be.an("array");
    });
  });
});
