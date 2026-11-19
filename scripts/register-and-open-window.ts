import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import {
  deriveEvmAccount,
  evmToQor,
  buildRegisterPqcKeyMsg,
  openEvmWindowMsg,
  EthNativeSigner
} from "@qorechain/sdk";
import { pqKeyFromSeed, signProofOfPossession } from "@qorechain/qoresign";

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
  const phrase = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!phrase) throw new Error("DEPLOYER_PRIVATE_KEY missing in .env");

  const ethAcc = await deriveEvmAccount(phrase);
  const cosmosAddress = evmToQor(ethAcc.address);
  console.log(`Deployer Address (EVM):    ${ethAcc.address}`);
  console.log(`Deployer Address (Cosmos): ${cosmosAddress}\n`);

  // Setup / Load Persistent Account PQC Key
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const accountKeyPath = path.join(deploymentsDir, "account-pqc-key.json");
  let pqKeypair: any;
  let seedHex: string;

  if (fs.existsSync(accountKeyPath)) {
    const saved = JSON.parse(fs.readFileSync(accountKeyPath, "utf8"));
    const seed = Buffer.from(saved.seed.replace("0x", ""), "hex");
    pqKeypair = pqKeyFromSeed(seed);
    seedHex = saved.seed;
    console.log("Loaded existing Account PQC key from deployments/account-pqc-key.json");
  } else {
    const seed = crypto.randomBytes(32);
    pqKeypair = pqKeyFromSeed(seed);
    seedHex = "0x" + seed.toString("hex");
    fs.writeFileSync(
      accountKeyPath,
      JSON.stringify(
        {
          algorithmId: pqKeypair.algorithmId,
          seed: seedHex,
          publicKey: "0x" + Buffer.from(pqKeypair.publicKey).toString("hex"),
          secretKey: "0x" + Buffer.from(pqKeypair.secretKey).toString("hex")
        },
        null,
        2
      )
    );
    console.log("Generated and saved new Account PQC key to deployments/account-pqc-key.json");
  }

  // Check on-chain PQC status
  const pqStatusRes = await fetch(`${REST_URL}/qorechain/pqc/v1/account/${cosmosAddress}`);
  const pqStatusData = await pqStatusRes.json();
  const isRegistered = pqStatusData.found === true;
  console.log(`PQC Key Registered On-Chain: ${isRegistered}\n`);

  let { accountNumber, sequence } = await getAccountInfo(cosmosAddress);
  console.log(`Current Account Number: ${accountNumber}, Sequence: ${sequence}\n`);

  // STEP 1: Register PQC Key if not registered
  if (!isRegistered) {
    console.log("--- STEP 1: Registering ML-DSA-87 Post-Quantum Key (Classical Sign + PoP) ---");
    const proof = signProofOfPossession({
      chainId: CHAIN_ID,
      account: cosmosAddress,
      pqKey: pqKeypair
    });

    const regMsg = buildRegisterPqcKeyMsg(cosmosAddress, {
      pqcKeypair: pqKeypair,
      ecdsaPubkey: ethAcc.publicKey,
      proofOfPossession: proof
    });

    const signer = new EthNativeSigner(
      {
        cosmos: cosmosAddress,
        privateKey: "0x" + Buffer.from(ethAcc.privateKey).toString("hex"),
        publicKey: "0x" + Buffer.from(ethAcc.publicKey).toString("hex"),
        pqc: pqKeypair
      } as any,
      { signMode: "classical" }
    );

    const signParams = {
      chainId: CHAIN_ID,
      accountNumber,
      sequence,
      fee: { amount: [{ denom: "uqor", amount: "200000" }], gas: "1000000" },
      messages: [regMsg]
    };

    const signed = signer.sign(signParams);
    const txHash = await broadcastTx(signed.txRawBytes);
    console.log(`Register PQC Key Tx Broadcast: ${txHash}`);
    await waitForTx(txHash);
    console.log(`[SUCCESS] PQC Key registered on-chain for ${cosmosAddress}!\n`);

    // Advance sequence after successful tx
    sequence += 1n;
  }

  // STEP 2: Open EVM Authorization Window
  console.log("--- STEP 2: Opening EVM Authorization Window (Hybrid Signature) ---");
  const windowMsg = openEvmWindowMsg({
    sender: cosmosAddress,
    blocks: 15000,
    maxTxs: 1000,
    maxValue: 100000000000000000000n // 100 QOR
  });

  const hybridSigner = new EthNativeSigner(
    {
      cosmos: cosmosAddress,
      privateKey: "0x" + Buffer.from(ethAcc.privateKey).toString("hex"),
      publicKey: "0x" + Buffer.from(ethAcc.publicKey).toString("hex"),
      pqc: pqKeypair
    } as any,
    { signMode: "hybrid", rest: REST_URL, signBytesVersion: "v2" }
  );

  const windowSignParams = {
    chainId: CHAIN_ID,
    accountNumber,
    sequence,
    fee: { amount: [{ denom: "uqor", amount: "200000" }], gas: "1000000" },
    messages: [windowMsg],
    signBytesVersion: "v2" as any
  };

  const signedWindow = hybridSigner.sign(windowSignParams);
  const windowTxHash = await broadcastTx(signedWindow.txRawBytes);
  console.log(`Open EVM Window Tx Broadcast: ${windowTxHash}`);
  await waitForTx(windowTxHash);
  console.log(`[SUCCESS] EVM Authorization Window is now OPEN on Diana Testnet!\n`);

  console.log("============================================================");
  console.log("  HACKATHON BADGE CLAIMABLE:");
  console.log("  Challenge: 'First hybrid transaction'");
  console.log("  Tx Hash:   " + windowTxHash);
  console.log("============================================================\n");

  console.log("Account is fully unlocked for standard EVM transactions and Hardhat deployments!");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
