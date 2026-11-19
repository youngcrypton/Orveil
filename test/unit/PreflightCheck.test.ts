import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  runPreflightCheck,
  formatPreflightReport,
  DEFAULT_DIANA_RPC,
  DEFAULT_CHAIN_ID,
  DEFAULT_SETTLER_ADDRESS,
  DEFAULT_DEPLOYER_ADDRESS,
  DEFAULT_MIN_BALANCE_QOR,
  DEFAULT_MIN_BLOCK_NUMBER,
  DEFAULT_MIN_GAS_FLOOR,
  PreflightReport
} from "../../scripts/lib/preflightCheck";
import {
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SECRET_KEY_LENGTH
} from "@qorechain/qoresign";
import { ML_KEM_1024_PUBLIC_KEY_SIZE } from "@qorechain/sdk";

describe("Sub-Phase 3.1 Layer 1: Pre-Flight Environment & Account Solvency Pipeline", function () {
  this.timeout(60000); // Allow sufficient headroom for live RPC queries

  const tempDir = path.join(os.tmpdir(), "oreveil-preflight-tests-" + Date.now());

  before(function () {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  after(function () {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Suite 1: Local Key Integrity & Diagnostic Validations", function () {
    it("should verify live sequencer ML-DSA-87 key from deployments/sequencer-key.json", function () {
      const keyPath = path.join(process.cwd(), "deployments", "sequencer-key.json");
      expect(fs.existsSync(keyPath), "sequencer-key.json must exist").to.be.true;

      const data = JSON.parse(fs.readFileSync(keyPath, "utf8"));
      expect(data).to.have.property("publicKey");
      expect(data).to.have.property("secretKey");

      const pubKeyBytes = Buffer.from(data.publicKey.replace("0x", ""), "hex");
      const secKeyBytes = Buffer.from(data.secretKey.replace("0x", ""), "hex");

      expect(pubKeyBytes.length).to.equal(ML_DSA_87_PUBLIC_KEY_LENGTH);
      expect(secKeyBytes.length).to.equal(ML_DSA_87_SECRET_KEY_LENGTH);
    });

    it("should verify live sequencer ML-KEM-1024 key from deployments/sequencer-kem-key.json", function () {
      const keyPath = path.join(process.cwd(), "deployments", "sequencer-kem-key.json");
      expect(fs.existsSync(keyPath), "sequencer-kem-key.json must exist").to.be.true;

      const data = JSON.parse(fs.readFileSync(keyPath, "utf8"));
      expect(data).to.have.property("publicKey");

      const pubKeyBytes = Buffer.from(data.publicKey.replace("0x", ""), "hex");
      expect(pubKeyBytes.length).to.equal(ML_KEM_1024_PUBLIC_KEY_SIZE);
    });

    it("should report failure when ML-DSA-87 key file is missing or corrupted", async function () {
      const missingKeyPath = path.join(tempDir, "non-existent-dsa.json");
      const corruptedKeyPath = path.join(tempDir, "corrupted-dsa.json");

      // Test missing file
      const reportMissing = await runPreflightCheck({
        dsaKeyPath: missingKeyPath
      });
      const dsaCheckMissing = reportMissing.checks.find(
        (c) => c.name === "Sequencer ML-DSA-87 Key Integrity"
      );
      expect(dsaCheckMissing?.passed).to.be.false;
      expect(reportMissing.status).to.equal("FAILED");

      // Test corrupted key (invalid byte size)
      fs.writeFileSync(
        corruptedKeyPath,
        JSON.stringify({
          publicKey: "0x1234",
          secretKey: "0x5678"
        })
      );
      const reportCorrupted = await runPreflightCheck({
        dsaKeyPath: corruptedKeyPath
      });
      const dsaCheckCorrupted = reportCorrupted.checks.find(
        (c) => c.name === "Sequencer ML-DSA-87 Key Integrity"
      );
      expect(dsaCheckCorrupted?.passed).to.be.false;
      expect(reportCorrupted.status).to.equal("FAILED");
    });

    it("should report failure when ML-KEM-1024 key file is missing or corrupted", async function () {
      const missingKeyPath = path.join(tempDir, "non-existent-kem.json");
      const corruptedKeyPath = path.join(tempDir, "corrupted-kem.json");

      // Test missing file
      const reportMissing = await runPreflightCheck({
        kemKeyPath: missingKeyPath
      });
      const kemCheckMissing = reportMissing.checks.find(
        (c) => c.name === "Sequencer ML-KEM-1024 Key Integrity"
      );
      expect(kemCheckMissing?.passed).to.be.false;
      expect(reportMissing.status).to.equal("FAILED");

      // Test corrupted key (invalid byte size)
      fs.writeFileSync(
        corruptedKeyPath,
        JSON.stringify({
          publicKey: "0xdeadbeef"
        })
      );
      const reportCorrupted = await runPreflightCheck({
        kemKeyPath: corruptedKeyPath
      });
      const kemCheckCorrupted = reportCorrupted.checks.find(
        (c) => c.name === "Sequencer ML-KEM-1024 Key Integrity"
      );
      expect(kemCheckCorrupted?.passed).to.be.false;
      expect(reportCorrupted.status).to.equal("FAILED");
    });

    it("should fail chain ID check when expected chainId does not match network", async function () {
      const report = await runPreflightCheck({
        chainId: 1 // Request Ethereum Mainnet chainId on Diana network
      });
      const check = report.checks.find((c) => c.name === "RPC Connection & Chain ID");
      expect(check?.passed).to.be.false;
      expect(report.status).to.equal("FAILED");
    });

    it("should fail block liveness check when threshold exceeds current block height", async function () {
      const report = await runPreflightCheck({
        minBlockNumber: 99_999_999 // Unreachable futuristic block height
      });
      const check = report.checks.find((c) => c.name === "Block Liveness");
      expect(check?.passed).to.be.false;
      expect(report.status).to.equal("FAILED");
    });

    it("should fail gas price floor check when minimum floor exceeds network gas price", async function () {
      const report = await runPreflightCheck({
        minGasFloor: 1_000_000_000_000_000n // Exaggerated gas floor
      });
      const check = report.checks.find((c) => c.name === "Gas Price Floor");
      expect(check?.passed).to.be.false;
      expect(report.status).to.equal("FAILED");
    });

    it("should fail deployer solvency check when account holds below solvency threshold", async function () {
      const report = await runPreflightCheck({
        minBalanceQor: 1_000_000_000_000_000_000_000_000n // 1,000,000 QOR threshold
      });
      const check = report.checks.find((c) => c.name === "Deployer Solvency");
      expect(check?.passed).to.be.false;
      expect(report.status).to.equal("FAILED");
    });

    it("should fail settler bytecode check when address has no deployed code", async function () {
      const report = await runPreflightCheck({
        contractAddress: "0x0000000000000000000000000000000000000001" // Precompile or empty address
      });
      const check = report.checks.find((c) => c.name === "Settler Contract Bytecode");
      expect(check?.passed).to.be.false;
      expect(report.status).to.equal("FAILED");
    });

    it("should format preflight report with clean human-readable output", function () {
      const dummyReport: PreflightReport = {
        status: "PASSED",
        timestamp: "2026-11-20T00:00:00.000Z",
        chainId: 9800,
        blockNumber: 10400000,
        deployerAddress: DEFAULT_DEPLOYER_ADDRESS,
        deployerBalanceQor: "128.99",
        contractAddress: DEFAULT_SETTLER_ADDRESS,
        contractBytecodeLength: 9080,
        sequencerDsaKeyLength: 2592,
        sequencerKemKeyLength: 1568,
        checks: [
          {
            name: "RPC Connection & Chain ID",
            passed: true,
            details: "Connected to chainId 9800"
          },
          {
            name: "Settler Contract Bytecode",
            passed: true,
            details: "Bytecode verified"
          }
        ]
      };

      const formatted = formatPreflightReport(dummyReport);
      expect(formatted).to.include("[PASSED]");
      expect(formatted).to.include("9800");
      expect(formatted).to.include(DEFAULT_SETTLER_ADDRESS);
      expect(formatted).to.include("[PASS] 1. RPC Connection & Chain ID");
      expect(formatted).to.include("[PASS] 2. Settler Contract Bytecode");
    });
  });

  describe("Suite 2: Live Diana Testnet Pre-Flight Audit (Zero Mocks)", function () {
    let liveReport: PreflightReport;

    before(async function () {
      // Execute the genuine live audit against Diana Testnet
      liveReport = await runPreflightCheck();
      console.log("\n" + formatPreflightReport(liveReport) + "\n");
    });

    it("should achieve 100% green PASSED status on live Diana Testnet", function () {
      expect(liveReport.status).to.equal("PASSED");
      const failedChecks = liveReport.checks.filter((c) => !c.passed);
      expect(failedChecks).to.have.lengthOf(0, `Failed checks: ${JSON.stringify(failedChecks)}`);
    });

    it("should confirm chainId 9800 and active block liveness", function () {
      expect(liveReport.chainId).to.equal(DEFAULT_CHAIN_ID);
      expect(liveReport.blockNumber).to.be.greaterThan(DEFAULT_MIN_BLOCK_NUMBER);
    });

    it("should verify deployer solvency strictly above 5 QOR", function () {
      const balance = parseFloat(liveReport.deployerBalanceQor);
      expect(balance).to.be.greaterThanOrEqual(5.0);
      expect(liveReport.deployerAddress.toLowerCase()).to.equal(DEFAULT_DEPLOYER_ADDRESS.toLowerCase());
    });

    it("should verify deployed OreVeilSettler bytecode presence on Diana", function () {
      expect(liveReport.contractAddress.toLowerCase()).to.equal(DEFAULT_SETTLER_ADDRESS.toLowerCase());
      expect(liveReport.contractBytecodeLength).to.be.greaterThan(100);
    });

    it("should verify exact post-quantum cryptographic key dimensions", function () {
      expect(liveReport.sequencerDsaKeyLength).to.equal(ML_DSA_87_PUBLIC_KEY_LENGTH);
      expect(liveReport.sequencerKemKeyLength).to.equal(ML_KEM_1024_PUBLIC_KEY_SIZE);
    });
  });
});
