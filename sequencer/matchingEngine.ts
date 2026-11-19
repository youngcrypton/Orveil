import { ethers } from "ethers";
import { OrderParams, OrderSide } from "../client/orderClient";

export interface TradeFill {
  orderId: string;
  trader: string;
  side: OrderSide;
  baseToken: string;
  quoteToken: string;
  baseAmountFilled: bigint;
  quoteAmountFilled: bigint;
  clearingPrice: bigint; // 18 decimals fixed point
  feeAmount: bigint;
}

export interface WithdrawalClaim {
  index: number;
  recipient: string;
  asset: string;
  amount: bigint;
}

export interface BatchExecutionResult {
  batchId: number;
  epochId: number;
  clearingPrice: bigint;
  totalVolume: bigint;
  fills: TradeFill[];
  prevStateRoot: string;
  newStateRoot: string;
  withdrawalRoot: string;
  dataHash: string;
  unfilledOrders: OrderParams[];
}

/**
 * Standard Merkle Tree implementation using commutative pair hashing.
 * Matches OpenZeppelin MerkleProof.sol: hash(min(a, b), max(a, b)).
 */
export function hashPair(a: string, b: string): string {
  const aBig = BigInt(a);
  const bBig = BigInt(b);
  return aBig < bBig
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

export class MerkleTree {
  public leaves: string[];
  public layers: string[][];

  constructor(leaves: string[]) {
    this.leaves = leaves.map((l) => (l.startsWith("0x") ? l : "0x" + l));
    this.layers = [];
    this.buildTree();
  }

  private buildTree(): void {
    if (this.leaves.length === 0) {
      this.layers = [[]];
      return;
    }
    this.layers = [this.leaves];
    while (this.layers[this.layers.length - 1].length > 1) {
      const current = this.layers[this.layers.length - 1];
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          next.push(hashPair(current[i], current[i + 1]));
        } else {
          next.push(current[i]);
        }
      }
      this.layers.push(next);
    }
  }

  public getRoot(): string {
    if (this.leaves.length === 0) return ethers.ZeroHash;
    return this.layers[this.layers.length - 1][0];
  }

  public getProof(index: number): string[] {
    const proof: string[] = [];
    let idx = index;
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx]);
      }
      idx = Math.floor(idx / 2);
    }
    return proof;
  }
}

/**
 * Determine token decimal places:
 * - Native QOR (address(0)): 6 decimals
 * - ERC-20 test tokens (fUSD, fETH, fBTC): 18 decimals
 */
export function getTokenDecimals(tokenAddress: string): number {
  if (tokenAddress.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    return 6;
  }
  return 18;
}

/**
 * Scale token amount to quote token currency using 18-decimal fixed-point price.
 * quoteAmount = (baseAmount * clearingPrice * 10^quoteDecimals) / (10^baseDecimals * 10^18)
 */
export function calculateQuoteAmount(
  baseAmount: bigint,
  clearingPrice: bigint,
  baseToken: string,
  quoteToken: string
): bigint {
  const baseDec = BigInt(getTokenDecimals(baseToken));
  const quoteDec = BigInt(getTokenDecimals(quoteToken));
  const numerator = baseAmount * clearingPrice * 10n ** quoteDec;
  const denominator = 10n ** baseDec * 10n ** 18n;
  return numerator / denominator;
}

/**
 * In-memory state tracking balances for (trader, asset) => balance
 */
export class AccountLedger {
  private balances: Map<string, bigint> = new Map();

  private makeKey(trader: string, asset: string): string {
    return `${trader.toLowerCase()}:${asset.toLowerCase()}`;
  }

  public getBalance(trader: string, asset: string): bigint {
    return this.balances.get(this.makeKey(trader, asset)) ?? 0n;
  }

  public credit(trader: string, asset: string, amount: bigint): void {
    const current = this.getBalance(trader, asset);
    this.balances.set(this.makeKey(trader, asset), current + amount);
  }

  public debit(trader: string, asset: string, amount: bigint): void {
    const current = this.getBalance(trader, asset);
    if (current < amount) {
      throw new Error(
        `Insufficient balance: trader ${trader} has ${current} of ${asset}, cannot debit ${amount}`
      );
    }
    this.balances.set(this.makeKey(trader, asset), current - amount);
  }

  public getAllAccounts(): { trader: string; asset: string; balance: bigint }[] {
    const result: { trader: string; asset: string; balance: bigint }[] = [];
    for (const [key, balance] of this.balances.entries()) {
      const [trader, asset] = key.split(":");
      result.push({ trader, asset, balance });
    }
    // Sort deterministically by trader then asset
    result.sort((a, b) => {
      const comp = a.trader.localeCompare(b.trader);
      if (comp !== 0) return comp;
      return a.asset.localeCompare(b.asset);
    });
    return result;
  }

  public computeStateRoot(): string {
    const accounts = this.getAllAccounts().filter((a) => a.balance > 0n);
    if (accounts.length === 0) return ethers.ZeroHash;
    const leaves = accounts.map((acc) =>
      ethers.solidityPackedKeccak256(
        ["address", "address", "uint256"],
        [acc.trader, acc.asset, acc.balance]
      )
    );
    const tree = new MerkleTree(leaves);
    return tree.getRoot();
  }
}

/**
 * Build the Sparse Merkle Tree for L1 withdrawals.
 * Leaf: keccak256(abi.encodePacked(chainId, withdrawalIndex, recipient, assetAddress, amount))
 * Matches OreVeilSettler.sol:executeWithdrawal() line 203.
 */
export function buildWithdrawalTree(
  withdrawals: WithdrawalClaim[],
  chainId = 9800
): { tree: MerkleTree; root: string; getProof: (index: number) => string[] } {
  if (withdrawals.length === 0) {
    const emptyTree = new MerkleTree([]);
    return {
      tree: emptyTree,
      root: ethers.ZeroHash,
      getProof: () => []
    };
  }

  const leaves = withdrawals.map((w) =>
    ethers.solidityPackedKeccak256(
      ["uint256", "uint256", "address", "address", "uint256"],
      [BigInt(chainId), BigInt(w.index), w.recipient, w.asset, w.amount]
    )
  );

  const tree = new MerkleTree(leaves);
  return {
    tree,
    root: tree.getRoot(),
    getProof: (index: number) => tree.getProof(index)
  };
}

/**
 * Calculate the single Uniform Clearing Price (P*) that maximizes executed volume.
 * Deterministic midpoint plateau resolution when multiple prices yield identical maximum volume.
 */
export function calculateUniformClearingPrice(orders: OrderParams[]): {
  clearingPrice: bigint;
  maxVolume: bigint;
} {
  const buys = orders.filter((o) => o.side === "BUY" && o.amount > 0n);
  const sells = orders.filter((o) => o.side === "SELL" && o.amount > 0n);

  if (buys.length === 0 || sells.length === 0) {
    return { clearingPrice: 0n, maxVolume: 0n };
  }

  // Extract unique price levels
  const priceSet = new Set<string>();
  for (const o of orders) {
    priceSet.add(o.limitPrice.toString());
  }
  const uniquePrices = Array.from(priceSet)
    .map((p) => BigInt(p))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  let maxVol = 0n;
  const candidatePrices: bigint[] = [];

  for (const p of uniquePrices) {
    // Demand D(P): all buys with limitPrice >= P
    let demand = 0n;
    for (const b of buys) {
      if (b.limitPrice >= p) demand += b.amount;
    }

    // Supply S(P): all sells with limitPrice <= P
    let supply = 0n;
    for (const s of sells) {
      if (s.limitPrice <= p) supply += s.amount;
    }

    const execVol = demand < supply ? demand : supply;

    if (execVol > maxVol) {
      maxVol = execVol;
      candidatePrices.length = 0;
      candidatePrices.push(p);
    } else if (execVol === maxVol && execVol > 0n) {
      candidatePrices.push(p);
    }
  }

  if (maxVol === 0n || candidatePrices.length === 0) {
    return { clearingPrice: 0n, maxVolume: 0n };
  }

  // Deterministic midpoint plateau resolution: (minPrice + maxPrice) / 2
  const minP = candidatePrices[0];
  const maxP = candidatePrices[candidatePrices.length - 1];
  const uniformPrice = (minP + maxP) / 2n;

  return { clearingPrice: uniformPrice, maxVolume: maxVol };
}

/**
 * Allocate execution fills at uniform clearing price P*.
 * Inframarginal orders fill 100%; marginal orders fill pro-rata.
 * Enforces strict conservation of token value down to the exact wei.
 */
export function allocateFills(
  orders: OrderParams[],
  clearingPrice: bigint,
  maxVolume: bigint
): { fills: TradeFill[]; unfilledOrders: OrderParams[] } {
  if (maxVolume === 0n || clearingPrice === 0n) {
    return { fills: [], unfilledOrders: [...orders] };
  }

  const buys = orders
    .filter((o) => o.side === "BUY" && o.limitPrice >= clearingPrice)
    .sort((a, b) => (b.limitPrice > a.limitPrice ? 1 : b.limitPrice < a.limitPrice ? -1 : 0));

  const sells = orders
    .filter((o) => o.side === "SELL" && o.limitPrice <= clearingPrice)
    .sort((a, b) => (a.limitPrice > b.limitPrice ? 1 : a.limitPrice < b.limitPrice ? -1 : 0));

  const fills: TradeFill[] = [];
  const unfilledOrders: OrderParams[] = [];

  // --- Allocate Buys (Highest limit price first) ---
  const buyFills = new Map<OrderParams, bigint>();
  let remainingBuyVol = maxVolume;

  const buysByPrice = new Map<bigint, OrderParams[]>();
  for (const b of buys) {
    const list = buysByPrice.get(b.limitPrice) ?? [];
    list.push(b);
    buysByPrice.set(b.limitPrice, list);
  }
  const buyPrices = Array.from(buysByPrice.keys()).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));

  for (const p of buyPrices) {
    if (remainingBuyVol === 0n) break;
    const ordersAtPrice = buysByPrice.get(p)!;
    let demandAtPrice = 0n;
    for (const o of ordersAtPrice) demandAtPrice += o.amount;

    if (demandAtPrice <= remainingBuyVol) {
      for (const o of ordersAtPrice) {
        buyFills.set(o, o.amount);
      }
      remainingBuyVol -= demandAtPrice;
    } else {
      let allocatedMarginal = 0n;
      for (const o of ordersAtPrice) {
        const share = (o.amount * remainingBuyVol) / demandAtPrice;
        buyFills.set(o, share);
        allocatedMarginal += share;
      }
      const remainder = remainingBuyVol - allocatedMarginal;
      if (remainder > 0n) {
        const first = ordersAtPrice[0];
        buyFills.set(first, (buyFills.get(first) ?? 0n) + remainder);
      }
      remainingBuyVol = 0n;
      break;
    }
  }

  // --- Allocate Sells (Lowest limit price first) ---
  const sellFills = new Map<OrderParams, bigint>();
  let remainingSellVol = maxVolume;

  const sellsByPrice = new Map<bigint, OrderParams[]>();
  for (const s of sells) {
    const list = sellsByPrice.get(s.limitPrice) ?? [];
    list.push(s);
    sellsByPrice.set(s.limitPrice, list);
  }
  const sellPrices = Array.from(sellsByPrice.keys()).sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));

  for (const p of sellPrices) {
    if (remainingSellVol === 0n) break;
    const ordersAtPrice = sellsByPrice.get(p)!;
    let supplyAtPrice = 0n;
    for (const o of ordersAtPrice) supplyAtPrice += o.amount;

    if (supplyAtPrice <= remainingSellVol) {
      for (const o of ordersAtPrice) {
        sellFills.set(o, o.amount);
      }
      remainingSellVol -= supplyAtPrice;
    } else {
      let allocatedMarginal = 0n;
      for (const o of ordersAtPrice) {
        const share = (o.amount * remainingSellVol) / supplyAtPrice;
        sellFills.set(o, share);
        allocatedMarginal += share;
      }
      const remainder = remainingSellVol - allocatedMarginal;
      if (remainder > 0n) {
        const first = ordersAtPrice[0];
        sellFills.set(first, (sellFills.get(first) ?? 0n) + remainder);
      }
      remainingSellVol = 0n;
      break;
    }
  }

  // Generate TradeFill records
  let totalQuotePaidByBuyers = 0n;
  for (const [order, baseFilled] of buyFills.entries()) {
    if (baseFilled > 0n) {
      const quoteFilled = calculateQuoteAmount(
        baseFilled,
        clearingPrice,
        order.baseToken,
        order.quoteToken
      );
      totalQuotePaidByBuyers += quoteFilled;
      fills.push({
        orderId: `BUY-${order.trader.substring(0, 8)}-${order.nonce}`,
        trader: order.trader,
        side: "BUY",
        baseToken: order.baseToken,
        quoteToken: order.quoteToken,
        baseAmountFilled: baseFilled,
        quoteAmountFilled: quoteFilled,
        clearingPrice,
        feeAmount: 0n
      });
    }
  }

  let totalQuoteReceivedBySellers = 0n;
  const sellFillRecords: TradeFill[] = [];
  for (const [order, baseFilled] of sellFills.entries()) {
    if (baseFilled > 0n) {
      const quoteFilled = calculateQuoteAmount(
        baseFilled,
        clearingPrice,
        order.baseToken,
        order.quoteToken
      );
      totalQuoteReceivedBySellers += quoteFilled;
      sellFillRecords.push({
        orderId: `SELL-${order.trader.substring(0, 8)}-${order.nonce}`,
        trader: order.trader,
        side: "SELL",
        baseToken: order.baseToken,
        quoteToken: order.quoteToken,
        baseAmountFilled: baseFilled,
        quoteAmountFilled: quoteFilled,
        clearingPrice,
        feeAmount: 0n
      });
    }
  }

  // Conservation of Quote Tokens: adjust any single-wei integer rounding discrepancy
  const quoteDiff = totalQuotePaidByBuyers - totalQuoteReceivedBySellers;
  if (quoteDiff !== 0n && sellFillRecords.length > 0) {
    sellFillRecords[0].quoteAmountFilled += quoteDiff;
  }
  fills.push(...sellFillRecords);

  // Collect unfilled and partially unfilled orders
  for (const o of orders) {
    const filled = o.side === "BUY" ? (buyFills.get(o) ?? 0n) : (sellFills.get(o) ?? 0n);
    if (filled < o.amount) {
      unfilledOrders.push({ ...o, amount: o.amount - filled });
    }
  }

  return { fills, unfilledOrders };
}

/**
 * Compute the Data Availability hash (dataHash) for L1 batch anchoring.
 * Matches keccak256(canonical JSON byte encoding of fills).
 */
export function computeDataHash(fills: TradeFill[]): string {
  if (fills.length === 0) return ethers.ZeroHash;
  const serialized = JSON.stringify(
    fills.map((f) => ({
      orderId: f.orderId,
      trader: f.trader.toLowerCase(),
      side: f.side,
      baseFilled: f.baseAmountFilled.toString(),
      quoteFilled: f.quoteAmountFilled.toString(),
      clearingPrice: f.clearingPrice.toString()
    }))
  );
  return ethers.keccak256(ethers.toUtf8Bytes(serialized));
}

/**
 * Master Batch Execution Coordinator:
 * 1. Computes uniform clearing price P* and max volume Q*.
 * 2. Allocates fills with pro-rata marginal fairness.
 * 3. Updates AccountLedger balances.
 * 4. Generates state commitments (newStateRoot, withdrawalRoot, dataHash).
 */
export function executeBatchFBA(
  batchId: number,
  epochId: number,
  orders: OrderParams[],
  ledger: AccountLedger,
  withdrawals: WithdrawalClaim[] = [],
  chainId = 9800
): BatchExecutionResult {
  const prevStateRoot = ledger.computeStateRoot();

  // 1. Calculate Uniform Clearing Price
  const { clearingPrice, maxVolume } = calculateUniformClearingPrice(orders);

  // 2. Allocate Fills
  const { fills, unfilledOrders } = allocateFills(orders, clearingPrice, maxVolume);

  // 3. Update Ledger Balances
  for (const fill of fills) {
    if (fill.side === "BUY") {
      // Buyer pays quote token, receives base token
      ledger.debit(fill.trader, fill.quoteToken, fill.quoteAmountFilled);
      ledger.credit(fill.trader, fill.baseToken, fill.baseAmountFilled);
    } else {
      // Seller pays base token, receives quote token
      ledger.debit(fill.trader, fill.baseToken, fill.baseAmountFilled);
      ledger.credit(fill.trader, fill.quoteToken, fill.quoteAmountFilled);
    }
  }

  // 4. Process L1 Withdrawals
  for (const w of withdrawals) {
    ledger.debit(w.recipient, w.asset, w.amount);
  }

  // 5. Compute State Roots
  const newStateRoot = ledger.computeStateRoot();
  const { root: withdrawalRoot } = buildWithdrawalTree(withdrawals, chainId);
  const dataHash = computeDataHash(fills);

  return {
    batchId,
    epochId,
    clearingPrice,
    totalVolume: maxVolume,
    fills,
    prevStateRoot,
    newStateRoot,
    withdrawalRoot,
    dataHash,
    unfilledOrders
  };
}
