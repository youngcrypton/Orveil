import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import {
  deriveEvmAccount,
  evmToQor,
  openEvmWindowMsg,
  EthNativeSigner
} from "@qorechain/sdk";
import { pqKeyFromSeed } from "@qorechain/qoresign";

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

  // Load Persistent Account PQC Key
  const accountKeyPath = path.join(__dirname, "..", "deployments", "account-pqc-key.json");
  if (!fs.existsSync(accountKeyPath)) {
    throw new Error(`Account PQC key not found at ${accountKeyPath}`);
  }
  const saved = JSON.parse(fs.readFileSync(accountKeyPath, "utf8"));
  const seed = Buffer.from(saved.seed.replace("0x", ""), "hex");
  const pqKeypair = pqKeyFromSeed(seed);
  console.log("Loaded existing Account PQC key from deployments/account-pqc-key.json");

  const { accountNumber, sequence } = await getAccountInfo(cosmosAddress);
  console.log(`Current Account Number: ${accountNumber}, Sequence: ${sequence}\n`);

  console.log("--- Opening EVM Authorization Window (17,280 blocks, 1,000 txs) ---");
  const windowMsg = openEvmWindowMsg({
    sender: cosmosAddress,
    blocks: 17280,
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
  const receipt = await waitForTx(windowTxHash);
  console.log(`[SUCCESS] EVM Authorization Window is now OPEN on Diana Testnet at block ${receipt.height}!\n`);
  console.log(`Explorer Link: https://explore.qore.network/tx/${windowTxHash}`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
