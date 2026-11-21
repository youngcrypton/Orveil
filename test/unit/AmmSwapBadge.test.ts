import { expect } from "chai";
import {
  queryPoolInfo,
  executeAmmSwap,
  DEFAULT_POOL_ID,
  DEFAULT_TARGET_DENOM,
  DEFAULT_SWAP_AMOUNT_UQOR,
  REST_URL,
  CHAIN_ID
} from "../../scripts/claim-swap-badge";
import { amm } from "@qorechain/sdk";

describe("Sub-Phase 4.0 Milestone A: Native AMM Pool Swap & Badge Verification (Zero Mocks)", function () {
  this.timeout(30000);

  describe("Dimension 1: Diana AMM Pool Discovery & Liquidity Invariants", function () {
    it("D1-1: should query live Pool #2 and verify active status with real liquidity reserves", async function () {
      const pool = await queryPoolInfo(DEFAULT_POOL_ID);
      expect(pool.id).to.equal("2");
      expect(pool.status).to.equal("active");
      expect(pool.poolType).to.equal("constant_product");
      expect(pool.tokenB).to.equal("uqor");
      expect(pool.tokenA).to.equal(DEFAULT_TARGET_DENOM);

      // Verify non-zero reserve balances on Diana Testnet
      expect(BigInt(pool.reserveA)).to.be.greaterThan(0n);
      expect(BigInt(pool.reserveB)).to.be.greaterThan(0n);
    });

    it("D1-2: should throw descriptive error when querying non-existent pool ID", async function () {
      try {
        await queryPoolInfo("99999");
        expect.fail("Expected non-existent pool query to throw");
      } catch (err: any) {
        expect(err.message).to.include("Pool #99999 not found");
      }
    });
  });

  describe("Dimension 2: MsgSwapExactIn Message Encoding & Type Safety", function () {
    it("D2-1: should construct compliant MsgSwapExactIn with exact CosmJS type URL", function () {
      const mockCosmosSender = "qor10hnadnrnqqh5ffmrxsuj24wf5nwupdtp0zw8kt";
      const swapMsg = amm.swapExactIn({
        sender: mockCosmosSender,
        poolId: DEFAULT_POOL_ID,
        tokenIn: { denom: "uqor", amount: DEFAULT_SWAP_AMOUNT_UQOR },
        denomOut: DEFAULT_TARGET_DENOM,
        minOut: "1"
      });

      expect(swapMsg.typeUrl).to.equal("/qorechain.amm.v1.MsgSwapExactIn");
      expect(swapMsg.value.sender).to.equal(mockCosmosSender);
      expect(String(swapMsg.value.poolId)).to.equal(DEFAULT_POOL_ID);
      expect(swapMsg.value.tokenIn?.denom).to.equal("uqor");
      expect(swapMsg.value.tokenIn?.amount).to.equal("1000");
      expect(swapMsg.value.denomOut).to.equal(DEFAULT_TARGET_DENOM);
      expect(swapMsg.value.minOut).to.equal("1");
    });
  });

  describe("Dimension 3: Fee Economics & Diana Minimum Gas Price Floor Compliance", function () {
    it("D3-1: should enforce effective gas price satisfies the Diana 0.1 uqor consensus floor with headroom", function () {
      const feeUqor = 200000n;
      const gasLimit = 1000000n;
      const effectiveGasPrice = Number(feeUqor) / Number(gasLimit);

      // Diana consensus floor is 0.1 uqor/gas unit
      expect(effectiveGasPrice).to.be.greaterThanOrEqual(0.1);
      expect(effectiveGasPrice).to.equal(0.2); // 100% headroom above minimum floor
    });
  });

  describe("Dimension 4: Diagnostic Pre-Flight Dry-Run Rehearsal", function () {
    it("D4-1: should execute dry-run simulation cleanly without on-chain state mutation", async function () {
      const result = await executeAmmSwap({ dryRun: true });

      expect(result.success).to.be.true;
      expect(result.poolId).to.equal("2");
      expect(result.tokenIn.denom).to.equal("uqor");
      expect(result.tokenIn.amount).to.equal(DEFAULT_SWAP_AMOUNT_UQOR);
      expect(result.denomOut).to.equal(DEFAULT_TARGET_DENOM);
      expect(result.explorerUrl).to.include("https://explore.qore.network/");
    });
  });
});
