import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import {
  deriveEvmAccount,
  evmToQor,
  msg,
  EthNativeSigner,
  fetchKemKey,
  AlgorithmMLKEM1024,
  validateKemPublicKey,
  ML_KEM_1024_PUBLIC_KEY_SIZE
} from "@qorechain/sdk";
import { pqKeyFromSeed } from "@qorechain/qoresign";
import { generateKemKeypair } from "../client/orderClient";

dotenv.config();

const REST_URL = "https://api-testnet.qore.host";
const CHAIN_ID = "qorechain-diana";

async function broadcastTx(txRawBytes: Uint8Array): Promise<string> {
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

async function waitForTx(txHash: string): Promise<any> {
  console.log(`Waiting for transaction ${txHash} to be mined on Diana Testnet...`);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${REST_URL}/cosmos/tx/v1beta1/txs/${txHash}`);
      if (res.ok) {
        const data = await res.json();
        if (data.tx_response && data.tx_response.height !== "0") {
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
  throw new Error(`Transaction ${txHash} timed out waiting for confirmation`);
}

async function getAccountInfo(address: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  const res = await fetch(`${REST_URL}/cosmos/auth/v1beta1/accounts/${address}`);
  const data = await res.json();
  const acc = data.account?.base_account || data.account;
  return {
    accountNumber: BigInt(acc.account_number),
    sequence: BigInt(acc.sequence)
  };
}

async function main() {
  console.log("============================================================");
  console.log("  OreVeil: Sequencer ML-KEM-1024 (QoreSeal) Registration (Sub-Phase 2.1)");
  console.log("============================================================\n");

  const phrase = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!phrase) throw new Error("DEPLOYER_PRIVATE_KEY missing in .env");

  const ethAcc = await deriveEvmAccount(phrase);
  const cosmosAddress = evmToQor(ethAcc.address);
  console.log(`Sequencer / Deployer EVM:    ${ethAcc.address}`);
  console.log(`Sequencer / Deployer Cosmos: ${cosmosAddress}\n`);

  // 1. Load Deployer ML-DSA-87 Key for Hybrid Signing
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const accountKeyPath = path.join(deploymentsDir, "account-pqc-key.json");
  if (!fs.existsSync(accountKeyPath)) {
    throw new Error(`Missing account PQC key at ${accountKeyPath}. Run scripts/register-and-open-window.ts first.`);
  }
  const savedAccount = JSON.parse(fs.readFileSync(accountKeyPath, "utf8"));
  const seed = Buffer.from(savedAccount.seed.replace("0x", ""), "hex");
  const dsaKeypair = pqKeyFromSeed(seed);

  // 2. Load or Generate Sequencer ML-KEM-1024 Identity
  const kemKeyPath = path.join(deploymentsDir, "sequencer-kem-key.json");
  let kemKeypair: { publicKey: Uint8Array; secretKey: Uint8Array };

  if (fs.existsSync(kemKeyPath)) {
    console.log("Loading existing Sequencer KEM key from deployments/sequencer-kem-key.json...");
    const saved = JSON.parse(fs.readFileSync(kemKeyPath, "utf8"));
    kemKeypair = {
      publicKey: Buffer.from(saved.publicKey.replace("0x", ""), "hex"),
      secretKey: Buffer.from(saved.secretKey.replace("0x", ""), "hex")
    };
  } else {
    console.log("Generating fresh NIST FIPS 203 (ML-KEM-1024) Sequencer Keypair...");
    kemKeypair = generateKemKeypair();
    fs.writeFileSync(
      kemKeyPath,
      JSON.stringify(
        {
          algorithm: "ML-KEM-1024",
          algorithmId: AlgorithmMLKEM1024,
          publicKey: "0x" + Buffer.from(kemKeypair.publicKey).toString("hex"),
          secretKey: "0x" + Buffer.from(kemKeypair.secretKey).toString("hex"),
          createdAt: new Date().toISOString()
        },
        null,
        2
      )
    );
    console.log("Sequencer KEM key saved to deployments/sequencer-kem-key.json (git-ignored).\n");
  }

  // 3. Mathematical & Dimension Assertion
  validateKemPublicKey(kemKeypair.publicKey, AlgorithmMLKEM1024);
  console.log(`ML-KEM-1024 Public Key Validated: ${kemKeypair.publicKey.length} bytes\n`);

  // 4. Check Current On-Chain KEM Registration Status
  console.log(`Checking existing on-chain KEM status for ${cosmosAddress}...`);
  const currentKem = await fetchKemKey({ rest: REST_URL, address: cosmosAddress });
  if (currentKem.found && currentKem.key) {
    const onChainHex = Buffer.from(currentKem.key.publicKey).toString("hex");
    const localHex = Buffer.from(kemKeypair.publicKey).toString("hex");
    if (onChainHex === localHex) {
      console.log("[SUCCESS] Sequencer ML-KEM-1024 key is ALREADY registered on Diana Testnet!");
      console.log(`Registered at height: ${currentKem.key.registeredHeight}`);
      console.log("\n============================================================");
      console.log("  HACKATHON BADGE CLAIMABLE:");
      console.log("  Challenge: 'First QoreSeal key'");
      console.log("  Address:   " + cosmosAddress);
      console.log("============================================================\n");
      return;
    }
    console.log("Updating on-chain KEM key with new sequencer keypair...");
  }

  // 5. Query Sequence & Account Number
  const { accountNumber, sequence } = await getAccountInfo(cosmosAddress);
  console.log(`Account Number: ${accountNumber}, Sequence: ${sequence}\n`);

  // 6. Build MsgRegisterKEMKey
  const kemMsg = msg.pqc.registerKemKey({
    sender: cosmosAddress,
    publicKey: kemKeypair.publicKey,
    algorithmId: AlgorithmMLKEM1024
  });

  // 7. Sign with Hybrid Identity (secp256k1 + ML-DSA-87)
  const hybridSigner = new EthNativeSigner(
    {
      cosmos: cosmosAddress,
      privateKey: "0x" + Buffer.from(ethAcc.privateKey).toString("hex"),
      publicKey: "0x" + Buffer.from(ethAcc.publicKey).toString("hex"),
      pqc: dsaKeypair
    } as any,
    { signMode: "hybrid", rest: REST_URL, signBytesVersion: "v2" }
  );

  const signParams = {
    chainId: CHAIN_ID,
    accountNumber,
    sequence,
    fee: { amount: [{ denom: "uqor", amount: "200000" }], gas: "1000000" },
    messages: [kemMsg],
    signBytesVersion: "v2" as any
  };

  console.log("Signing MsgRegisterKEMKey with hybrid ML-DSA-87 + secp256k1...");
  const signed = hybridSigner.sign(signParams);

  console.log("Broadcasting to QoreChain Diana Testnet...");
  const txHash = await broadcastTx(signed.txRawBytes);
  console.log(`Registration Tx Broadcast: ${txHash}`);

  await waitForTx(txHash);
  console.log(`[SUCCESS] NIST FIPS 203 (ML-KEM-1024) Sequencer Key registered on Diana Testnet!\n`);

  // 8. Verify On-Chain
  const verifyStatus = await fetchKemKey({ rest: REST_URL, address: cosmosAddress });
  if (!verifyStatus.found || !verifyStatus.key) {
    throw new Error("Verification failed: KEM key not found on Diana Testnet after mining!");
  }
  console.log(`Verified On-Chain Height: ${verifyStatus.key.registeredHeight}`);
  console.log(`Verified Algorithm:       ${verifyStatus.key.algorithmName} (ID: ${verifyStatus.key.algorithmId})\n`);

  console.log("============================================================");
  console.log("  HACKATHON BADGE CLAIMABLE:");
  console.log("  Challenge: 'First QoreSeal key'");
  console.log("  Tx Hash:   " + txHash);
  console.log("  Account:   " + cosmosAddress);
  console.log("============================================================\n");
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
