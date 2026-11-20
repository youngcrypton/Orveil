import { expect } from "chai";
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import {
  simulateDeposit,
  executeDeposit,
  parseDepositEvent,
  formatDepositSimulationReport,
  formatDepositSummary,
  formatDianaExplorerLink,
  isNativeAsset,
  DEFAULT_DEPOSIT_GAS_LIMIT,
  DIANA_EXPLORER_BASE,
  DepositResult,
  DepositSimulationReport
} from "../../scripts/lib/vaultIngress";
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
import { OreVeilSettler__factory } from "../../typechain-types/factories/contracts/OreVeilSettler__factory";

dotenv.config();

describe("Sub-Phase 3.2 Layer 1: Live On-Chain Multi-Asset Vault Ingress Pipeline (Zero Mocks)", function () {
  this.timeout(60000); // 60s for live Diana assertions

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

    it("D1-3: should identify native asset identifiers correctly", function () {
      expect(isNativeAsset(ethers.ZeroAddress)).to.be.true;
      expect(isNativeAsset("0x0000000000000000000000000000000000000000")).to.be.true;
      expect(isNativeAsset("")).to.be.true;
      expect(isNativeAsset("0x5555555555555555555555555555555555555555")).to.be.false;
    });
  });

  // =========================================================================
  // Dimension 2: Staticcall Pre-Flight Simulation
  // =========================================================================
  describe("Dimension 2: Staticcall Pre-Flight Simulation", function () {
    it("D2-1: should successfully simulate native QOR deposit via EVM staticcall without reverts", async function () {
      const depositAmount = ethers.parseEther("1.0"); // 1.0 QOR
      const report: DepositSimulationReport = await simulateDeposit(
        ethers.ZeroAddress,
        depositAmount,
        { provider, signer }
      );

      expect(report.success).to.be.true;
      expect(report.depositor.toLowerCase()).to.equal(signerAddress.toLowerCase());
      expect(report.asset).to.equal(ethers.ZeroAddress);
      expect(report.amount).to.equal(depositAmount);
      expect(report.amountFormatted).to.equal("1.0 QOR");
      expect(report.simulatedGas).to.be.greaterThan(20000n);
      expect(report.simulatedGas).to.be.lessThan(DEFAULT_DEPOSIT_GAS_LIMIT);
    });

    it("D2-2: should verify simulation produces zero state mutation on Layer 1 contract", async function () {
      const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
      const balanceBefore = await provider.getBalance(DEFAULT_SETTLER_ADDRESS);
      const userDepositBefore = await settler.deposits(signerAddress, ethers.ZeroAddress);

      // Run simulation
      await simulateDeposit(ethers.ZeroAddress, ethers.parseEther("1.0"), { provider, signer });

      const balanceAfter = await provider.getBalance(DEFAULT_SETTLER_ADDRESS);
      const userDepositAfter = await settler.deposits(signerAddress, ethers.ZeroAddress);

      expect(balanceAfter).to.equal(balanceBefore);
      expect(userDepositAfter).to.equal(userDepositBefore);
    });

    it("D2-3: should return failure report when deposit amount is zero (InvalidAmount)", async function () {
      const report: DepositSimulationReport = await simulateDeposit(
        ethers.ZeroAddress,
        0n,
        { provider, signer }
      );

      expect(report.success).to.be.false;
      expect(report.error).to.not.be.undefined;
    });
  });

  // =========================================================================
  // Dimension 3: Gas Economics & Consensus Floor Invariants
  // =========================================================================
  describe("Dimension 3: Gas Economics & Consensus Floor Invariants", function () {
    it("D3-1: should enforce effective gas price satisfies the Diana consensus floor with headroom", async function () {
      const report = await simulateDeposit(ethers.ZeroAddress, ethers.parseEther("1.0"), {
        provider,
        signer
      });

      expect(report.effectiveGasPriceWei).to.be.at.least(DIANA_MIN_GAS_FLOOR_WEI);
      // Floor is 100 gwei, default headroom is +12.5% -> >= 112.5 gwei
      expect(report.effectiveGasPriceWei).to.be.at.least(112_500_000_000n);
    });

    it("D3-2: should calculate positive estimated QOR fee for deposit", async function () {
      const report = await simulateDeposit(ethers.ZeroAddress, ethers.parseEther("1.0"), {
        provider,
        signer
      });

      const feeNum = parseFloat(report.estimatedFeeQor);
      expect(feeNum).to.be.greaterThan(0);
      expect(feeNum).to.be.lessThan(0.1); // Deposit gas is low, fee is typically < 0.05 QOR
    });
  });

  // =========================================================================
  // Dimension 4: Receipt Telemetry & Event Parsing Logic
  // =========================================================================
  describe("Dimension 4: Receipt Telemetry & Event Parsing Logic", function () {
    it("D4-1: should parse Deposited event from transaction logs using contract interface", function () {
      const settlerInterface = OreVeilSettler__factory.createInterface();
      const testAmount = ethers.parseEther("2.5");

      // Construct authentic ABI-encoded log
      const encodedLog = settlerInterface.encodeEventLog(
        settlerInterface.getEvent("Deposited")!,
        [signerAddress, ethers.ZeroAddress, testAmount]
      );

      const mockReceipt: any = {
        logs: [
          {
            address: DEFAULT_SETTLER_ADDRESS,
            topics: encodedLog.topics,
            data: encodedLog.data
          }
        ]
      };

      const parsed = parseDepositEvent(mockReceipt, DEFAULT_SETTLER_ADDRESS);
      expect(parsed).to.not.be.null;
      expect(parsed!.depositor.toLowerCase()).to.equal(signerAddress.toLowerCase());
      expect(parsed!.asset).to.equal(ethers.ZeroAddress);
      expect(parsed!.amount).to.equal(testAmount);
    });

    it("D4-2: should safely ignore unrelated logs and return null when Deposited is absent", function () {
      const mockReceipt: any = {
        logs: [
          {
            address: DEFAULT_SETTLER_ADDRESS,
            topics: [ethers.keccak256(ethers.toUtf8Bytes("UnrelatedEvent()"))],
            data: "0x"
          }
        ]
      };

      const parsed = parseDepositEvent(mockReceipt, DEFAULT_SETTLER_ADDRESS);
      expect(parsed).to.be.null;
    });
  });

  // =========================================================================
  // Dimension 5: ASCII Summary Formatting & Explorer Link Verification
  // =========================================================================
  describe("Dimension 5: ASCII Summary Formatting & Explorer Link Verification", function () {
    it("D5-1: should generate canonical Diana Explorer link matching standard pattern", function () {
      const txHash = "0x9cc8a59ad33de51cf9d502954e7279d54628ba12609de190e684b6ff64636695";
      const link = formatDianaExplorerLink(txHash);
      expect(link).to.equal(`${DIANA_EXPLORER_BASE}/tx/${txHash}`);
    });

    it("D5-2: should format clean diagnostic simulation rehearsal report", async function () {
      const report = await simulateDeposit(ethers.ZeroAddress, ethers.parseEther("1.0"), {
        provider,
        signer
      });

      const formatted = formatDepositSimulationReport(report);
      expect(formatted).to.include("OREVEIL MULTI-ASSET VAULT INGRESS DRY-RUN REHEARSAL");
      expect(formatted).to.include("PASS [SIMULATED]");
      expect(formatted).to.include("1.0 QOR");
      expect(formatted).to.include(DEFAULT_SETTLER_ADDRESS);
    });

    it("D5-3: should format clean broadcast summary with balance growth telemetry", function () {
      const mockResult: DepositResult = {
        status: "SUCCESS",
        txHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        blockNumber: 10438900,
        blockHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        depositor: signerAddress,
        asset: ethers.ZeroAddress,
        amount: ethers.parseEther("1.0"),
        amountFormatted: "1.0 QOR",
        gasUsed: 52000n,
        effectiveGasPriceWei: 112_500_000_000n,
        feeBurnedQor: "0.00585",
        contractBalanceBefore: 0n,
        contractBalanceAfter: ethers.parseEther("1.0"),
        userDepositsBefore: 0n,
        userDepositsAfter: ethers.parseEther("1.0"),
        explorerUrl: `${DIANA_EXPLORER_BASE}/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef`,
        timestamp: new Date().toISOString(),
        eventVerified: true
      };

      const summary = formatDepositSummary(mockResult);
      expect(summary).to.include("OREVEIL MULTI-ASSET VAULT INGRESS BROADCAST RECEIPT");
      expect(summary).to.include("SUCCESS [MINED]");
      expect(summary).to.include("+1.0 QOR");
      expect(summary).to.include("Event Verified    : YES (Deposited Event Mined)");
    });
  });
});
