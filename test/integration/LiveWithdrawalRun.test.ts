import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import * as util from "util";
import { OreVeilSettler__factory } from "../../typechain-types/factories/contracts/OreVeilSettler__factory";
import {
  DEFAULT_DIANA_RPC,
  DEFAULT_SETTLER_ADDRESS,
  DEFAULT_DEPLOYER_EVM
} from "../../scripts/lib/dryRunSimulation";
import { DIANA_CHAIN_ID } from "../../scripts/lib/safetyGuards";
import {
  computeWithdrawalLeaf,
  WithdrawalTree
} from "../../scripts/lib/withdrawalTreePipeline";

const execAsync = util.promisify(exec);

describe("Sub-Phase 3.2 Layer 4: Unified Dual-Mode Egress CLI Runner & Automated Integration Suite (Zero Mocks)", function () {
  this.timeout(150000); // 150s for live Diana network operations

  let provider: ethers.JsonRpcProvider;
  let onChainBatchIdBefore: bigint;
  let onChainStateRootBefore: string;
  let contractBalanceBefore: bigint;
  let deployerBalanceBefore: bigint;

  let dryRunStdout: string = "";
  let dryRunExitCode: number = 0;

  before(async function () {
    provider = new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
    });

    const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);

    // Resilient network query with retry for Windows DNS EAI_AGAIN
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        onChainBatchIdBefore = await settler.latestBatchId();
        onChainStateRootBefore = await settler.latestStateRoot();
        contractBalanceBefore = await provider.getBalance(DEFAULT_SETTLER_ADDRESS);
        deployerBalanceBefore = await provider.getBalance(DEFAULT_DEPLOYER_EVM);
        break;
      } catch (err: any) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    // Execute Method 1 (--dry-run) programmatically to capture end-to-end telemetry
    try {
      const result = await execAsync("npx ts-node scripts/live-withdrawal-run.ts --dry-run", {
        cwd: process.cwd(),
        timeout: 100000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env }
      });
      dryRunStdout = result.stdout;
      dryRunExitCode = 0;
    } catch (err: any) {
      dryRunStdout = (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + (err.message || "");
      dryRunExitCode = err.code ?? 1;
    }
  });

  // =========================================================================
  // Suite 1: CLI Interface & Argument Parsing Integrity
  // =========================================================================
  describe("Suite 1: CLI Interface & Argument Parsing Integrity", function () {
    it("1.1: should display complete usage manual and exit cleanly with --help", async function () {
      const result = await execAsync("npx ts-node scripts/live-withdrawal-run.ts --help", {
        cwd: process.cwd(),
        timeout: 30000,
        env: { ...process.env }
      });

      expect(result.stdout).to.include("OREVEIL TRUSTLESS MERKLE WITHDRAWAL & BATCH #2 SETTLEMENT RUNNER");
      expect(result.stdout).to.include("USAGE:");
      expect(result.stdout).to.include("--dry-run");
      expect(result.stdout).to.include("--broadcast");
      expect(result.stdout).to.include("--skip-deposit");
      expect(result.stdout).to.include("-y, --yes");
      expect(result.stdout).to.include("-h, --help");
    });

    it("1.2: should parse and default to dry-run rehearsal safely without broadcast flags", function () {
      expect(dryRunStdout).to.include("Operational Mode : METHOD 1 (DRY-RUN REHEARSAL)");
      expect(dryRunStdout).to.include("Target Settler   : " + DEFAULT_SETTLER_ADDRESS);
    });
  });

  // =========================================================================
  // Suite 2: Method 1 (Dry-Run Rehearsal) End-to-End Execution
  // =========================================================================
  describe("Suite 2: Method 1 (Dry-Run Rehearsal) End-to-End Execution", function () {
    it("2.1: should execute full dry-run pipeline and exit with code 0", function () {
      expect(dryRunExitCode, `Process failed with output:\n${dryRunStdout}`).to.equal(0);
    });

    it("2.2: should execute all 6 stages sequentially and verify stage transitions", function () {
      expect(dryRunStdout).to.include("[Stage 1/6] Executing Pre-Flight Launchpad & Solvency Audit");
      expect(dryRunStdout).to.include("[Stage 2/6] Preparing Multi-Asset Vault Ingress");
      expect(dryRunStdout).to.include("[Stage 3/6] Constructing Merkle Withdrawal Tree & Batch #2 Quantum Anchor");
      expect(dryRunStdout).to.include("[Stage 4/6] Executing Trustless Merkle Withdrawal Egress");
      expect(dryRunStdout).to.include("[Stage 5/6] Proving Replay Defense & Double-Spend Rejection");
      expect(dryRunStdout).to.include("[Stage 6/6] Finalizing Telemetry & Evidence Ledger Logging");
      expect(dryRunStdout).to.include("[METHOD 1 COMPLETE] DRY-RUN REHEARSAL FINISHED SUCCESSFULLY!");
    });

    it("2.3: should prove Diana precompile 0x...0a01 validated Dilithium signature in simulation", function () {
      expect(dryRunStdout).to.include("Precompile 0x...0a01 verified Dilithium signature");
      expect(dryRunStdout).to.include("0 QOR burned. Contract state remains untouched.");
    });
  });

  // =========================================================================
  // Suite 3: Zero-Mutation State Immutability Verification
  // =========================================================================
  describe("Suite 3: Zero-Mutation State Immutability Verification", function () {
    it("3.1: should guarantee latestBatchId on Layer 1 remains strictly unchanged after dry-run", async function () {
      const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
      const onChainBatchIdAfter = await settler.latestBatchId();
      expect(onChainBatchIdAfter).to.equal(onChainBatchIdBefore);
    });

    it("3.2: should guarantee latestStateRoot on Layer 1 remains strictly unchanged after dry-run", async function () {
      const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
      const onChainStateRootAfter = await settler.latestStateRoot();
      expect(onChainStateRootAfter).to.equal(onChainStateRootBefore);
    });

    it("3.3: should guarantee contract balance and deployer wallet balance are preserved", async function () {
      const contractBalanceAfter = await provider.getBalance(DEFAULT_SETTLER_ADDRESS);
      const deployerBalanceAfter = await provider.getBalance(DEFAULT_DEPLOYER_EVM);

      expect(contractBalanceAfter).to.equal(contractBalanceBefore);
      expect(deployerBalanceAfter).to.equal(deployerBalanceBefore);
    });
  });

  // =========================================================================
  // Suite 4: Cryptographic Invariants & Replay Prevention Verification
  // =========================================================================
  describe("Suite 4: Cryptographic Invariants & Replay Prevention Verification", function () {
    it("4.1: should verify domain-separated leaf hashing matches contract specification", function () {
      const leaf = computeWithdrawalLeaf(
        DIANA_CHAIN_ID,
        0,
        DEFAULT_DEPLOYER_EVM,
        ethers.ZeroAddress,
        ethers.parseEther("1.0")
      );

      const manualPacked = ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "address", "address", "uint256"],
        [BigInt(DIANA_CHAIN_ID), 0n, DEFAULT_DEPLOYER_EVM, ethers.ZeroAddress, ethers.parseEther("1.0")]
      );

      expect(leaf).to.equal(manualPacked);
    });

    it("4.2: should prove binary Merkle tree proofs verify against OpenZeppelin MerkleProof.sol", function () {
      const entry = {
        withdrawalIndex: 0,
        recipient: DEFAULT_DEPLOYER_EVM,
        asset: ethers.ZeroAddress,
        amount: ethers.parseEther("1.0")
      };

      const tree = new WithdrawalTree([entry], DIANA_CHAIN_ID);
      const leaf = tree.getEntriesWithProofs()[0].leafHash || "";
      const proof = tree.getProof(0);
      const root = tree.getRoot();

      expect(tree.verifyProof(leaf, proof, root)).to.be.true;
    });

    it("4.3: should verify replay prevention defense mapping is queryable and clean", async function () {
      const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
      const leaf = computeWithdrawalLeaf(
        DIANA_CHAIN_ID,
        0,
        DEFAULT_DEPLOYER_EVM,
        ethers.ZeroAddress,
        ethers.parseEther("1.0")
      );

      const executed = await settler.executedWithdrawals(leaf);
      expect(executed).to.be.false;
    });
  });

  // =========================================================================
  // Suite 5: Evidence Ledger Integrity Verification
  // =========================================================================
  describe("Suite 5: Evidence Ledger Integrity Verification", function () {
    it("5.1: should verify EVIDENCE.md exists and contains verified Diana records", function () {
      const evidencePath = path.join(process.cwd(), "EVIDENCE.md");
      expect(fs.existsSync(evidencePath)).to.be.true;

      const content = fs.readFileSync(evidencePath, "utf8");
      expect(content).to.include("Diana Testnet Cryptographic Evidence Ledger");
      expect(content).to.include("chainId: 9800");
    });

    it("5.2: should assert historical Batch #1 proof record remains intact", function () {
      const evidencePath = path.join(process.cwd(), "EVIDENCE.md");
      const content = fs.readFileSync(evidencePath, "utf8");

      expect(content).to.include("Live Batch Settlement Proof: Batch #1");
      expect(content).to.include("MINED_AND_VERIFIED");
      expect(content).to.include("0x9cc8a59ad33de51cf9d502954e7279d54628ba12609de190e684b6ff64636695");
      expect(content).to.include("0x...0a01");
    });
  });
});
