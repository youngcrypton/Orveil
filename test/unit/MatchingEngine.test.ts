import { expect } from "chai";
import { ethers } from "hardhat";
import * as crypto from "crypto";
import {
  calculateUniformClearingPrice,
  allocateFills,
  calculateQuoteAmount,
  getTokenDecimals,
  AccountLedger,
  buildWithdrawalTree,
  computeDataHash,
  executeBatchFBA,
  TradeFill,
  WithdrawalClaim
} from "../../sequencer/matchingEngine";
import {
  generateKemKeypair,
  sealOrder,
  unsealOrder,
  OrderParams
} from "../../client/orderClient";
import { OreVeilSettler } from "../../typechain-types";

describe("Sub-Phase 2.2: Frequent Batch Auction (FBA) Matching Engine & State Root Pipeline", function () {
  const NATIVE_QOR = ethers.ZeroAddress;
  const FUSD_ADDRESS = "0x1111111111111111111111111111111111111111";
  const FETH_ADDRESS = "0x2222222222222222222222222222222222222222";

  const trader1 = "0x7DE7d6CC73002f44A76334392555C9A4dDc0B561";
  const trader2 = "0x1111111111111111111111111111111111111111";
  const trader3 = "0x2222222222222222222222222222222222222222";
  const trader4 = "0x3333333333333333333333333333333333333333";

  // Fixed point 18-decimal price helper: 1 unit = 10^18
  const parsePrice = (p: string | number) => ethers.parseUnits(p.toString(), 18);

  describe("Layer 1: Core Economic & Mathematical Invariants", function () {
    it("should guarantee uniform clearing price P* across all executed fills", function () {
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n * 10n ** 6n, // 100 QOR
          limitPrice: parsePrice(12),
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n * 10n ** 6n, // 100 QOR
          limitPrice: parsePrice(10),
          nonce: 2,
          expiryBlock: 100
        },
        {
          trader: trader3,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 100n * 10n ** 6n, // 100 QOR
          limitPrice: parsePrice(8),
          nonce: 3,
          expiryBlock: 100
        },
        {
          trader: trader4,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 100n * 10n ** 6n, // 100 QOR
          limitPrice: parsePrice(10),
          nonce: 4,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      expect(clearingPrice).to.be.gt(0n);
      expect(maxVolume).to.equal(200n * 10n ** 6n); // 200 QOR can execute at P = 10

      const { fills } = allocateFills(orders, clearingPrice, maxVolume);
      expect(fills.length).to.equal(4);

      // Verify every single trade executed at the exact same uniform price
      for (const fill of fills) {
        expect(fill.clearingPrice).to.equal(clearingPrice);
      }
    });

    it("should maximize executed trade volume across candidate price levels", function () {
      // At price 10: Demand = 150, Supply = 150 -> Vol = 150
      // At price 12: Demand = 50, Supply = 150 -> Vol = 50
      // At price 8: Demand = 150, Supply = 50 -> Vol = 50
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 50n * 10n ** 6n,
          limitPrice: parsePrice(12),
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 2,
          expiryBlock: 100
        },
        {
          trader: trader3,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 50n * 10n ** 6n,
          limitPrice: parsePrice(8),
          nonce: 3,
          expiryBlock: 100
        },
        {
          trader: trader4,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 4,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      expect(clearingPrice).to.equal(parsePrice(10));
      expect(maxVolume).to.equal(150n * 10n ** 6n);
    });

    it("should resolve multiple volume-maximizing prices to the deterministic midpoint plateau (P_min + P_max) / 2", function () {
      // Buyer willing to buy at 20, seller willing to sell at 10.
      // Every price between 10 and 20 yields volume = 100.
      // Plateau min = 10, max = 20. Deterministic midpoint = (10 + 20) / 2 = 15.
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(20),
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 2,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      expect(maxVolume).to.equal(100n * 10n ** 6n);
      expect(clearingPrice).to.equal(parsePrice(15));
    });

    it("should strictly enforce buyer and seller limit prices (zero negative surplus)", function () {
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(14),
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(8),
          nonce: 2,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      const { fills } = allocateFills(orders, clearingPrice, maxVolume);

      for (const fill of fills) {
        if (fill.side === "BUY") {
          expect(fill.clearingPrice).to.be.lte(parsePrice(14));
        } else {
          expect(fill.clearingPrice).to.be.gte(parsePrice(8));
        }
      }
    });

    it("should enforce exact conservation of token value (zero wei leakage) for base and quote assets", function () {
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 333333333n, // 333.333333 QOR
          limitPrice: parsePrice(3.141592),
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 333333333n,
          limitPrice: parsePrice(3.141592),
          nonce: 2,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      const { fills } = allocateFills(orders, clearingPrice, maxVolume);

      const buyFills = fills.filter((f) => f.side === "BUY");
      const sellFills = fills.filter((f) => f.side === "SELL");

      const totalBaseBought = buyFills.reduce((acc, f) => acc + f.baseAmountFilled, 0n);
      const totalBaseSold = sellFills.reduce((acc, f) => acc + f.baseAmountFilled, 0n);
      expect(totalBaseBought).to.equal(totalBaseSold);

      const totalQuotePaid = buyFills.reduce((acc, f) => acc + f.quoteAmountFilled, 0n);
      const totalQuoteReceived = sellFills.reduce((acc, f) => acc + f.quoteAmountFilled, 0n);
      expect(totalQuotePaid).to.equal(totalQuoteReceived);
    });
  });

  describe("Layer 2: Edge Cases & Boundary Conditions", function () {
    it("should clear zero volume for non-crossing orderbooks (highest bid < lowest ask)", function () {
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(9), // Bid 9
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(11), // Ask 11
          nonce: 2,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      expect(clearingPrice).to.equal(0n);
      expect(maxVolume).to.equal(0n);

      const { fills, unfilledOrders } = allocateFills(orders, clearingPrice, maxVolume);
      expect(fills.length).to.equal(0);
      expect(unfilledOrders.length).to.equal(2);
    });

    it("should clear zero volume when orderbook is one-sided (bids only or asks only)", function () {
      const bidsOnly: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 1,
          expiryBlock: 100
        }
      ];

      const resultBids = calculateUniformClearingPrice(bidsOnly);
      expect(resultBids.clearingPrice).to.equal(0n);
      expect(resultBids.maxVolume).to.equal(0n);

      const asksOnly: OrderParams[] = [
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 2,
          expiryBlock: 100
        }
      ];

      const resultAsks = calculateUniformClearingPrice(asksOnly);
      expect(resultAsks.clearingPrice).to.equal(0n);
      expect(resultAsks.maxVolume).to.equal(0n);
    });

    it("should handle completely empty auction epoch (0 orders) without reverting", function () {
      const emptyResult = calculateUniformClearingPrice([]);
      expect(emptyResult.clearingPrice).to.equal(0n);
      expect(emptyResult.maxVolume).to.equal(0n);

      const { fills, unfilledOrders } = allocateFills([], 0n, 0n);
      expect(fills.length).to.equal(0);
      expect(unfilledOrders.length).to.equal(0);
    });

    it("should correctly execute a single exact match (1 buyer at P, 1 seller at P)", function () {
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 50n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 50n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 2,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      expect(clearingPrice).to.equal(parsePrice(10));
      expect(maxVolume).to.equal(50n * 10n ** 6n);

      const { fills, unfilledOrders } = allocateFills(orders, clearingPrice, maxVolume);
      expect(fills.length).to.equal(2);
      expect(unfilledOrders.length).to.equal(0);
      expect(fills[0].baseAmountFilled).to.equal(50n * 10n ** 6n);
      expect(fills[1].baseAmountFilled).to.equal(50n * 10n ** 6n);
    });

    it("should filter out non-positive order amounts", function () {
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 0n,
          limitPrice: parsePrice(10),
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 2,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      expect(clearingPrice).to.equal(0n);
      expect(maxVolume).to.equal(0n);
    });
  });

  describe("Layer 3: Pro-Rata Marginal Fairness & Remainder Allocation", function () {
    it("should fill inframarginal orders 100% before allocating to marginal orders", function () {
      // Buyer 1 bids 15 (inframarginal) for 100
      // Buyer 2 bids 10 (marginal) for 100
      // Seller 1 asks 10 (marginal) for 150
      // Clearing price = 10, max volume = 150
      // Buyer 1 gets 100% (100)
      // Buyer 2 gets remaining 50
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(15),
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 2,
          expiryBlock: 100
        },
        {
          trader: trader3,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 150n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 3,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      expect(clearingPrice).to.equal(parsePrice(10));
      expect(maxVolume).to.equal(150n * 10n ** 6n);

      const { fills, unfilledOrders } = allocateFills(orders, clearingPrice, maxVolume);
      const b1Fill = fills.find((f) => f.trader === trader1);
      const b2Fill = fills.find((f) => f.trader === trader2);

      expect(b1Fill?.baseAmountFilled).to.equal(100n * 10n ** 6n); // 100% filled
      expect(b2Fill?.baseAmountFilled).to.equal(50n * 10n ** 6n); // 50% marginal fill

      // Unfilled order has remaining 50
      const b2Unfilled = unfilledOrders.find((o) => o.trader === trader2);
      expect(b2Unfilled?.amount).to.equal(50n * 10n ** 6n);
    });

    it("should fairly divide marginal volume pro-rata among multiple competing marginal buyers", function () {
      // Buyer A bids 10 for 200 units
      // Buyer B bids 10 for 100 units
      // Seller offers 150 units at 10
      // Buyer A gets (200 * 150) / 300 = 100 units
      // Buyer B gets (100 * 150) / 300 = 50 units
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 200n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 2,
          expiryBlock: 100
        },
        {
          trader: trader3,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 150n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 3,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      const { fills } = allocateFills(orders, clearingPrice, maxVolume);

      const fillA = fills.find((f) => f.trader === trader1);
      const fillB = fills.find((f) => f.trader === trader2);

      expect(fillA?.baseAmountFilled).to.equal(100n * 10n ** 6n);
      expect(fillB?.baseAmountFilled).to.equal(50n * 10n ** 6n);
    });

    it("should fairly divide marginal volume pro-rata among multiple competing marginal sellers", function () {
      // Seller A offers 300 units at 10
      // Seller B offers 100 units at 10
      // Buyer bids for 200 units at 10
      // Total seller supply = 400
      // Seller A gets (300 * 200) / 400 = 150 units
      // Seller B gets (100 * 200) / 400 = 50 units
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 200n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 300n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 2,
          expiryBlock: 100
        },
        {
          trader: trader3,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 100n * 10n ** 6n,
          limitPrice: parsePrice(10),
          nonce: 3,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      const { fills } = allocateFills(orders, clearingPrice, maxVolume);

      const fillA = fills.find((f) => f.trader === trader2);
      const fillB = fills.find((f) => f.trader === trader3);

      expect(fillA?.baseAmountFilled).to.equal(150n * 10n ** 6n);
      expect(fillB?.baseAmountFilled).to.equal(50n * 10n ** 6n);
    });

    it("should deterministically assign integer division remainder to first marginal order", function () {
      // 3 marginal buyers wanting 100 each (total 300).
      // Available sell volume = 100.
      // Pro-rata: 100 * 100 / 300 = 33 units each. Sum = 99. Remainder = 1.
      // First marginal order must get 33 + 1 = 34. Total filled = 100.
      const orders: OrderParams[] = [
        {
          trader: trader1,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n,
          limitPrice: parsePrice(10),
          nonce: 1,
          expiryBlock: 100
        },
        {
          trader: trader2,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n,
          limitPrice: parsePrice(10),
          nonce: 2,
          expiryBlock: 100
        },
        {
          trader: trader3,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "BUY",
          amount: 100n,
          limitPrice: parsePrice(10),
          nonce: 3,
          expiryBlock: 100
        },
        {
          trader: trader4,
          baseToken: NATIVE_QOR,
          quoteToken: FUSD_ADDRESS,
          side: "SELL",
          amount: 100n,
          limitPrice: parsePrice(10),
          nonce: 4,
          expiryBlock: 100
        }
      ];

      const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);
      expect(maxVolume).to.equal(100n);

      const { fills } = allocateFills(orders, clearingPrice, maxVolume);
      const buyFills = fills.filter((f) => f.side === "BUY");
      const totalBuyFilled = buyFills.reduce((acc, f) => acc + f.baseAmountFilled, 0n);

      expect(totalBuyFilled).to.equal(100n);
      expect(buyFills[0].baseAmountFilled).to.equal(34n);
      expect(buyFills[1].baseAmountFilled).to.equal(33n);
      expect(buyFills[2].baseAmountFilled).to.equal(33n);
    });
  });

  describe("Layer 4: Heterogeneous Token Decimals & Scale Invariants", function () {
    it("should identify token decimals accurately (6 for QOR, 18 for ERC-20)", function () {
      expect(getTokenDecimals(NATIVE_QOR)).to.equal(6);
      expect(getTokenDecimals(FUSD_ADDRESS)).to.equal(18);
      expect(getTokenDecimals(FETH_ADDRESS)).to.equal(18);
    });

    it("should scale Native QOR (6 decimals) base token against ERC-20 (18 decimals) quote token", function () {
      // 10 QOR = 10,000,000 uqor (6 decimals)
      // Price = 2.50 fUSD per QOR (18 decimals)
      // Expected quoteAmount = 25 * 10^18 fUSD wei
      const baseAmount = 10n * 10n ** 6n;
      const price = parsePrice(2.5);
      const quoteAmount = calculateQuoteAmount(baseAmount, price, NATIVE_QOR, FUSD_ADDRESS);

      expect(quoteAmount).to.equal(ethers.parseEther("25.0"));
    });

    it("should scale ERC-20 (18 decimals) base token against ERC-20 (18 decimals) quote token", function () {
      // 1 fETH = 10^18 wei
      // Price = 3,000 fUSD (18 decimals)
      // Expected quoteAmount = 3,000 * 10^18 wei
      const baseAmount = ethers.parseEther("1.0");
      const price = parsePrice(3000);
      const quoteAmount = calculateQuoteAmount(baseAmount, price, FETH_ADDRESS, FUSD_ADDRESS);

      expect(quoteAmount).to.equal(ethers.parseUnits("3000", 18));
    });

    it("should handle extreme token values up to 10^24 wei without precision loss", function () {
      // 1,000,000 fETH = 10^24 wei
      // Price = 3,250.75 fUSD
      const baseAmount = 10n ** 24n;
      const price = parsePrice("3250.75");
      const quoteAmount = calculateQuoteAmount(baseAmount, price, FETH_ADDRESS, FUSD_ADDRESS);

      // Expected = 10^24 * 3250.75 = 3.25075 * 10^27
      const expected = (10n ** 24n * parsePrice("3250.75")) / 10n ** 18n;
      expect(quoteAmount).to.equal(expected);
    });
  });

  describe("Layer 5: End-to-End Cryptographic State & Settler Proof Integration", function () {
    let settler: OreVeilSettler;
    let owner: any;
    let recipientSigner: any;
    let sequencerKeypair: { publicKey: Uint8Array; secretKey: Uint8Array };
    const validPubKey = "0x" + crypto.randomBytes(2592).toString("hex");
    const validSig = "0x" + crypto.randomBytes(4627).toString("hex");
    const PQC_PRECOMPILE = "0x0000000000000000000000000000000000000a01";
    const BYTECODE_RETURN_TRUE = "0x600160005260206000f3"; // PUSH1 0x01, PUSH1 0x00, MSTORE, PUSH1 0x20, PUSH1 0x00, RETURN (true)

    beforeEach(async function () {
      [owner, recipientSigner] = await ethers.getSigners();
      sequencerKeypair = generateKemKeypair();

      // Deploy OreVeilSettler for L1 proof validation
      const OreVeilSettlerFactory = await ethers.getContractFactory("OreVeilSettler");
      settler = (await OreVeilSettlerFactory.deploy(owner.address, validPubKey)) as OreVeilSettler;
      await settler.waitForDeployment();

      // Configure precompile mock on local Hardhat EVM to return true
      await ethers.provider.send("hardhat_setCode", [PQC_PRECOMPILE, BYTECODE_RETURN_TRUE]);
    });

    it("should execute end-to-end confidential pipeline: sealOrder -> unsealOrder -> executeBatchFBA -> update ledger", function () {
      const ledger = new AccountLedger();

      // 1. Initial State: Fund trader1 with 1,000 fUSD and trader2 with 100 QOR
      ledger.credit(trader1, FUSD_ADDRESS, ethers.parseEther("1000.0"));
      ledger.credit(trader2, NATIVE_QOR, 100n * 10n ** 6n);
      const initialRoot = ledger.computeStateRoot();
      expect(initialRoot).to.not.equal(ethers.ZeroHash);

      // 2. Client Side: Trader 1 seals BUY order (wants 100 QOR @ 5 fUSD max)
      const buyParams: OrderParams = {
        trader: trader1,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_ADDRESS,
        side: "BUY",
        amount: 100n * 10n ** 6n,
        limitPrice: parsePrice(5),
        nonce: 1,
        expiryBlock: 1000
      };
      const sealedBuy = sealOrder(buyParams, sequencerKeypair.publicKey, 1, 9800);

      // 3. Client Side: Trader 2 seals SELL order (offers 100 QOR @ 5 fUSD min)
      const sellParams: OrderParams = {
        trader: trader2,
        baseToken: NATIVE_QOR,
        quoteToken: FUSD_ADDRESS,
        side: "SELL",
        amount: 100n * 10n ** 6n,
        limitPrice: parsePrice(5),
        nonce: 2,
        expiryBlock: 1000
      };
      const sealedSell = sealOrder(sellParams, sequencerKeypair.publicKey, 1, 9800);

      // 4. Sequencer Side: Unseal orders using secret key
      const unsealedBuy = unsealOrder(sealedBuy, sequencerKeypair.secretKey);
      const unsealedSell = unsealOrder(sealedSell, sequencerKeypair.secretKey);

      // 5. Sequencer Side: Execute batch
      const result = executeBatchFBA(1, 1, [unsealedBuy, unsealedSell], ledger, [], 9800);

      expect(result.clearingPrice).to.equal(parsePrice(5));
      expect(result.totalVolume).to.equal(100n * 10n ** 6n);
      expect(result.fills.length).to.equal(2);
      expect(result.prevStateRoot).to.equal(initialRoot);
      expect(result.newStateRoot).to.not.equal(initialRoot);
      expect(result.dataHash).to.not.equal(ethers.ZeroHash);

      // 6. Verify Post-Trade Balances:
      // Trader 1 paid 500 fUSD (100 * 5) and received 100 QOR
      expect(ledger.getBalance(trader1, FUSD_ADDRESS)).to.equal(ethers.parseEther("500.0"));
      expect(ledger.getBalance(trader1, NATIVE_QOR)).to.equal(100n * 10n ** 6n);

      // Trader 2 sold 100 QOR and received 500 fUSD
      expect(ledger.getBalance(trader2, NATIVE_QOR)).to.equal(0n);
      expect(ledger.getBalance(trader2, FUSD_ADDRESS)).to.equal(ethers.parseEther("500.0"));
    });

    it("should generate valid L1 withdrawal Merkle tree verifiable on-chain by OreVeilSettler contract", async function () {
      const ledger = new AccountLedger();
      const recipient = recipientSigner.address;
      const withdrawalAmount = ethers.parseEther("5.0");

      // Fund contract with native QOR for withdrawals
      await owner.sendTransaction({
        to: await settler.getAddress(),
        value: ethers.parseEther("10.0")
      });

      // Credit recipient and trader2 on L2 ledger
      ledger.credit(recipient, NATIVE_QOR, withdrawalAmount);
      ledger.credit(trader2, NATIVE_QOR, ethers.parseEther("1.0"));
      const genesisStateRoot = ledger.computeStateRoot();

      // Settle genesis batch 1 to initialize latestStateRoot on settler
      await settler.settleBatch(
        1n,
        ethers.ZeroHash,
        genesisStateRoot,
        ethers.ZeroHash,
        ethers.ZeroHash,
        validSig
      );

      // Create withdrawal claim
      const withdrawals: WithdrawalClaim[] = [
        {
          index: 0,
          recipient,
          asset: NATIVE_QOR,
          amount: withdrawalAmount
        },
        {
          index: 1,
          recipient: trader2,
          asset: NATIVE_QOR,
          amount: ethers.parseEther("1.0")
        }
      ];

      const currentChainId = Number((await ethers.provider.getNetwork()).chainId);

      // Execute batch 2 with withdrawal
      const batchResult = executeBatchFBA(2, 2, [], ledger, withdrawals, currentChainId);
      expect(batchResult.withdrawalRoot).to.not.equal(ethers.ZeroHash);

      // Settle batch 2 on L1 Settler contract
      await settler.settleBatch(
        2n,
        genesisStateRoot,
        batchResult.newStateRoot,
        batchResult.withdrawalRoot,
        batchResult.dataHash,
        validSig
      );

      // Get Merkle proof for recipient (index 0)
      const { getProof } = buildWithdrawalTree(withdrawals, currentChainId);
      const proof = getProof(0);

      // Execute withdrawal on-chain for batch 2
      const balanceBefore = await ethers.provider.getBalance(recipient);
      await expect(
        settler.executeWithdrawal(2n, 0n, recipient, NATIVE_QOR, withdrawalAmount, proof)
      )
        .to.emit(settler, "WithdrawalExecuted")
        .withArgs(2n, 0n, recipient, NATIVE_QOR, withdrawalAmount);

      const balanceAfter = await ethers.provider.getBalance(recipient);
      expect(balanceAfter - balanceBefore).to.equal(withdrawalAmount);
    });

    it("should execute 50-epoch randomized fuzzing stress test without balance underflows or invariant violations", function () {
      const ledger = new AccountLedger();
      const traders = [trader1, trader2, trader3, trader4];

      // Pre-fund all traders with massive balances to support 50 epochs of trading
      for (const t of traders) {
        ledger.credit(t, NATIVE_QOR, 10_000_000n * 10n ** 6n); // 10M QOR
        ledger.credit(t, FUSD_ADDRESS, ethers.parseEther("100000000.0")); // 100M fUSD
      }

      for (let epoch = 1; epoch <= 50; epoch++) {
        const orderCount = 10 + (epoch % 15);
        const orders: OrderParams[] = [];

        for (let i = 0; i < orderCount; i++) {
          const t = traders[i % traders.length];
          const isBuy = (i + epoch) % 2 === 0;
          // Random price between 5 and 15
          const priceNum = 5 + ((epoch * 17 + i * 31) % 11);
          // Random amount between 10 and 100 QOR
          const amountNum = 10 + ((epoch * 13 + i * 7) % 91);

          orders.push({
            trader: t,
            baseToken: NATIVE_QOR,
            quoteToken: FUSD_ADDRESS,
            side: isBuy ? "BUY" : "SELL",
            amount: BigInt(amountNum) * 10n ** 6n,
            limitPrice: parsePrice(priceNum),
            nonce: epoch * 100 + i,
            expiryBlock: 10000
          });
        }

        const result = executeBatchFBA(epoch, epoch, orders, ledger, [], 9800);

        // Invariant 1: Uniform price on all fills
        for (const fill of result.fills) {
          expect(fill.clearingPrice).to.equal(result.clearingPrice);
        }

        // Invariant 2: Limit price enforcement
        for (const fill of result.fills) {
          const nonce = Number(fill.orderId.split("-").pop());
          const original = orders.find((o) => o.nonce === nonce);
          expect(original).to.not.be.undefined;
          if (fill.side === "BUY") {
            expect(fill.clearingPrice).to.be.lte(original!.limitPrice);
          } else {
            expect(fill.clearingPrice).to.be.gte(original!.limitPrice);
          }
        }

        // Invariant 3: Conservation of value
        const buyFills = result.fills.filter((f) => f.side === "BUY");
        const sellFills = result.fills.filter((f) => f.side === "SELL");
        const baseBought = buyFills.reduce((acc, f) => acc + f.baseAmountFilled, 0n);
        const baseSold = sellFills.reduce((acc, f) => acc + f.baseAmountFilled, 0n);
        expect(baseBought).to.equal(baseSold);

        const quotePaid = buyFills.reduce((acc, f) => acc + f.quoteAmountFilled, 0n);
        const quoteRecv = sellFills.reduce((acc, f) => acc + f.quoteAmountFilled, 0n);
        expect(quotePaid).to.equal(quoteRecv);

        // Invariant 4: No balances went negative in ledger
        for (const t of traders) {
          expect(ledger.getBalance(t, NATIVE_QOR)).to.be.gte(0n);
          expect(ledger.getBalance(t, FUSD_ADDRESS)).to.be.gte(0n);
        }
      }
    });
  });
});
