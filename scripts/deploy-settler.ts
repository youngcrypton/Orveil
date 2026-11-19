import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { pqKeyFromSeed, ML_DSA_87_PUBLIC_KEY_LENGTH } from "@qorechain/qoresign";

async function main() {
  console.log("============================================================");
  console.log("  OreVeil: Diana Testnet Settlement Vault Deployment (Sub-Phase 1.2)");
  console.log("============================================================\n");

  // 1. Pre-flight Checks & Network Verification
  const network = await ethers.provider.getNetwork();
  console.log(`Target Network Chain ID: ${network.chainId.toString()}`);
  if (network.chainId !== 9800n) {
    throw new Error(`Invalid network: expected chainId 9800, got ${network.chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer available. Please check DEPLOYER_PRIVATE_KEY in .env");
  }

  const deployerAddress = deployer.address;
  const balanceWei = await ethers.provider.getBalance(deployerAddress);
  const balanceQor = ethers.formatEther(balanceWei);
  console.log(`Deployer Address (EVM Hex):  ${deployerAddress}`);
  console.log(`Deployer Balance:            ${balanceQor} QOR (${balanceWei.toString()} wei)\n`);

  if (balanceWei < ethers.parseEther("1.0")) {
    throw new Error(
      `Insufficient QOR balance: deployer has ${balanceQor} QOR. Please claim testnet QOR from https://dashboard.qorechain.io/faucet`
    );
  }

  // 2. Setup Sequencer ML-DSA-87 Identity
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const keyPath = path.join(deploymentsDir, "sequencer-key.json");
  let keypair: { algorithmId: string; publicKey: Uint8Array; secretKey: Uint8Array };
  let seedHex: string;

  if (fs.existsSync(keyPath)) {
    console.log("Loading existing sequencer key from deployments/sequencer-key.json...");
    const saved = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    const seed = Buffer.from(saved.seed.replace("0x", ""), "hex");
    keypair = pqKeyFromSeed(seed);
    seedHex = saved.seed;
  } else {
    console.log("Generating fresh NIST FIPS 204 (ML-DSA-87) Sequencer Identity...");
    const seed = crypto.randomBytes(32);
    keypair = pqKeyFromSeed(seed);
    seedHex = "0x" + seed.toString("hex");

    const keyData = {
      algorithmId: keypair.algorithmId,
      seed: seedHex,
      publicKey: "0x" + Buffer.from(keypair.publicKey).toString("hex"),
      secretKey: "0x" + Buffer.from(keypair.secretKey).toString("hex"),
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(keyPath, JSON.stringify(keyData, null, 2), "utf8");
    console.log("Sequencer key persisted securely to deployments/sequencer-key.json (git-ignored).\n");
  }

  if (keypair.publicKey.length !== ML_DSA_87_PUBLIC_KEY_LENGTH) {
    throw new Error(
      `Invalid ML-DSA-87 public key length: expected ${ML_DSA_87_PUBLIC_KEY_LENGTH}, got ${keypair.publicKey.length}`
    );
  }
  const pubKeyHex = "0x" + Buffer.from(keypair.publicKey).toString("hex");
  console.log(`Sequencer Public Key:        ${pubKeyHex.substring(0, 34)}... (${keypair.publicKey.length} bytes)\n`);

  // 3. Gas Price Floor Assertion
  const feeData = await ethers.provider.getFeeData();
  const minFloor = 110_000_000_000n; // 0.11 uqor
  const gasPrice = feeData.gasPrice && feeData.gasPrice > minFloor
    ? (feeData.gasPrice * 120n) / 100n
    : minFloor;
  console.log(`Calculated Gas Price:        ${gasPrice.toString()} wei (${ethers.formatUnits(gasPrice, "gwei")} gwei)`);

  // 4. Deploy OreVeilSettler
  console.log("Broadcasting deployment transaction to QoreChain Diana Testnet...");
  const OreVeilSettlerFactory = await ethers.getContractFactory("OreVeilSettler");
  const settler = await OreVeilSettlerFactory.deploy(deployerAddress, pubKeyHex, {
    gasPrice,
    gasLimit: 3_500_000
  });

  const deployTx = settler.deploymentTransaction();
  const txHash = deployTx ? deployTx.hash : "";
  console.log(`Deployment Tx Broadcast:     ${txHash}`);
  console.log("Waiting for block confirmation on Diana Testnet...\n");

  await settler.waitForDeployment();
  const contractAddress = await settler.getAddress();
  const receipt = deployTx ? await deployTx.wait() : null;

  console.log("------------------------------------------------------------");
  console.log("  SUCCESS! OreVeilSettler Mined on QoreChain Diana Testnet");
  console.log("------------------------------------------------------------");
  console.log(`Contract Address:            ${contractAddress}`);
  console.log(`Deployment Tx Hash:          ${txHash}`);
  console.log(`Block Height:                ${receipt?.blockNumber ?? "N/A"}`);
  console.log(`Gas Used:                    ${receipt?.gasUsed?.toString() ?? "N/A"}`);
  console.log(`Block Explorer:              https://explore.qore.network/tx/${txHash}\n`);

  // 5. Persist Deployment Artifacts
  const deploymentArtifact = {
    network: "dianaTestnet",
    chainId: 9800,
    contractAddress,
    deploymentTxHash: txHash,
    deployerAddress,
    sequencerPublicKey: pubKeyHex,
    blockNumber: receipt?.blockNumber ?? null,
    gasUsed: receipt?.gasUsed?.toString() ?? null,
    timestamp: new Date().toISOString(),
    explorerUrl: `https://explore.qore.network/tx/${txHash}`
  };

  const artifactPath = path.join(deploymentsDir, "diana.json");
  fs.writeFileSync(artifactPath, JSON.stringify(deploymentArtifact, null, 2), "utf8");
  console.log(`Deployment metadata saved to: ${artifactPath}`);

  console.log("\n============================================================");
  console.log("  HACKATHON PORTAL BADGE SUBMISSION:");
  console.log("  Challenge: 'First contract with a PQC check'");
  console.log(`  Copy & Paste Tx Hash: ${txHash}`);
  console.log("============================================================\n");
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
