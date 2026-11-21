import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import {
  deriveEvmAccount,
  evmToQor,
  amm,
  EthNativeSigner
} from "@qorechain/sdk";
import { pqKeyFromSeed } from "@qorechain/qoresign";

dotenv.config();

export const REST_URL = "https://api-testnet.qore.host";
export const RPC_URL = "https://rpc-testnet.qore.host";
export const CHAIN_ID = "qorechain-diana";
export const DEFAULT_POOL_ID = "2";
export const DEFAULT_TARGET_DENOM = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA"; // fUSD on Diana
export const DEFAULT_SWAP_AMOUNT_UQOR = "1000"; // 0.001 QOR

export interface AmmSwapOptions {
  poolId?: string;
  amount?: string;
  denomOut?: string;
  minOut?: string;
  dryRun?: boolean;
}

export interface AmmSwapResult {
  txHash: string;
  height: number;
  poolId: string;
  tokenIn: { denom: string; amount: string };
  denomOut: string;
  minOut: string;
  gasUsed: number;
  gasWanted: number;
  feeAmount: string;
  explorerUrl: string;
  success: boolean;
  rawLog?: string;
}

export interface PoolInfo {
  id: string;
  poolType: string;
  tokenA: string;
  tokenB: string;
  reserveA: string;
  reserveB: string;
  status: string;
}

/**
 * Queries Diana Testnet native AMM pools via Cosmos REST API.
 */
export async function queryPoolInfo(poolId: string = DEFAULT_POOL_ID): Promise<PoolInfo> {
  const res = await fetch(`${REST_URL}/qorechain/amm/v1/pools`);
  if (!res.ok) {
    throw new Error(`Failed to query AMM pools: HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const rawPool = (data.pools || []).find((p: any) => String(p.id) === String(poolId));
  if (!rawPool) {
    throw new Error(`AMM Pool #${poolId} not found on Diana Testnet`);
  }
  return {
    id: String(rawPool.id),
    poolType: rawPool.pool_type,
    tokenA: rawPool.token_a,
    tokenB: rawPool.token_b,
    reserveA: rawPool.reserve_a,
    reserveB: rawPool.reserve_b,
    status: rawPool.status
  };
}

/**
 * Queries on-chain Cosmos account sequence and account number.
 */
export async function getCosmosAccountInfo(address: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  const res = await fetch(`${REST_URL}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch account info for ${address}: HTTP ${res.status}`);
  }
  const data = await res.json();
  const acc = data.account?.base_account || data.account;
  if (!acc || acc.account_number === undefined) {
    throw new Error(`Invalid account payload returned for ${address}`);
  }
  return {
    accountNumber: BigInt(acc.account_number),
    sequence: BigInt(acc.sequence)
  };
}

/**
 * Broadcasts serialized transaction bytes to Diana REST endpoint.
 */
export async function broadcastCosmosTx(txRawBytes: Uint8Array): Promise<string> {
  const base64Tx = Buffer.from(txRawBytes).toString("base64");
  const res = await fetch(`${REST_URL}/cosmos/tx/v1beta1/txs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_bytes: base64Tx, mode: "BROADCAST_MODE_SYNC" })
  });
  const data = await res.json();
  if (!res.ok || data.tx_response?.code !== 0) {
    throw new Error(`Broadcast failed: ${JSON.stringify(data)}`);
  }
  return data.tx_response.txhash;
}

/**
 * Polls Diana Testnet until the transaction is mined into a block.
 */
export async function waitForCosmosTx(txHash: string, maxAttempts: number = 20): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${REST_URL}/cosmos/tx/v1beta1/txs/${txHash}`);
      if (res.ok) {
        const data = await res.json();
        if (data.tx_response && data.tx_response.height && data.tx_response.height !== "0") {
          if (data.tx_response.code !== 0) {
            throw new Error(`Tx failed with code ${data.tx_response.code}: ${data.tx_response.raw_log}`);
          }
          return data.tx_response;
        }
      }
    } catch (e: any) {
      if (e.message && e.message.includes("code")) throw e;
    }
  }
  throw new Error(`Transaction ${txHash} timed out waiting for Diana block confirmation`);
}

/**
 * Executes a token swap on Diana Testnet native AMM pool to claim the Ship Weeks badge.
 */
export async function executeAmmSwap(options: AmmSwapOptions = {}): Promise<AmmSwapResult> {
  const poolId = options.poolId || DEFAULT_POOL_ID;
  const amount = options.amount || DEFAULT_SWAP_AMOUNT_UQOR;
  const denomOut = options.denomOut || DEFAULT_TARGET_DENOM;
  const minOut = options.minOut || "1";
  const dryRun = options.dryRun || false;

  const phrase = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!phrase) {
    throw new Error("DEPLOYER_PRIVATE_KEY is missing from .env");
  }

  // 1. Derive deployer account
  const ethAcc = await deriveEvmAccount(phrase);
  const cosmosAddress = evmToQor(ethAcc.address);

  // 2. Query pool information
  const pool = await queryPoolInfo(poolId);
  if (pool.status !== "active") {
    throw new Error(`Target AMM pool #${poolId} is not in active status (status: ${pool.status})`);
  }

  // 3. Load Persistent Account PQC Key
  const accountKeyPath = path.join(__dirname, "..", "deployments", "account-pqc-key.json");
  if (!fs.existsSync(accountKeyPath)) {
    throw new Error(`Account PQC key not found at ${accountKeyPath}. Run register-kem-key.ts first.`);
  }
  const saved = JSON.parse(fs.readFileSync(accountKeyPath, "utf8"));
  const seed = Buffer.from(saved.seed.replace("0x", ""), "hex");
  const pqKeypair = pqKeyFromSeed(seed);

  // 4. Fetch live account number and sequence
  const { accountNumber, sequence } = await getCosmosAccountInfo(cosmosAddress);

  // 5. Build MsgSwapExactIn message via @qorechain/sdk
  const swapMsg = amm.swapExactIn({
    sender: cosmosAddress,
    poolId: poolId,
    tokenIn: { denom: "uqor", amount: amount },
    denomOut: denomOut,
    minOut: minOut
  });

  // 6. Build hybrid signer
  const hybridSigner = new EthNativeSigner(
    {
      cosmos: cosmosAddress,
      privateKey: "0x" + Buffer.from(ethAcc.privateKey).toString("hex"),
      publicKey: "0x" + Buffer.from(ethAcc.publicKey).toString("hex"),
      pqc: pqKeypair
    } as any,
    { signMode: "hybrid", rest: REST_URL, signBytesVersion: "v2" }
  );

  const fee = { amount: [{ denom: "uqor", amount: "200000" }], gas: "1000000" };

  const signParams = {
    chainId: CHAIN_ID,
    accountNumber,
    sequence,
    fee,
    messages: [swapMsg],
    signBytesVersion: "v2" as any
  };

  const signedTx = hybridSigner.sign(signParams);

  if (dryRun) {
    return {
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      height: 0,
      poolId,
      tokenIn: { denom: "uqor", amount },
      denomOut,
      minOut,
      gasUsed: 0,
      gasWanted: 1000000,
      feeAmount: "200000 uqor",
      explorerUrl: "https://explore.qore.network/dry-run",
      success: true
    };
  }

  // 7. Broadcast live transaction
  const txHash = await broadcastCosmosTx(signedTx.txRawBytes);
  const receipt = await waitForCosmosTx(txHash);

  return {
    txHash,
    height: Number(receipt.height),
    poolId,
    tokenIn: { denom: "uqor", amount },
    denomOut,
    minOut,
    gasUsed: Number(receipt.gas_used || 0),
    gasWanted: Number(receipt.gas_wanted || 1000000),
    feeAmount: "200000 uqor",
    explorerUrl: `https://explore.qore.network/tx/${txHash}`,
    success: receipt.code === 0,
    rawLog: receipt.raw_log
  };
}

export async function main() {
  console.log("================================================================================");
  console.log("       OreVeil Protocol: Native AMM Pool Swap & Badge Claim Execution           ");
  console.log("================================================================================");

  try {
    console.log("Executing live swap on Diana Testnet Native AMM Pool #2...");
    const result = await executeAmmSwap();

    console.log("\n--------------------------------------------------------------------------------");
    console.log("                           SWAP TELEMETRY DASHBOARD                             ");
    console.log("--------------------------------------------------------------------------------");
    console.log(` Status:           [SUCCESS] Mined on Diana Testnet`);
    console.log(` Block Height:     #${result.height}`);
    console.log(` Transaction Hash: ${result.txHash}`);
    console.log(` AMM Pool ID:      #${result.poolId}`);
    console.log(` Tokens Swapped:   ${result.tokenIn.amount} ${result.tokenIn.denom} -> ${result.denomOut}`);
    console.log(` Gas Consumed:     ${result.gasUsed.toLocaleString()} / ${result.gasWanted.toLocaleString()} units`);
    console.log(` Network Fee:      ${result.feeAmount}`);
    console.log(` Explorer URL:     ${result.explorerUrl}`);
    console.log("--------------------------------------------------------------------------------");
    console.log("\n[NEXT STEP]: Navigate to https://build.qorechain.io/me");
    console.log("Click the purple [Check] button under 'First swap in a pool' to claim your badge!");
    console.log("================================================================================\n");
  } catch (error: any) {
    console.error("\n[SWAP ERROR]:", error.message || error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
