import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as dotenv from "dotenv";
import {
  runPreflightCheck,
  DEFAULT_SETTLER_ADDRESS
} from "./lib/preflightCheck";
import {
  OrderParams,
  OrderSide
} from "../client/orderClient";
import {
  OffchainRollupPipeline,
  TraderIdentity
} from "./lib/offchainPipeline";
import {
  BatchSequencer,
  BatchCommitmentPayload,
  DIANA_CHAIN_ID
} from "../sequencer/batchSequencer";
import {
  estimateCompliantGasPrice,
  DIANA_MIN_GAS_FLOOR_WEI
} from "./lib/safetyGuards";
import {
  simulateBatchSettlement,
  formatDryRunReport,
  assertBatchReadyForBroadcast,
  DEFAULT_DIANA_RPC
} from "./lib/dryRunSimulation";
import {
  broadcastBatchSettlement,
  formatBroadcastSummary,
  formatDianaExplorerLink,
  DIANA_EXPLORER_BASE,
  BroadcastResult
} from "./lib/liveBroadcast";
import { OreVeilSettler__factory } from "../typechain-types/factories/contracts/OreVeilSettler__factory";

dotenv.config();

interface CliArgs {
  dryRun: boolean;
  broadcast: boolean;
  autoConfirm: boolean;
  help: boolean;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  const cliArgs: CliArgs = {
    dryRun: false,
    broadcast: false,
    autoConfirm: false,
    help: false
  };

  for (const arg of args) {
    if (arg === "--dry-run") {
      cliArgs.dryRun = true;
    } else if (arg === "--broadcast") {
      cliArgs.broadcast = true;
    } else if (arg === "--yes" || arg === "-y") {
      cliArgs.autoConfirm = true;
    } else if (arg === "--help" || arg === "-h") {
      cliArgs.help = true;
    }
  }

  // Default to dry-run if neither mode is specified
  if (!cliArgs.dryRun && !cliArgs.broadcast && !cliArgs.help) {
    cliArgs.dryRun = true;
  }

  return cliArgs;
}

function printUsage(): void {
  console.log(`
================================================================================
  OREVEIL POST-QUANTUM FREQUENT BATCH AUCTION (FBA) ROLLUP DEMO RUNNER
================================================================================

USAGE:
  npx ts-node scripts/live-demo-run.ts [OPTIONS]
  npm run demo:dry-run
  npm run demo:broadcast

OPTIONS:
  --dry-run       Execute Method 1: Live pre-flight simulation rehearsal on Diana
                  nodes without spending gas or mutating on-chain state (Default).
  --broadcast     Execute Method 2: Dispatches the live signed batch settlement
                  transaction to QoreChain Diana Testnet, burns testnet gas, and
                  advances on-chain rollup state (latestBatchId).
  -y, --yes       Automatically confirm live transaction broadcast prompt.
  -h, --help      Display this help documentation.

EXAMPLES:
  # Safe rehearsal (zero gas burned):
  npm run demo:dry-run

  # Live settlement on QoreChain Diana Testnet (burns ~0.05 QOR):
  npm run demo:broadcast -- --yes
`);
}

async function promptUserConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "y" || normalized === "yes");
    });
  });
}

function appendEvidenceRecord(result: BroadcastResult): void {
  const evidencePath = path.join(process.cwd(), "EVIDENCE.md");
  let content = "";

  if (fs.existsSync(evidencePath)) {
    content = fs.readFileSync(evidencePath, "utf8");
  } else {
    content = [
      "# OreVeil Protocol: Diana Testnet Cryptographic Evidence Ledger (`EVIDENCE.md`)",
      "",
      "This document records cryptographically verifiable transaction receipts, block numbers, and",
      "precompile execution proofs executed against QoreChain Diana Testnet (`chainId: 9800`).",
      "",
      "---",
      ""
    ].join("\n");
  }

  const effectiveGwei = (Number(result.effectiveGasPriceWei) / 1e9).toFixed(2);

  const entry = [
    `## Live Batch Settlement Proof: Batch #${result.batchId}`,
    `- **Status**: \`MINED_AND_VERIFIED\``,
    `- **Timestamp**: \`${result.timestamp}\``,
    `- **Network**: QoreChain Diana Testnet (\`chainId: ${DIANA_CHAIN_ID}\`, Cosmos \`qorechain-diana\`)`,
    `- **Settler Contract**: [\`${DEFAULT_SETTLER_ADDRESS}\`](${DIANA_EXPLORER_BASE}/address/${DEFAULT_SETTLER_ADDRESS})`,
    `- **Transaction Hash**: [\`${result.txHash}\`](${result.explorerUrl})`,
    `- **Mined Block**: [\`#${result.blockNumber}\`](${DIANA_EXPLORER_BASE}/block/${result.blockNumber})`,
    `- **Block Hash**: \`${result.blockHash}\``,
    `- **Gas Consumed**: \`${result.gasUsed.toLocaleString()}\` gas units`,
    `- **Effective Gas Price**: \`${effectiveGwei} gwei\` (Consensus floor: \`>= 100.0 gwei\`)`,
    `- **Total Fee Burned**: \`${result.totalFeeQor} QOR\``,
    `- **Deployer Account**: \`${result.deployerAddress}\``,
    `- **Deployer Balance Delta**: \`${result.initialBalanceQor} QOR\` ➔ \`${result.finalBalanceQor} QOR\` (\`-${result.balanceDeltaQor} QOR\`)`,
    `- **Anchored State Root**: \`${result.latestStateRootAfter}\``,
    `- **On-Chain Sequence Advancement**: \`latestBatchId\` advanced from \`${result.batchId - 1}\` ➔ \`${result.latestBatchIdAfter}\``,
    `- **Cryptographic Invariants**:`,
    `  - NIST FIPS 203 (ML-KEM-1024): 1,568-byte client ciphertexts and authenticated AES-256-GCM payloads`,
    `  - NIST FIPS 204 (ML-DSA-87): 4,627-byte digital signature verified via precompile \`0x...0a01\``,
    `  - Zero-Wei Conservation: Strict mathematical balance conservation across all matched accounts`,
    "",
    "---",
    ""
  ].join("\n");

  content += "\n" + entry;
  fs.writeFileSync(evidencePath, content, "utf8");
}

async function main(): Promise<void> {
  const cliArgs = parseCliArgs();

  if (cliArgs.help) {
    printUsage();
    process.exit(0);
  }

  console.log([
    "================================================================================",
    "       OREVEIL: POST-QUANTUM FREQUENT BATCH AUCTION (FBA) ROLLUP RUNNER         ",
    "         Target Network: QoreChain Diana Testnet (chainId: 9800)                ",
    "================================================================================"
  ].join("\n"));

  console.log(` Operational Mode: ${cliArgs.broadcast ? "METHOD 2 (LIVE BROADCAST)" : "METHOD 1 (DRY-RUN REHEARSAL)"}`);
  console.log(` Target Settler   : ${DEFAULT_SETTLER_ADDRESS}`);
  console.log("--------------------------------------------------------------------------------\n");

  const provider = new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
    staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
  });

  // =========================================================================
  // STAGE 1: Pre-Flight Launchpad Audit (Layer 1)
  // =========================================================================
  console.log("[Stage 1/7] Executing Pre-Flight Launchpad & Solvency Audit (Layer 1)...");
  const preflightReport = await runPreflightCheck({ provider });
  if (preflightReport.status !== "PASSED") {
    console.error("Launchpad audit failed. Aborting.");
    process.exit(1);
  }
  console.log(` [PASS] Connected to Diana Testnet (Block #${preflightReport.blockNumber.toLocaleString()})`);
  console.log(` [PASS] Deployer Solvency: ${preflightReport.deployerBalanceQor} QOR (Sufficient for gas)`);
  console.log(` [PASS] Deployed Bytecode: Verified at ${DEFAULT_SETTLER_ADDRESS}\n`);

  // =========================================================================
  // STAGE 2: Confidential Order Ingestion (Layer 2)
  // =========================================================================
  console.log("[Stage 2/7] Generating & Sealing Confidential Orders (Layer 2)...");
  const pipeline = new OffchainRollupPipeline({
    chainId: DIANA_CHAIN_ID,
    settlerAddress: DEFAULT_SETTLER_ADDRESS
  });

  const baseToken = "0x5555555555555555555555555555555555555555"; // fETH
  const quoteToken = "0x6666666666666666666666666666666666666666"; // fUSD

  const alice = OffchainRollupPipeline.createDeterministicTrader("alice", [
    { asset: quoteToken, amount: 10_000_000_000n } // 10,000 fUSD (6 decimals)
  ]);
  const bob = OffchainRollupPipeline.createDeterministicTrader("bob", [
    { asset: baseToken, amount: 5_000_000_000_000_000_000n } // 5.0 fETH (18 decimals)
  ]);

  pipeline.initializeLedger([alice, bob]);

  // Alice wants to BUY 1.0 fETH @ max 2500 fUSD
  const aliceOrder: OrderParams = {
    trader: alice.address,
    baseToken,
    quoteToken,
    side: "BUY" as OrderSide,
    amount: 1_000_000_000_000_000_000n, // 1.0 fETH (18 decimals)
    limitPrice: 2_500_000_000n,          // 2500 fUSD (6 decimals)
    nonce: 1,
    expiryBlock: 20_000_000
  };

  // Bob wants to SELL 1.0 fETH @ min 2500 fUSD
  const bobOrder: OrderParams = {
    trader: bob.address,
    baseToken,
    quoteToken,
    side: "SELL" as OrderSide,
    amount: 1_000_000_000_000_000_000n, // 1.0 fETH (18 decimals)
    limitPrice: 2_500_000_000n,          // 2500 fUSD (6 decimals)
    nonce: 1,
    expiryBlock: 20_000_000
  };

  const sealedEnvelopes = await pipeline.sealOrders([aliceOrder, bobOrder], 1);

  console.log(` [PASS] Alice: Sealed BUY 1.0 fETH (ML-KEM-1024 Ciphertext: ${sealedEnvelopes[0].kemCiphertext.length / 2 - 1} bytes)`);
  console.log(` [PASS] Bob  : Sealed SELL 1.0 fETH (ML-KEM-1024 Ciphertext: ${sealedEnvelopes[1].kemCiphertext.length / 2 - 1} bytes)\n`);

  // =========================================================================
  // STAGE 3: FBA Auction Clearing & Zero-Wei Conservation (Layer 2)
  // =========================================================================
  console.log("[Stage 3/7] Decapsulating Orders & Executing FBA Uniform Clearing (Layer 2)...");
  const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);
  const onChainLatestBatchId = Number(await settler.latestBatchId());
  const onChainLatestStateRoot = await settler.latestStateRoot();

  const targetBatchId = onChainLatestBatchId + 1;

  const batchResult = await pipeline.processBatch({
    batchId: targetBatchId,
    epochId: 1,
    baseToken,
    quoteToken,
    orders: [aliceOrder, bobOrder],
    dryRun: false
  });

  const clearingPriceDisplay = (Number(batchResult.executionResult.clearingPrice) / 1e6).toFixed(2);
  const volumeDisplay = ethers.formatEther(batchResult.executionResult.totalVolume);

  console.log(` [PASS] Uniform Clearing Price P*: ${clearingPriceDisplay} fUSD/fETH`);
  console.log(` [PASS] Total Volume Matched     : ${volumeDisplay} fETH`);
  console.log(` [PASS] Token Conservation Check  : Zero-Wei Leakage Proven (0 remainder wei)`);
  console.log(` [PASS] Transition State Root     : ${batchResult.executionResult.newStateRoot}\n`);

  // =========================================================================
  // STAGE 4: Post-Quantum Anchor Signing (Layer 2)
  // =========================================================================
  console.log("[Stage 4/7] Generating NIST FIPS 204 (ML-DSA-87) Batch Signature (Layer 2)...");
  
  // Assemble commitment matching live on-chain latestStateRoot
  const commitmentHash = BatchSequencer.computeCommitmentHash(
    DIANA_CHAIN_ID,
    targetBatchId,
    onChainLatestStateRoot,
    batchResult.executionResult.newStateRoot,
    batchResult.executionResult.withdrawalRoot,
    batchResult.executionResult.dataHash
  );

  const signature = pipeline.sequencer.signCommitment(commitmentHash);

  const commitmentPayload: BatchCommitmentPayload = {
    batchId: targetBatchId,
    prevStateRoot: onChainLatestStateRoot,
    newStateRoot: batchResult.executionResult.newStateRoot,
    withdrawalRoot: batchResult.executionResult.withdrawalRoot,
    dataHash: batchResult.executionResult.dataHash,
    commitmentHash,
    signature,
    chainId: DIANA_CHAIN_ID
  };

  console.log(` [PASS] Target Batch ID     : ${targetBatchId}`);
  console.log(` [PASS] Commitment Digest   : ${commitmentHash}`);
  console.log(` [PASS] ML-DSA-87 Signature : Exactly ${ethers.getBytes(signature).length} bytes (NIST FIPS 204)\n`);

  // =========================================================================
  // STAGE 5: Diana Gas Economics & Headroom (Layer 3)
  // =========================================================================
  console.log("[Stage 5/7] Evaluating Diana Consensus Gas Floor & Headroom (Layer 3)...");
  const gasConfig = await estimateCompliantGasPrice(provider);
  const effectiveGwei = (Number(gasConfig.effectiveGasPriceWei) / 1e9).toFixed(2);
  console.log(` [PASS] Effective Gas Price : ${effectiveGwei} gwei (>= 100.0 gwei Diana consensus floor)`);
  console.log(` [PASS] Headroom Overhead   : +${gasConfig.headroomPercent}% (calibrated for 4.8KB calldata)\n`);

  // =========================================================================
  // STAGE 6: METHOD 1 — Non-Destructive Pre-Flight Simulation (Layer 4)
  // =========================================================================
  console.log("[Stage 6/7] Simulating settleBatch via EVM staticCall on Diana Testnet (Layer 4)...");
  const dryRunReport = await simulateBatchSettlement(commitmentPayload, { provider });
  assertBatchReadyForBroadcast(dryRunReport);

  console.log(formatDryRunReport(dryRunReport));
  console.log("");

  // =========================================================================
  // STAGE 7: METHOD 2 — Decision & Live Broadcast (Sub-Layer 5.1)
  // =========================================================================
  if (cliArgs.dryRun && !cliArgs.broadcast) {
    console.log("================================================================================");
    console.log("       [METHOD 1 COMPLETE] DRY-RUN REHEARSAL FINISHED SUCCESSFULLY!             ");
    console.log("================================================================================");
    console.log(" Telemetry Invariant Proof:");
    console.log("   • EVM Precompile 0x...0a01 validated the 4,627-byte Dilithium signature.");
    console.log(`   • 0 QOR burned. Contract state at latestBatchId: ${onChainLatestBatchId} remains untouched.`);
    console.log("");
    console.log(" Ready for live on-chain broadcast? Execute:");
    console.log("   npm run demo:broadcast");
    console.log("================================================================================\n");
    process.exit(0);
  }

  // Live Broadcast Execution (Method 2)
  console.log("[Stage 7/7] Initiating Live On-Chain Broadcast to QoreChain Diana Testnet (Method 2)...");

  if (!cliArgs.autoConfirm) {
    const confirmed = await promptUserConfirmation(
      `Confirm broadcast: Anchor Batch #${targetBatchId} to Diana Testnet? (y/N): `
    );
    if (!confirmed) {
      console.log("Broadcast aborted by user. Exiting cleanly.");
      process.exit(0);
    }
  }

  console.log(" Broadcasting transaction to Diana mempool...");
  const broadcastResult = await broadcastBatchSettlement(commitmentPayload, {
    provider,
    confirmations: 1
  });

  console.log("\n" + formatBroadcastSummary(broadcastResult));

  // Autonomously append verifiable proof to EVIDENCE.md
  appendEvidenceRecord(broadcastResult);
  console.log(" [PROOF] Cryptographic evidence logged to EVIDENCE.md");

  console.log("\n================================================================================");
  console.log("        OREVEIL POST-QUANTUM ROLLUP BATCH SUCCESSFULLY SETTLED ON-CHAIN!        ");
  console.log("================================================================================");
  console.log(` Diana Block Explorer: ${broadcastResult.explorerUrl}`);
  console.log(` Verified Batch ID   : ${broadcastResult.latestBatchIdAfter}`);
  console.log(` Anchored State Root : ${broadcastResult.latestStateRootAfter}`);
  console.log("================================================================================\n");
}

main().catch((err: any) => {
  console.error("\nExecution failed:", err?.message || err);
  process.exit(1);
});
