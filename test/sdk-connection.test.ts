import { expect } from "chai";
import { ethers } from "ethers";
import * as crypto from "crypto";
import {
  pqKeyFromSeed,
  pqSign,
  pqVerify,
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SECRET_KEY_LENGTH,
  ML_DSA_87_SIGNATURE_LENGTH
} from "@qorechain/qoresign";
import { NETWORKS } from "@qorechain/sdk";

describe("Sub-Phase 0.2: Live SDK & RPC Connectivity Verification Suite", function () {
  this.timeout(30000); // 30s timeout for live network queries

  const DIANA_RPC_URL = NETWORKS.testnet.endpoints.evmRpc; // https://evm-testnet.qore.host
  const EXPECTED_CHAIN_ID = 9800n;
  const MIN_GAS_PRICE_FLOOR = 100_000_000_000n; // 0.1 uqor (10^11 wei)
  const PQC_PRECOMPILE = "0x0000000000000000000000000000000000000a01";
  const PQC_STATUS_PRECOMPILE = "0x0000000000000000000000000000000000000a02";

  let provider: ethers.JsonRpcProvider;

  before(function () {
    provider = new ethers.JsonRpcProvider(DIANA_RPC_URL);
  });

  describe("1. Diana EVM Network Parameters & Chain ID", function () {
    it("should connect to live Diana RPC and return chainId 9800", async function () {
      const network = await provider.getNetwork();
      expect(network.chainId).to.equal(EXPECTED_CHAIN_ID);
    });

    it("should query the latest block number and verify network liveness", async function () {
      const blockNumber = await provider.getBlockNumber();
      expect(blockNumber).to.be.greaterThan(10_000_000);
    });
  });

  describe("2. Gas Price Floor Compliance", function () {
    it("should enforce the mandatory minimum gas price floor (>= 0.1 uqor)", async function () {
      const feeData = await provider.getFeeData();
      expect(feeData.gasPrice).to.not.be.null;
      expect(feeData.gasPrice!).to.be.greaterThanOrEqual(MIN_GAS_PRICE_FLOOR);
    });
  });

  describe("3. Precompile Addresses Grounding", function () {
    it("should assert PQC precompile address format is strictly lowercase hex", function () {
      expect(PQC_PRECOMPILE).to.equal(PQC_PRECOMPILE.toLowerCase());
      expect(PQC_PRECOMPILE).to.match(/^0x0000000000000000000000000000000000000a01$/);
    });

    it("should assert PQC Status precompile address format is strictly lowercase hex", function () {
      expect(PQC_STATUS_PRECOMPILE).to.equal(PQC_STATUS_PRECOMPILE.toLowerCase());
      expect(PQC_STATUS_PRECOMPILE).to.match(/^0x0000000000000000000000000000000000000a02$/);
    });
  });

  describe("4. Local NIST FIPS 204 (ML-DSA-87) Cryptographic Pipeline", function () {
    let keypair: { algorithmId: string; publicKey: Uint8Array; secretKey: Uint8Array };
    const testMessage = Buffer.from("oreveil-subphase-0.2-signature-verification");
    let signature: Uint8Array;

    it("should derive an ML-DSA-87 keypair from 32-byte seed with exact dimensions", function () {
      const seed = crypto.randomBytes(32);
      keypair = pqKeyFromSeed(seed);

      expect(keypair.publicKey.length).to.equal(ML_DSA_87_PUBLIC_KEY_LENGTH);
      expect(keypair.publicKey.length).to.equal(2592);
      expect(keypair.secretKey.length).to.equal(ML_DSA_87_SECRET_KEY_LENGTH);
      expect(keypair.secretKey.length).to.equal(4896);
    });

    it("should generate a 4,627-byte signature and verify locally via @qorechain/qoresign", function () {
      signature = pqSign(keypair.secretKey, testMessage);
      expect(signature.length).to.equal(ML_DSA_87_SIGNATURE_LENGTH);
      expect(signature.length).to.equal(4627);

      const isValid = pqVerify(keypair.publicKey, testMessage, signature);
      expect(isValid).to.be.true;
    });

    it("should reject tampered message during local verification", function () {
      const tamperedMessage = Buffer.from("tampered-message-content");
      const isValid = pqVerify(keypair.publicKey, tamperedMessage, signature);
      expect(isValid).to.be.false;
    });
  });

  describe("5. Live On-Chain Precompile (0x...0a01) Verification", function () {
    const verifierInterface = new ethers.Interface([
      "function pqcVerify(bytes pubkey, bytes signature, bytes message) external view returns (bool)"
    ]);

    it("should verify valid ML-DSA-87 signature via on-chain staticcall returning true", async function () {
      const seed = crypto.randomBytes(32);
      const key = pqKeyFromSeed(seed);
      const message = Buffer.from("oreveil-batch-settlement-proof");
      const sig = pqSign(key.secretKey, message);

      const pubkeyHex = "0x" + Buffer.from(key.publicKey).toString("hex");
      const sigHex = "0x" + Buffer.from(sig).toString("hex");
      const msgHex = "0x" + message.toString("hex");

      const callData = verifierInterface.encodeFunctionData("pqcVerify", [
        pubkeyHex,
        sigHex,
        msgHex
      ]);

      const returnData = await provider.call({
        to: PQC_PRECOMPILE,
        data: callData
      });

      // Assert return data is exactly 32 bytes (66 hex characters with 0x)
      expect(returnData.length).to.equal(66);

      const [isValid] = verifierInterface.decodeFunctionResult("pqcVerify", returnData);
      expect(isValid).to.be.true;
      expect(returnData).to.equal("0x0000000000000000000000000000000000000000000000000000000000000001");
    });

    it("should reject invalid/tampered signature on-chain returning false", async function () {
      const seed = crypto.randomBytes(32);
      const key = pqKeyFromSeed(seed);
      const originalMessage = Buffer.from("authentic-order-batch");
      const forgedMessage = Buffer.from("forged-order-batch");
      const sig = pqSign(key.secretKey, originalMessage);

      const pubkeyHex = "0x" + Buffer.from(key.publicKey).toString("hex");
      const sigHex = "0x" + Buffer.from(sig).toString("hex");
      const forgedMsgHex = "0x" + forgedMessage.toString("hex");

      const callData = verifierInterface.encodeFunctionData("pqcVerify", [
        pubkeyHex,
        sigHex,
        forgedMsgHex
      ]);

      const returnData = await provider.call({
        to: PQC_PRECOMPILE,
        data: callData
      });

      expect(returnData.length).to.equal(66);
      const [isValid] = verifierInterface.decodeFunctionResult("pqcVerify", returnData);
      expect(isValid).to.be.false;
      expect(returnData).to.equal("0x0000000000000000000000000000000000000000000000000000000000000000");
    });
  });
});
