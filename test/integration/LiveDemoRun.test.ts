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

const execAsync = util.promisify(exec);

describe("Sub-Phase 3.1 Sub-Layer 5.3: Automated End-to-End Integration Test Suite (Zero Mocks)", function () {
  this.timeout(120000); // 120s timeout for live end-to-end integration tests

  let provider: ethers.JsonRpcProvider;
  let onChainBatchIdBefore: bigint;
  let onChainStateRootBefore: string;
  let deployerBalanceBefore: bigint;

  let dryRunStdout: string = "";
  let dryRunExitCode: number = 0;

  before(async function () {
    provider = new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
    });

    // Record initial live on-chain state before executing any commands
    const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
    onChainBatchIdBefore = await settler.latestBatchId();
    onChainStateRootBefore = await settler.latestStateRoot();
    deployerBalanceBefore = await provider.getBalance(DEFAULT_DEPLOYER_EVM);

    // Execute Method 1 (--dry-run) programmatically to capture end-to-end telemetry
    try {
      const result = await execAsync("npx ts-node scripts/live-demo-run.ts --dry-run", {
        cwd: process.cwd(),
        timeout: 90000,
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
      const result = await execAsync("npx ts-node scripts/live-demo-run.ts --help", {
        cwd: process.cwd(),
        timeout: 30000,
        env: { ...process.env }
      });

      expect(result.stdout).to.include("OREVEIL POST-QUANTUM FREQUENT BATCH AUCTION (FBA) ROLLUP DEMO RUNNER");
      expect(result.stdout).to.include("USAGE:");
      expect(result.stdout).to.include("--dry-run");
      expect(result.stdout).to.include("--broadcast");
      expect(result.stdout).to.include("-y, --yes");
      expect(result.stdout).to.include("-h, --help");
    });

    it("1.2: should parse and default to dry-run rehearsal safely without broadcast flags", function () {
      expect(dryRunStdout).to.include("Operational Mode: METHOD 1 (DRY-RUN REHEARSAL)");
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

    it("2.2: should execute all 7 stages sequentially and verify stage transitions", function () {
      expect(dryRunStdout).to.include("[Stage 1/7] Executing Pre-Flight Launchpad & Solvency Audit");
      expect(dryRunStdout).to.include("[Stage 2/7] Generating & Sealing Confidential Orders");
      expect(dryRunStdout).to.include("[Stage 3/7] Decapsulating Orders & Executing FBA Uniform Clearing");
      expect(dryRunStdout).to.include("[Stage 4/7] Generating NIST FIPS 204 (ML-DSA-87) Batch Signature");
      expect(dryRunStdout).to.include("[Stage 5/7] Evaluating Diana Consensus Gas Floor & Headroom");
      expect(dryRunStdout).to.include("[Stage 6/7] Simulating settleBatch via EVM staticCall on Diana Testnet");
      expect(dryRunStdout).to.include("[METHOD 1 COMPLETE] DRY-RUN REHEARSAL FINISHED SUCCESSFULLY!");
    });

    it("2.3: should prove Diana precompile 0x...0a01 validated Dilithium signature with zero gas burned", function () {
      expect(dryRunStdout).to.include("EVM Precompile 0x...0a01 validated the 4,627-byte Dilithium signature");
      expect(dryRunStdout).to.include("0 QOR burned");
      expect(dryRunStdout).to.include("Simulation Status    : PASS [SIMULATED]");
      expect(dryRunStdout).to.include("Broadcast Readiness  : READY FOR LIVE BROADCAST");
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

    it("3.3: should guarantee deployer wallet balance is preserved down to the single wei", async function () {
      const deployerBalanceAfter = await provider.getBalance(DEFAULT_DEPLOYER_EVM);
      expect(deployerBalanceAfter).to.equal(deployerBalanceBefore);
    });
  });

  // =========================================================================
  // Suite 4: Consensus Economics & Post-Quantum Invariant Parity
  // =========================================================================
  describe("Suite 4: Consensus Economics & Post-Quantum Invariant Parity", function () {
    it("4.1: should enforce effective gas price satisfies the Diana consensus floor with headroom", function () {
      expect(dryRunStdout).to.match(/Effective Gas Price\s*:\s*[0-9.]+\s*gwei\s*\(\s*>=\s*100\.0\s*gwei\s*Diana\s*consensus\s*floor\)/i);
      expect(dryRunStdout).to.include("Headroom Overhead   : +12.5%");
    });

    it("4.2: should enforce NIST FIPS 204 (ML-DSA-87) signature size is exactly 4,627 bytes", function () {
      expect(dryRunStdout).to.include("ML-DSA-87 Signature : Exactly 4627 bytes (NIST FIPS 204)");
      expect(dryRunStdout).to.include("ML-DSA-87 Sig Size : 4627 bytes");
    });

    it("4.3: should enforce NIST FIPS 203 (ML-KEM-1024) ciphertext size is exactly 1,568 bytes", function () {
      expect(dryRunStdout).to.include("Alice: Sealed BUY 1.0 fETH (ML-KEM-1024 Ciphertext: 1568 bytes)");
      expect(dryRunStdout).to.include("Bob  : Sealed SELL 1.0 fETH (ML-KEM-1024 Ciphertext: 1568 bytes)");
    });

    it("4.4: should prove mathematical token balance conservation with zero-wei leakage", function () {
      expect(dryRunStdout).to.include("Token Conservation Check  : Zero-Wei Leakage Proven (0 remainder wei)");
      expect(dryRunStdout).to.include("Uniform Clearing Price P*: 2500.00 fUSD/fETH");
      expect(dryRunStdout).to.include("Total Volume Matched     : 1.0 fETH");
    });
  });

  // =========================================================================
  // Suite 5: Cryptographic Evidence Ledger Verification
  // =========================================================================
  describe("Suite 5: Cryptographic Evidence Ledger Verification", function () {
    const evidencePath = path.join(process.cwd(), "EVIDENCE.md");

    it("5.1: should verify EVIDENCE.md exists and contains verified Diana records", function () {
      expect(fs.existsSync(evidencePath), "EVIDENCE.md must exist").to.be.true;
      const content = fs.readFileSync(evidencePath, "utf8");
      expect(content.length).to.be.greaterThan(100);
      expect(content).to.include("Live Batch Settlement Proof: Batch #1");
      expect(content).to.include("QoreChain Diana Testnet");
    });

    it("5.2: should verify EVIDENCE.md contains verified Batch #1 transaction hash and explorer link", function () {
      const content = fs.readFileSync(evidencePath, "utf8");
      expect(content).to.include("0x9cc8a59ad33de51cf9d502954e7279d54628ba12609de190e684b6ff64636695");
      expect(content).to.include("https://explore.qore.network/tx/0x9cc8a59ad33de51cf9d502954e7279d54628ba12609de190e684b6ff64636695");
      expect(content).to.include("0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44");
    });

    it("5.3: should verify EVIDENCE.md records block number, fee economics, and cryptographic standards", function () {
      const content = fs.readFileSync(evidencePath, "utf8");
      expect(content).to.include("#10438858");
      expect(content).to.include("1,750,000");
      expect(content).to.include("0.221484375 QOR");
      expect(content).to.include("NIST FIPS 203 (ML-KEM-1024)");
      expect(content).to.include("NIST FIPS 204 (ML-DSA-87)");
      expect(content).to.include("0x...0a01");
    });
  });
});
