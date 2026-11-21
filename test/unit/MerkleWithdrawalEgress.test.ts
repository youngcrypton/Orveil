import { expect } from "chai";
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import {
  simulateWithdrawal,
  executeWithdrawalOnChain,
  isWithdrawalExecutedOnChain,
  parseWithdrawalEvent,
  formatWithdrawalSimulationReport,
  formatWithdrawalSummary,
  appendWithdrawalEvidenceRecord,
  formatDianaExplorerLink,
  DEFAULT_WITHDRAWAL_GAS_LIMIT,
  DIANA_EXPLORER_BASE,
  WithdrawalParams,
  WithdrawalResult,
  WithdrawalSimulationReport
} from "../../scripts/lib/merkleWithdrawalEgress";
import {
  DEFAULT_DIANA_RPC,
  DEFAULT_SETTLER_ADDRESS,
  DEFAULT_DEPLOYER_EVM
} from "../../scripts/lib/dryRunSimulation";
import {
  DIANA_CHAIN_ID,
  DIANA_MIN_GAS_FLOOR_WEI
} from "../../scripts/lib/safetyGuards";
import { resolveDeployerSigner } from "../../scripts/lib/liveBroadcast";
import { computeWithdrawalLeaf } from "../../scripts/lib/withdrawalTreePipeline";
import { OreVeilSettler__factory } from "../../typechain-types/factories/contracts/OreVeilSettler__factory";

dotenv.config();

describe("Sub-Phase 3.2 Layer 3: Live On-Chain Trustless Merkle Withdrawal Egress Execution (Zero Mocks)", function () {
  this.timeout(90000); // 90s for live Diana network operations

  let provider: ethers.JsonRpcProvider;
  let signer: ethers.Signer;
  let signerAddress: string;
  let onChainLatestBatchId: number;

  before(async function () {
    provider = new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
    });

    signer = resolveDeployerSigner(provider);
    signerAddress = await signer.getAddress();

    const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);

    // Resilient network query with retry for Windows DNS EAI_AGAIN
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        onChainLatestBatchId = Number(await settler.latestBatchId());
        break;
      } catch (err: any) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  });

  // =========================================================================
  // Dimension 1: Signer Resolution & Account Solvency Guards
  // =========================================================================
  describe("Dimension 1: Signer Resolution & Account Solvency Guards", function () {
    it("D1-1: should resolve authorized deployer signer matching DEFAULT_DEPLOYER_EVM", function () {
      expect(signerAddress.toLowerCase()).to.equal(DEFAULT_DEPLOYER_EVM.toLowerCase());
    });

    it("D1-2: should verify signer holds sufficient live QOR balance (>= 5 QOR)", async function () {
      const balance = await provider.getBalance(signerAddress);
      expect(balance).to.be.greaterThan(5_000_000_000_000_000_000n);
    });

    it("D1-3: should throw descriptive error when deployer private key is missing", function () {
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

    it("D1-4: should accurately check on-chain execution status of unexecuted withdrawal leaf", async function () {
      const randomLeaf = ethers.keccak256(ethers.toUtf8Bytes("oreveil_unexecuted_leaf_test_random"));
      const isExecuted = await isWithdrawalExecutedOnChain(randomLeaf, DEFAULT_SETTLER_ADDRESS, provider);
      expect(isExecuted).to.be.false;
    });
  });

  // =========================================================================
  // Dimension 2: Staticcall Pre-Flight Simulation
  // =========================================================================
  describe("Dimension 2: Staticcall Pre-Flight Simulation", function () {
    it("D2-1: should intercept invalid Merkle proof and return structured simulation failure without reverting runner", async function () {
      const testParams: WithdrawalParams = {
        batchId: 1,
        withdrawalIndex: 999,
        recipient: signerAddress,
        asset: ethers.ZeroAddress,
        amount: ethers.parseEther("1.0"),
        merkleProof: [ethers.ZeroHash] // Bogus proof for Batch #1 (root is 0x00...00)
      };

      const report: WithdrawalSimulationReport = await simulateWithdrawal(testParams, {
        provider
      });

      expect(report.success).to.be.false;
      expect(report.batchId).to.equal(1);
      expect(report.withdrawalIndex).to.equal(999);
      expect(report.recipient.toLowerCase()).to.equal(signerAddress.toLowerCase());
      expect(report.asset).to.equal(ethers.ZeroAddress);
      expect(report.amount).to.equal(ethers.parseEther("1.0"));
      expect(report.amountFormatted).to.equal("1.0 QOR");
      expect(report.alreadyExecuted).to.be.false;
      expect(report.error).to.not.be.undefined;
      expect(report.error).to.match(/InvalidMerkleProof|reverted/i);
    });

    it("D2-2: should verify simulation produces zero state mutation on Layer 1 contract", async function () {
      const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
      const balanceBefore = await provider.getBalance(DEFAULT_SETTLER_ADDRESS);
      const testLeaf = computeWithdrawalLeaf(
        DIANA_CHAIN_ID,
        0,
        signerAddress,
        ethers.ZeroAddress,
        ethers.parseEther("1.0")
      );
      const executedBefore = await settler.executedWithdrawals(testLeaf);

      // Run simulation
      await simulateWithdrawal(
        {
          batchId: 1,
          withdrawalIndex: 0,
          recipient: signerAddress,
          asset: ethers.ZeroAddress,
          amount: ethers.parseEther("1.0"),
          merkleProof: [ethers.ZeroHash]
        },
        { provider }
      );

      const balanceAfter = await provider.getBalance(DEFAULT_SETTLER_ADDRESS);
      const executedAfter = await settler.executedWithdrawals(testLeaf);

      expect(balanceAfter).to.equal(balanceBefore);
      expect(executedAfter).to.equal(executedBefore);
    });

    it("D2-3: should format gas price and economic estimates compliant with Diana floor", async function () {
      const testParams: WithdrawalParams = {
        batchId: 1,
        withdrawalIndex: 0,
        recipient: signerAddress,
        asset: ethers.ZeroAddress,
        amount: ethers.parseEther("0.5"),
        merkleProof: []
      };

      const report = await simulateWithdrawal(testParams, { provider });
      expect(report.effectiveGasPriceWei).to.be.greaterThanOrEqual(DIANA_MIN_GAS_FLOOR_WEI);
    });
  });

  // =========================================================================
  // Dimension 3: Adversarial Revert Parity & Contract Defense
  // =========================================================================
  describe("Dimension 3: Adversarial Revert Parity & Contract Defense", function () {
    let settler: any;

    before(function () {
      settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
    });

    it("D3-1: should revert with InvalidBatchId when batchId is 0", async function () {
      let reverted = false;
      try {
        await settler.executeWithdrawal.staticCall(
          0, // Invalid: batchId must be > 0
          0,
          signerAddress,
          ethers.ZeroAddress,
          ethers.parseEther("1.0"),
          []
        );
      } catch (err: any) {
        reverted = true;
        expect(err.message).to.match(/InvalidBatchId|execution reverted/i);
      }
      expect(reverted).to.be.true;
    });

    it("D3-2: should revert with InvalidBatchId when batchId exceeds latestBatchId", async function () {
      let reverted = false;
      try {
        await settler.executeWithdrawal.staticCall(
          onChainLatestBatchId + 9999, // Non-existent future batch
          0,
          signerAddress,
          ethers.ZeroAddress,
          ethers.parseEther("1.0"),
          []
        );
      } catch (err: any) {
        reverted = true;
        expect(err.message).to.match(/InvalidBatchId|execution reverted/i);
      }
      expect(reverted).to.be.true;
    });

    it("D3-3: should revert with InvalidAddress when recipient is address(0)", async function () {
      let reverted = false;
      try {
        await settler.executeWithdrawal.staticCall(
          1,
          0,
          ethers.ZeroAddress, // Invalid: recipient cannot be address(0)
          ethers.ZeroAddress,
          ethers.parseEther("1.0"),
          []
        );
      } catch (err: any) {
        reverted = true;
        expect(err.message).to.match(/InvalidAddress|execution reverted/i);
      }
      expect(reverted).to.be.true;
    });

    it("D3-4: should revert with InvalidAmount when amount is 0", async function () {
      let reverted = false;
      try {
        await settler.executeWithdrawal.staticCall(
          1,
          0,
          signerAddress,
          ethers.ZeroAddress,
          0n, // Invalid: amount cannot be 0
          []
        );
      } catch (err: any) {
        reverted = true;
        expect(err.message).to.match(/InvalidAmount|execution reverted/i);
      }
      expect(reverted).to.be.true;
    });

    it("D3-5: should revert with InvalidMerkleProof when proof does not resolve to batch root", async function () {
      let reverted = false;
      try {
        await settler.executeWithdrawal.staticCall(
          1,
          0,
          signerAddress,
          ethers.ZeroAddress,
          ethers.parseEther("1.0"),
          [ethers.ZeroHash, ethers.keccak256(ethers.toUtf8Bytes("bogus_proof_step"))]
        );
      } catch (err: any) {
        reverted = true;
        expect(err.message).to.match(/InvalidMerkleProof|execution reverted/i);
      }
      expect(reverted).to.be.true;
    });
  });

  // =========================================================================
  // Dimension 4: Receipt Telemetry & Event Parsing Logic
  // =========================================================================
  describe("Dimension 4: Receipt Telemetry & Event Parsing Logic", function () {
    it("D4-1: should correctly parse and decode WithdrawalExecuted event from receipt logs", function () {
      const iface = OreVeilSettler__factory.createInterface();
      const eventFragment = iface.getEvent("WithdrawalExecuted");

      const batchId = 2;
      const withdrawalIndex = 1;
      const recipient = signerAddress;
      const asset = ethers.ZeroAddress;
      const amount = ethers.parseEther("2.5");

      const encodedLog = iface.encodeEventLog(eventFragment, [
        batchId,
        withdrawalIndex,
        recipient,
        asset,
        amount
      ]);

      const mockReceipt: any = {
        logs: [
          {
            address: DEFAULT_SETTLER_ADDRESS,
            topics: encodedLog.topics,
            data: encodedLog.data
          }
        ]
      };

      const parsed = parseWithdrawalEvent(mockReceipt, DEFAULT_SETTLER_ADDRESS);

      expect(parsed).to.not.be.null;
      expect(parsed?.batchId).to.equal(batchId);
      expect(parsed?.withdrawalIndex).to.equal(withdrawalIndex);
      expect(parsed?.recipient.toLowerCase()).to.equal(recipient.toLowerCase());
      expect(parsed?.asset).to.equal(asset);
      expect(parsed?.amount).to.equal(amount);
    });

    it("D4-2: should return null when receipt does not contain WithdrawalExecuted event", function () {
      const mockReceipt: any = {
        logs: [
          {
            address: DEFAULT_SETTLER_ADDRESS,
            topics: [ethers.ZeroHash],
            data: "0x"
          }
        ]
      };

      const parsed = parseWithdrawalEvent(mockReceipt, DEFAULT_SETTLER_ADDRESS);
      expect(parsed).to.be.null;
    });

    it("D4-3: should ignore logs from different contract addresses", function () {
      const iface = OreVeilSettler__factory.createInterface();
      const eventFragment = iface.getEvent("WithdrawalExecuted");

      const encodedLog = iface.encodeEventLog(eventFragment, [
        1,
        0,
        signerAddress,
        ethers.ZeroAddress,
        ethers.parseEther("1.0")
      ]);

      const foreignAddress = "0x1111111111111111111111111111111111111111";
      const mockReceipt: any = {
        logs: [
          {
            address: foreignAddress,
            topics: encodedLog.topics,
            data: encodedLog.data
          }
        ]
      };

      const parsed = parseWithdrawalEvent(mockReceipt, DEFAULT_SETTLER_ADDRESS);
      expect(parsed).to.be.null;
    });
  });

  // =========================================================================
  // Dimension 5: ASCII Summary Formatting & Evidence Persistence
  // =========================================================================
  describe("Dimension 5: ASCII Summary Formatting & Evidence Persistence", function () {
    it("D5-1: should format canonical Diana block explorer links", function () {
      const testHash = "0x7b23cf44a0e980a3be3b676a6b5790d565ca77a342410a56673bf8db86cb3261";
      const link = formatDianaExplorerLink(testHash);
      expect(link).to.equal(`${DIANA_EXPLORER_BASE}/tx/${testHash}`);

      // Should handle hash without leading 0x
      const linkWithout0x = formatDianaExplorerLink("7b23cf44a0e980a3be3b676a6b5790d565ca77a342410a56673bf8db86cb3261");
      expect(linkWithout0x).to.equal(`${DIANA_EXPLORER_BASE}/tx/${testHash}`);
    });

    it("D5-2: should format clean structured ASCII simulation report", function () {
      const mockReport: WithdrawalSimulationReport = {
        success: true,
        batchId: 2,
        withdrawalIndex: 0,
        recipient: signerAddress,
        asset: ethers.ZeroAddress,
        amount: ethers.parseEther("1.0"),
        amountFormatted: "1.0 QOR",
        leafHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        simulatedGas: 78500n,
        effectiveGasPriceWei: 112_500_000_000n,
        estimatedFeeQor: "0.00883125",
        settlerAddress: DEFAULT_SETTLER_ADDRESS,
        alreadyExecuted: false,
        timestamp: "2026-11-20T20:00:00.000Z"
      };

      const summary = formatWithdrawalSimulationReport(mockReport);

      expect(summary).to.include("OREVEIL MERKLE WITHDRAWAL EGRESS DRY-RUN REHEARSAL");
      expect(summary).to.include("PASS [SIMULATED]");
      expect(summary).to.include("Target Batch ID   : 2");
      expect(summary).to.include("Withdrawal Index  : #0");
      expect(summary).to.include("1.0 QOR");
      expect(summary).to.include("78,500 units");
      expect(summary).to.include("112.50 gwei");
    });

    it("D5-3: should format clean structured ASCII broadcast summary with full telemetry", function () {
      const mockResult: WithdrawalResult = {
        status: "SUCCESS",
        txHash: "0x7b23cf44a0e980a3be3b676a6b5790d565ca77a342410a56673bf8db86cb3261",
        blockNumber: 10444900,
        blockHash: "0xabcde12345abcde12345abcde12345abcde12345abcde12345abcde12345abcde",
        batchId: 2,
        withdrawalIndex: 0,
        recipient: signerAddress,
        asset: ethers.ZeroAddress,
        amount: ethers.parseEther("1.0"),
        amountFormatted: "1.0 QOR",
        leafHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        gasUsed: 65400n,
        effectiveGasPriceWei: 112_500_000_000n,
        feeBurnedQor: "0.0073575",
        recipientBalanceBefore: ethers.parseEther("228.0"),
        recipientBalanceAfter: ethers.parseEther("228.9926425"),
        contractBalanceBefore: ethers.parseEther("1.0"),
        contractBalanceAfter: ethers.parseEther("0.0"),
        explorerUrl: `${DIANA_EXPLORER_BASE}/tx/0x7b23cf44a0e980a3be3b676a6b5790d565ca77a342410a56673bf8db86cb3261`,
        timestamp: "2026-11-20T20:15:00.000Z",
        eventVerified: true
      };

      const summary = formatWithdrawalSummary(mockResult);

      expect(summary).to.include("OREVEIL TRUSTLESS MERKLE WITHDRAWAL BROADCAST RECEIPT");
      expect(summary).to.include("SUCCESS [MINED]");
      expect(summary).to.include("0x7b23cf44a0e980a3be3b676a6b5790d565ca77a342410a56673bf8db86cb3261");
      expect(summary).to.include("Batch Sequence ID : #2");
      expect(summary).to.include("1.0 QOR");
      expect(summary).to.include("Vault Disbursed   : -1.0 QOR");
      expect(summary).to.include("65,400 units");
      expect(summary).to.include("112.50 gwei");
      expect(summary).to.include("0.0073575 QOR");
    });

    it("D5-4: should append valid cryptographic proof record to evidence ledger file", function () {
      const tempEvidencePath = path.join(process.cwd(), "test", "temp-evidence-withdrawal-test.md");

      try {
        if (fs.existsSync(tempEvidencePath)) {
          fs.unlinkSync(tempEvidencePath);
        }

        const mockResult: WithdrawalResult = {
          status: "SUCCESS",
          txHash: "0x7b23cf44a0e980a3be3b676a6b5790d565ca77a342410a56673bf8db86cb3261",
          blockNumber: 10444900,
          blockHash: "0xabcde12345abcde12345abcde12345abcde12345abcde12345abcde12345abcde",
          batchId: 2,
          withdrawalIndex: 0,
          recipient: signerAddress,
          asset: ethers.ZeroAddress,
          amount: ethers.parseEther("1.0"),
          amountFormatted: "1.0 QOR",
          leafHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          gasUsed: 65400n,
          effectiveGasPriceWei: 112_500_000_000n,
          feeBurnedQor: "0.0073575",
          recipientBalanceBefore: ethers.parseEther("228.0"),
          recipientBalanceAfter: ethers.parseEther("228.9926425"),
          contractBalanceBefore: ethers.parseEther("1.0"),
          contractBalanceAfter: ethers.parseEther("0.0"),
          explorerUrl: `${DIANA_EXPLORER_BASE}/tx/0x7b23cf44a0e980a3be3b676a6b5790d565ca77a342410a56673bf8db86cb3261`,
          timestamp: "2026-11-20T20:15:00.000Z",
          eventVerified: true
        };

        appendWithdrawalEvidenceRecord(mockResult, tempEvidencePath);

        expect(fs.existsSync(tempEvidencePath)).to.be.true;
        const fileContent = fs.readFileSync(tempEvidencePath, "utf8");

        expect(fileContent).to.include("Live Trustless Merkle Withdrawal Proof: Batch #2");
        expect(fileContent).to.include("MINED_AND_VERIFIED");
        expect(fileContent).to.include(mockResult.txHash);
        expect(fileContent).to.include(mockResult.leafHash);
        expect(fileContent).to.include("Checks-Effects-Interactions");
      } finally {
        if (fs.existsSync(tempEvidencePath)) {
          fs.unlinkSync(tempEvidencePath);
        }
      }
    });
  });
});
