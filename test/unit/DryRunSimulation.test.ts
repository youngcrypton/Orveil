import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SIGNATURE_LENGTH
} from "@qorechain/qoresign";
import {
  BatchSequencer,
  BatchCommitmentPayload,
  SequencerKeypair,
  DIANA_CHAIN_ID
} from "../../sequencer/batchSequencer";
import {
  simulateBatchSettlement,
  formatDryRunReport,
  assertBatchReadyForBroadcast,
  DEFAULT_SETTLER_ADDRESS,
  DEFAULT_CALLER_ADDRESS,
  DEFAULT_DIANA_RPC,
  MAX_BLOCK_GAS_LIMIT,
  DryRunReport
} from "../../scripts/lib/dryRunSimulation";
import { OreVeilSettler } from "../../typechain-types/contracts/OreVeilSettler";
import { OreVeilSettler__factory } from "../../typechain-types/factories/contracts/OreVeilSettler__factory";
import { DIANA_MIN_GAS_FLOOR_WEI } from "../../scripts/lib/safetyGuards";

describe("Sub-Phase 3.1 Layer 4: Dry-Run Pre-Flight Staticcall Simulation (Zero Mocks)", function () {
  this.timeout(90000); // 90 seconds for live network assertions

  let provider: ethers.JsonRpcProvider;
  let sequencerKeypair: SequencerKeypair;
  let sequencer: BatchSequencer;
  let onChainLatestBatchId: number;
  let onChainLatestStateRoot: string;
  let onChainSequencerPubKey: string;

  before(async function () {
    provider = new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC);

    // Verify RPC connectivity
    const network = await provider.getNetwork();
    expect(Number(network.chainId)).to.equal(DIANA_CHAIN_ID);

    // Load authentic sequencer ML-DSA-87 keypair
    const keyPath = path.join(process.cwd(), "deployments", "sequencer-key.json");
    expect(fs.existsSync(keyPath), "Sequencer keyfile must exist").to.be.true;
    const rawKey = JSON.parse(fs.readFileSync(keyPath, "utf8"));

    const publicKeyBytes = ethers.getBytes(rawKey.publicKey);
    const secretKeyBytes = ethers.getBytes(rawKey.secretKey);
    expect(publicKeyBytes.length).to.equal(ML_DSA_87_PUBLIC_KEY_LENGTH);
    expect(secretKeyBytes.length).to.equal(4896);

    sequencerKeypair = {
      publicKey: publicKeyBytes,
      secretKey: secretKeyBytes
    };

    sequencer = new BatchSequencer(sequencerKeypair, DEFAULT_SETTLER_ADDRESS, DIANA_CHAIN_ID);

    // Read live contract state
    const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
    onChainLatestBatchId = Number(await settler.latestBatchId());
    onChainLatestStateRoot = await settler.latestStateRoot();
    onChainSequencerPubKey = await settler.sequencerPublicKey();
  });

  // =========================================================================
  // Dimension 1: Contract State Synchronization & Invariant Alignment Tests
  // =========================================================================
  describe("Dimension 1: Contract State Synchronization & Invariant Alignment", function () {
    it("D1-1: should synchronize live latestBatchId and latestStateRoot from Diana contract", async function () {
      expect(onChainLatestBatchId).to.be.a("number");
      expect(onChainLatestBatchId).to.be.at.least(0);
      expect(onChainLatestStateRoot).to.match(/^0x[0-9a-fA-F]{64}$/);
    });

    it("D1-2: should verify contract sequencerPublicKey matches local ML-DSA-87 key byte-for-byte", async function () {
      const contractKeyBytes = ethers.getBytes(onChainSequencerPubKey);
      expect(contractKeyBytes.length).to.equal(ML_DSA_87_PUBLIC_KEY_LENGTH);
      expect(ethers.hexlify(contractKeyBytes)).to.equal(ethers.hexlify(sequencerKeypair.publicKey));
    });

    it("D1-3: should verify deployer account solvency exceeds minimum operational floor", async function () {
      const balance = await provider.getBalance(DEFAULT_CALLER_ADDRESS);
      expect(balance).to.be.greaterThan(5_000_000_000_000_000_000n); // >= 5 QOR
    });
  });

  // =========================================================================
  // Dimension 2: Positive Live Simulation (settleBatch.staticCall) Tests
  // =========================================================================
  describe("Dimension 2: Positive Live Simulation (settleBatch.staticCall)", function () {
    let validPayload: BatchCommitmentPayload;
    let positiveReport: DryRunReport;

    before(async function () {
      const targetBatchId = onChainLatestBatchId + 1;
      const prevStateRoot = onChainLatestStateRoot;
      const newStateRoot = ethers.keccak256(ethers.toUtf8Bytes(`diana_layer4_state_${Date.now()}`));
      const withdrawalRoot = ethers.keccak256(ethers.toUtf8Bytes(`diana_layer4_withdrawal_${Date.now()}`));
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(`diana_layer4_data_${Date.now()}`));

      const commitmentHash = BatchSequencer.computeCommitmentHash(
        DIANA_CHAIN_ID,
        targetBatchId,
        prevStateRoot,
        newStateRoot,
        withdrawalRoot,
        dataHash
      );

      const signature = sequencer.signCommitment(commitmentHash);

      validPayload = {
        batchId: targetBatchId,
        prevStateRoot,
        newStateRoot,
        withdrawalRoot,
        dataHash,
        commitmentHash,
        signature,
        chainId: DIANA_CHAIN_ID
      };

      positiveReport = await simulateBatchSettlement(validPayload, {
        provider,
        settlerAddress: DEFAULT_SETTLER_ADDRESS,
        callerAddress: DEFAULT_CALLER_ADDRESS
      });
    });

    it("D2-1: should successfully simulate settleBatch via EVM staticcall without reverts", function () {
      expect(positiveReport.success).to.be.true;
      expect(positiveReport.revertReason).to.be.undefined;
    });

    it("D2-2: should verify return report indicates readyForBroadcast == true", function () {
      expect(positiveReport.readyForBroadcast).to.be.true;
    });

    it("D2-3: should assert ML-DSA-87 signature length is strictly 4,627 bytes", function () {
      expect(positiveReport.signatureLengthBytes).to.equal(ML_DSA_87_SIGNATURE_LENGTH);
    });

    it("D2-4: should assert staticcall causes zero state mutation on Layer 1 contract", async function () {
      const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
      const currentBatchId = Number(await settler.latestBatchId());
      const currentStateRoot = await settler.latestStateRoot();

      expect(currentBatchId).to.equal(onChainLatestBatchId);
      expect(currentStateRoot).to.equal(onChainLatestStateRoot);
    });
  });

  // =========================================================================
  // Dimension 3: Negative Invariant Attack & Revert Simulations (Adversarial)
  // =========================================================================
  describe("Dimension 3: Negative Invariant Attack & Revert Simulations", function () {
    it("D3-1: should revert with InvalidBatchId when batchId skips sequence or replays past batch", async function () {
      const invalidBatchId = onChainLatestBatchId + 999; // Gap violation
      const commitmentHash = BatchSequencer.computeCommitmentHash(
        DIANA_CHAIN_ID,
        invalidBatchId,
        onChainLatestStateRoot,
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash
      );
      const signature = sequencer.signCommitment(commitmentHash);

      const invalidPayload: BatchCommitmentPayload = {
        batchId: invalidBatchId,
        prevStateRoot: onChainLatestStateRoot,
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        commitmentHash,
        signature,
        chainId: DIANA_CHAIN_ID
      };

      const report = await simulateBatchSettlement(invalidPayload, { provider });
      expect(report.success).to.be.false;
      expect(report.readyForBroadcast).to.be.false;
      expect(report.revertReason).to.include("InvalidBatchId");
    });

    it("D3-2: should revert with StateRootMismatch when prevStateRoot is stale or forged", async function () {
      const targetBatchId = onChainLatestBatchId + 1;
      const forgedPrevStateRoot = ethers.keccak256(ethers.toUtf8Bytes("forged_prior_state"));

      const commitmentHash = BatchSequencer.computeCommitmentHash(
        DIANA_CHAIN_ID,
        targetBatchId,
        forgedPrevStateRoot,
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash
      );
      const signature = sequencer.signCommitment(commitmentHash);

      const invalidPayload: BatchCommitmentPayload = {
        batchId: targetBatchId,
        prevStateRoot: forgedPrevStateRoot,
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        commitmentHash,
        signature,
        chainId: DIANA_CHAIN_ID
      };

      const report = await simulateBatchSettlement(invalidPayload, { provider });
      expect(report.success).to.be.false;
      expect(report.readyForBroadcast).to.be.false;
      expect(report.revertReason).to.include("StateRootMismatch");
    });

    it("D3-3: should revert with InvalidMLDSASignature when signature is tampered by 1 byte", async function () {
      const targetBatchId = onChainLatestBatchId + 1;
      const commitmentHash = BatchSequencer.computeCommitmentHash(
        DIANA_CHAIN_ID,
        targetBatchId,
        onChainLatestStateRoot,
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash
      );
      const authenticSignature = sequencer.signCommitment(commitmentHash);

      // Tamper signature by flipping the last byte
      const sigBytes = ethers.getBytes(authenticSignature);
      sigBytes[sigBytes.length - 1] ^= 0xff;
      const tamperedSignature = ethers.hexlify(sigBytes);

      const invalidPayload: BatchCommitmentPayload = {
        batchId: targetBatchId,
        prevStateRoot: onChainLatestStateRoot,
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        commitmentHash,
        signature: tamperedSignature,
        chainId: DIANA_CHAIN_ID
      };

      const report = await simulateBatchSettlement(invalidPayload, { provider });
      expect(report.success).to.be.false;
      expect(report.readyForBroadcast).to.be.false;
      expect(report.revertReason).to.include("InvalidMLDSASignature");
    });

    it("D3-4: should revert when signature is generated under cross-chain chainId (domain separation tampering)", async function () {
      const targetBatchId = onChainLatestBatchId + 1;
      const forgedChainId = 1; // Ethereum mainnet chainId instead of Diana 9800

      const forgedCommitmentHash = BatchSequencer.computeCommitmentHash(
        forgedChainId,
        targetBatchId,
        onChainLatestStateRoot,
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash
      );
      const forgedSignature = sequencer.signCommitment(forgedCommitmentHash);

      // Contract will reconstruct hash using block.chainid (9800) and verify signature
      const invalidPayload: BatchCommitmentPayload = {
        batchId: targetBatchId,
        prevStateRoot: onChainLatestStateRoot,
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        commitmentHash: forgedCommitmentHash,
        signature: forgedSignature,
        chainId: forgedChainId
      };

      const report = await simulateBatchSettlement(invalidPayload, { provider });
      expect(report.success).to.be.false;
      expect(report.readyForBroadcast).to.be.false;
      expect(report.revertReason).to.include("InvalidMLDSASignature");
    });

    it("D3-5: should revert when calldata signature length is truncated below 4,627 bytes", async function () {
      const targetBatchId = onChainLatestBatchId + 1;
      const truncatedSignature = "0x" + "aa".repeat(100); // 100 bytes instead of 4,627

      const invalidPayload: BatchCommitmentPayload = {
        batchId: targetBatchId,
        prevStateRoot: onChainLatestStateRoot,
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        commitmentHash: ethers.ZeroHash,
        signature: truncatedSignature,
        chainId: DIANA_CHAIN_ID
      };

      const report = await simulateBatchSettlement(invalidPayload, { provider });
      expect(report.success).to.be.false;
      expect(report.readyForBroadcast).to.be.false;
      expect(report.signatureLengthBytes).to.equal(100);
      expect(report.revertReason).to.include("InvalidMLDSASignature");
    });
  });

  // =========================================================================
  // Dimension 4: Exact Gas Estimation & Economic Solvency Bounds Tests
  // =========================================================================
  describe("Dimension 4: Exact Gas Estimation & Economic Solvency Bounds", function () {
    let report: DryRunReport;

    before(async function () {
      const targetBatchId = onChainLatestBatchId + 1;
      const commitmentHash = BatchSequencer.computeCommitmentHash(
        DIANA_CHAIN_ID,
        targetBatchId,
        onChainLatestStateRoot,
        ethers.keccak256(ethers.toUtf8Bytes("gas_test_state")),
        ethers.keccak256(ethers.toUtf8Bytes("gas_test_withdrawal")),
        ethers.keccak256(ethers.toUtf8Bytes("gas_test_data"))
      );
      const signature = sequencer.signCommitment(commitmentHash);

      const payload: BatchCommitmentPayload = {
        batchId: targetBatchId,
        prevStateRoot: onChainLatestStateRoot,
        newStateRoot: ethers.keccak256(ethers.toUtf8Bytes("gas_test_state")),
        withdrawalRoot: ethers.keccak256(ethers.toUtf8Bytes("gas_test_withdrawal")),
        dataHash: ethers.keccak256(ethers.toUtf8Bytes("gas_test_data")),
        commitmentHash,
        signature,
        chainId: DIANA_CHAIN_ID
      };

      report = await simulateBatchSettlement(payload, { provider });
    });

    it("D4-1: should measure non-zero simulated gas units matching precompile overhead", function () {
      expect(report.simulatedGasUnits).to.be.greaterThan(100_000n);
      expect(report.simulatedGasUnits).to.be.lessThan(MAX_BLOCK_GAS_LIMIT);
    });

    it("D4-2: should enforce effective gas price satisfies the Diana 100 gwei floor", function () {
      expect(report.effectiveGasPriceWei).to.be.at.least(DIANA_MIN_GAS_FLOOR_WEI);
    });

    it("D4-3: should verify estimated fee in QOR is positive and within realistic rollup bounds", function () {
      expect(report.estimatedFeeWei).to.be.greaterThan(0n);
      const feeQorNum = parseFloat(report.estimatedFeeQor);
      expect(feeQorNum).to.be.greaterThan(0);
      expect(feeQorNum).to.be.lessThan(1.0); // A single batch costs < 1 QOR
    });

    it("D4-4: should assert deployer solvency margin ratio exceeds 100x batch cost", function () {
      expect(report.solvencyMarginRatio).to.be.at.least(100);
    });
  });

  // =========================================================================
  // Dimension 5: Rehearsal Audit Report & Safety Gate Enforcement Tests
  // =========================================================================
  describe("Dimension 5: Rehearsal Audit Report & Safety Gate Enforcement", function () {
    it("D5-1: should format clean diagnostic dry-run rehearsal summary report", async function () {
      const targetBatchId = onChainLatestBatchId + 1;
      const commitmentHash = BatchSequencer.computeCommitmentHash(
        DIANA_CHAIN_ID,
        targetBatchId,
        onChainLatestStateRoot,
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash
      );
      const signature = sequencer.signCommitment(commitmentHash);

      const payload: BatchCommitmentPayload = {
        batchId: targetBatchId,
        prevStateRoot: onChainLatestStateRoot,
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        commitmentHash,
        signature,
        chainId: DIANA_CHAIN_ID
      };

      const report = await simulateBatchSettlement(payload, { provider });
      const formatted = formatDryRunReport(report);

      expect(formatted).to.include("OREVEIL POST-QUANTUM ROLLUP BATCH DRY-RUN REHEARSAL");
      expect(formatted).to.include("Target Batch ID");
      expect(formatted).to.include("4627 bytes");
      expect(formatted).to.include("Simulated Gas Units");
      expect(formatted).to.include("Deployer Balance");
    });

    it("D5-2: should pass assertBatchReadyForBroadcast on valid report", async function () {
      const targetBatchId = onChainLatestBatchId + 1;
      const commitmentHash = BatchSequencer.computeCommitmentHash(
        DIANA_CHAIN_ID,
        targetBatchId,
        onChainLatestStateRoot,
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash
      );
      const signature = sequencer.signCommitment(commitmentHash);

      const payload: BatchCommitmentPayload = {
        batchId: targetBatchId,
        prevStateRoot: onChainLatestStateRoot,
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        commitmentHash,
        signature,
        chainId: DIANA_CHAIN_ID
      };

      const report = await simulateBatchSettlement(payload, { provider });
      expect(() => assertBatchReadyForBroadcast(report)).not.to.throw();
    });

    it("D5-3: should throw descriptive error in assertBatchReadyForBroadcast on reverted report", function () {
      const failedReport: DryRunReport = {
        success: false,
        batchId: 999,
        onChainLatestBatchId: 0,
        prevStateRoot: ethers.ZeroHash,
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        signatureLengthBytes: 4627,
        simulatedGasUnits: 0n,
        effectiveGasPriceWei: 112_500_000_000n,
        estimatedFeeWei: 0n,
        estimatedFeeQor: "0.0",
        deployerBalanceWei: 128_000_000_000_000_000_000n,
        deployerBalanceQor: "128.0",
        solvencyMarginRatio: 0,
        revertReason: "InvalidBatchId",
        readyForBroadcast: false,
        timestamp: new Date().toISOString()
      };

      expect(() => assertBatchReadyForBroadcast(failedReport)).to.throw(
        /Batch settlement simulation failed: InvalidBatchId/
      );
    });

    it("D5-4: should guarantee safety invariant: zero transactions broadcast, nonce unchanged", async function () {
      const nonceBefore = await provider.getTransactionCount(DEFAULT_CALLER_ADDRESS);

      // Run simulation
      const targetBatchId = onChainLatestBatchId + 1;
      const commitmentHash = BatchSequencer.computeCommitmentHash(
        DIANA_CHAIN_ID,
        targetBatchId,
        onChainLatestStateRoot,
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash
      );
      const signature = sequencer.signCommitment(commitmentHash);

      await simulateBatchSettlement(
        {
          batchId: targetBatchId,
          prevStateRoot: onChainLatestStateRoot,
          newStateRoot: ethers.ZeroHash,
          withdrawalRoot: ethers.ZeroHash,
          dataHash: ethers.ZeroHash,
          commitmentHash,
          signature,
          chainId: DIANA_CHAIN_ID
        },
        { provider }
      );

      const nonceAfter = await provider.getTransactionCount(DEFAULT_CALLER_ADDRESS);
      expect(nonceAfter).to.equal(nonceBefore);
    });
  });
});
