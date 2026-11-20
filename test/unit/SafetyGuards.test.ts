import { expect } from "chai";
import { ethers } from "hardhat";
import {
  estimateCompliantGasPrice,
  queryEvmWindowStatus,
  decorateTransaction,
  formatSafetyReport,
  DIANA_CHAIN_ID,
  DIANA_MIN_GAS_FLOOR_WEI,
  DEFAULT_DEPLOYER_COSMOS,
  DEFAULT_SETTLE_BATCH_GAS_LIMIT,
  GasConfig,
  EvmWindowReport
} from "../../scripts/lib/safetyGuards";

describe("Sub-Phase 3.1 Layer 3: Diana Gas Floor & EVM Authorization Window Safety Guards", function () {
  this.timeout(30000);

  describe("Suite 1: Diana Gas Floor & Headroom Arithmetic", function () {
    it("should enforce strict 100 gwei floor even if provider reports sub-floor gas", async function () {
      // Create a mock provider returning sub-floor gas price (1 gwei)
      const mockLowGasProvider = {
        getFeeData: async () => ({
          gasPrice: 1_000_000_000n, // 1 gwei
          maxFeePerGas: null,
          maxPriorityFeePerGas: null
        })
      } as any;

      const gasConfig = await estimateCompliantGasPrice(mockLowGasProvider, {
        headroomPercent: 0
      });

      expect(gasConfig.minGasFloorWei).to.equal(DIANA_MIN_GAS_FLOOR_WEI);
      expect(gasConfig.effectiveGasPriceWei).to.be.greaterThanOrEqual(DIANA_MIN_GAS_FLOOR_WEI);
      expect(gasConfig.effectiveGasPriceWei).to.equal(DIANA_MIN_GAS_FLOOR_WEI);
    });

    it("should calculate exact headroom percentages above minimum floor", async function () {
      const mockProvider = {
        getFeeData: async () => ({
          gasPrice: DIANA_MIN_GAS_FLOOR_WEI,
          maxFeePerGas: null,
          maxPriorityFeePerGas: null
        })
      } as any;

      // 0% headroom -> 100 gwei
      const gas0 = await estimateCompliantGasPrice(mockProvider, { headroomPercent: 0 });
      expect(gas0.effectiveGasPriceWei).to.equal(100_000_000_000n);

      // 10% headroom -> 110 gwei
      const gas10 = await estimateCompliantGasPrice(mockProvider, { headroomPercent: 10 });
      expect(gas10.effectiveGasPriceWei).to.equal(110_000_000_000n);

      // 12.5% headroom -> 112.5 gwei
      const gas12_5 = await estimateCompliantGasPrice(mockProvider, { headroomPercent: 12.5 });
      expect(gas12_5.effectiveGasPriceWei).to.equal(112_500_000_000n);

      // 20% headroom -> 120 gwei
      const gas20 = await estimateCompliantGasPrice(mockProvider, { headroomPercent: 20 });
      expect(gas20.effectiveGasPriceWei).to.equal(120_000_000_000n);
    });

    it("should gracefully fall back to 100 gwei floor if getFeeData throws", async function () {
      const mockErrorProvider = {
        getFeeData: async () => {
          throw new Error("RPC socket hang up");
        }
      } as any;

      const gas = await estimateCompliantGasPrice(mockErrorProvider, { headroomPercent: 0 });
      expect(gas.effectiveGasPriceWei).to.equal(DIANA_MIN_GAS_FLOOR_WEI);
    });
  });

  describe("Suite 2: Transaction Request Decoration", function () {
    it("should decorate empty transaction request with compliant Diana parameters", async function () {
      const mockProvider = {
        getFeeData: async () => ({
          gasPrice: DIANA_MIN_GAS_FLOOR_WEI,
          maxFeePerGas: null,
          maxPriorityFeePerGas: null
        }),
        estimateGas: async () => 2_500_000n
      } as any;

      const rawTx: ethers.TransactionRequest = {
        to: "0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44",
        data: "0x1234"
      };

      const decorated = await decorateTransaction(rawTx, mockProvider, {
        headroomPercent: 10
      });

      expect(decorated.chainId).to.equal(DIANA_CHAIN_ID);
      expect(decorated.gasPrice).to.equal(110_000_000_000n);
      // Estimated 2.5M + 20% buffer = 3.0M
      expect(decorated.gasLimit).to.equal(3_000_000n);
      expect(decorated.to).to.equal(rawTx.to);
    });

    it("should preserve custom gasLimit when caller explicitly specifies one", async function () {
      const mockProvider = {
        getFeeData: async () => ({
          gasPrice: DIANA_MIN_GAS_FLOOR_WEI,
          maxFeePerGas: null,
          maxPriorityFeePerGas: null
        })
      } as any;

      const rawTx: ethers.TransactionRequest = {
        to: "0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44",
        gasLimit: 4_000_000n
      };

      const decorated = await decorateTransaction(rawTx, mockProvider);
      expect(decorated.gasLimit).to.equal(4_000_000n);
    });

    it("should fall back to default settle batch gas limit if gas estimation fails", async function () {
      const mockProvider = {
        getFeeData: async () => ({
          gasPrice: DIANA_MIN_GAS_FLOOR_WEI,
          maxFeePerGas: null,
          maxPriorityFeePerGas: null
        }),
        estimateGas: async () => {
          throw new Error("Execution reverted during simulation");
        }
      } as any;

      const rawTx: ethers.TransactionRequest = {
        to: "0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44"
      };

      const decorated = await decorateTransaction(rawTx, mockProvider);
      expect(decorated.gasLimit).to.equal(DEFAULT_SETTLE_BATCH_GAS_LIMIT);
    });
  });

  describe("Suite 3: Live Diana EVM Authorization Window Audit (Zero Mocks)", function () {
    let report: EvmWindowReport;

    before(async function () {
      report = await queryEvmWindowStatus({ address: DEFAULT_DEPLOYER_COSMOS });
    });

    it("should query live Diana Testnet REST and retrieve deployer window record", function () {
      expect(report.address).to.equal(DEFAULT_DEPLOYER_COSMOS);
      expect(report.found).to.be.true;
    });

    it("should report exact historical block parameters from Sub-Phase 1.2 window", function () {
      expect(report.openedHeight).to.equal(10323254n);
      expect(report.expiryHeight).to.equal(10338254n);
      expect(report.expiryHeight - report.openedHeight).to.equal(15000n); // 15,000 blocks window
      expect(report.remainingBlocks).to.equal(0n);
      expect(report.live).to.be.false;
      expect(report.statusText).to.include("EXPIRED");
    });

    it("should format clean human-readable safety report", async function () {
      const gasConfig: GasConfig = {
        minGasFloorWei: DIANA_MIN_GAS_FLOOR_WEI,
        recommendedGasPriceWei: 115_000_000_000n,
        effectiveGasPriceWei: 112_500_000_000n,
        headroomPercent: 12.5,
        gasPriceGwei: "112.5"
      };

      const formatted = formatSafetyReport(gasConfig, report);
      expect(formatted).to.include("OreVeil Diana Gas & EVM Window Safety Guard Report");
      expect(formatted).to.include("9800");
      expect(formatted).to.include("100.0 gwei");
      expect(formatted).to.include("112.5 gwei");
      expect(formatted).to.include(DEFAULT_DEPLOYER_COSMOS);
    });

    it("should handle invalid or unrecorded Cosmos address gracefully without throwing", async function () {
      const randomCosmos = "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqyryqwh";
      const badReport = await queryEvmWindowStatus({ address: randomCosmos });
      expect(badReport.found).to.be.false;
      expect(badReport.live).to.be.false;
      expect(badReport.statusText).to.equal("NO_RECORD_FOUND");
    });
  });
});
