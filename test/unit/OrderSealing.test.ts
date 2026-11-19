import { expect } from "chai";
import * as crypto from "crypto";
import {
  generateKemKeypair,
  sealOrder,
  unsealOrder,
  computeEnvelopeAad,
  OrderParams,
  SealedOrderEnvelope,
  ML_KEM_1024_CIPHERTEXT_SIZE,
  ML_KEM_1024_SHARED_SECRET_SIZE,
  ML_KEM_1024_SECRET_KEY_SIZE
} from "../../client/orderClient";
import {
  validateKemPublicKey,
  AlgorithmMLKEM1024,
  KEM_ALGORITHM_ML_KEM_1024,
  ML_KEM_1024_PUBLIC_KEY_SIZE,
  msg
} from "@qorechain/sdk";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";

describe("Sub-Phase 2.1: Confidential Order Sealing & NIST FIPS 203 (ML-KEM-1024)", function () {
  let sequencerKeypair: { publicKey: Uint8Array; secretKey: Uint8Array };
  const mockTrader = "0x7DE7d6CC73002f44A76334392555C9A4dDc0B561";
  const mockNativeQor = "0x0000000000000000000000000000000000000000";
  const mockFusd = "0x1111111111111111111111111111111111111111";
  const mockFeth = "0x2222222222222222222222222222222222222222";
  const mockFbtc = "0x3333333333333333333333333333333333333333";

  before(function () {
    sequencerKeypair = generateKemKeypair();
  });

  describe("Layer 1: NIST FIPS 203 Mathematical & Dimensional Invariants", function () {
    it("should generate ML-KEM-1024 public key of strictly 1,568 bytes", function () {
      expect(sequencerKeypair.publicKey.length).to.equal(ML_KEM_1024_PUBLIC_KEY_SIZE);
    });

    it("should generate ML-KEM-1024 secret key of strictly 3,168 bytes", function () {
      expect(sequencerKeypair.secretKey.length).to.equal(ML_KEM_1024_SECRET_KEY_SIZE);
    });

    it("should deterministically generate keypair from a 64-byte seed", function () {
      const seed = new Uint8Array(64).fill(42);
      const k1 = generateKemKeypair(seed);
      const k2 = generateKemKeypair(seed);
      expect(Buffer.from(k1.publicKey).equals(Buffer.from(k2.publicKey))).to.be.true;
      expect(Buffer.from(k1.secretKey).equals(Buffer.from(k2.secretKey))).to.be.true;
    });

    it("should revert keypair generation if seed is not 64 bytes", function () {
      const invalidSeed = new Uint8Array(32);
      expect(() => generateKemKeypair(invalidSeed)).to.throw("seed must be 64 bytes");
    });

    it("should encapsulate a 1,568-byte ciphertext and derive 32-byte shared secret", function () {
      const { cipherText, sharedSecret } = ml_kem1024.encapsulate(sequencerKeypair.publicKey);
      expect(cipherText.length).to.equal(ML_KEM_1024_CIPHERTEXT_SIZE);
      expect(sharedSecret.length).to.equal(ML_KEM_1024_SHARED_SECRET_SIZE);

      const decapsulated = ml_kem1024.decapsulate(cipherText, sequencerKeypair.secretKey);
      expect(Buffer.from(decapsulated).equals(Buffer.from(sharedSecret))).to.be.true;
    });

    it("should validate valid public keys using @qorechain/sdk validateKemPublicKey", function () {
      expect(() => validateKemPublicKey(sequencerKeypair.publicKey, KEM_ALGORITHM_ML_KEM_1024)).to.not.throw();
    });

    it("should reject degenerate all-zero public keys", function () {
      const zeroKey = new Uint8Array(ML_KEM_1024_PUBLIC_KEY_SIZE).fill(0);
      expect(() => validateKemPublicKey(zeroKey, KEM_ALGORITHM_ML_KEM_1024)).to.throw(
        "public key's t_hat is all zero"
      );
    });

    it("should reject public keys with invalid length", function () {
      const shortKey = new Uint8Array(1567);
      expect(() => validateKemPublicKey(shortKey, KEM_ALGORITHM_ML_KEM_1024)).to.throw(
        "an ML-KEM-1024 public key is 1568 bytes, got 1567"
      );
    });
  });

  describe("Layer 2: AES-256-GCM Envelope Security & Tamper Defenses", function () {
    const sampleOrder: OrderParams = {
      trader: mockTrader,
      baseToken: mockNativeQor,
      quoteToken: mockFusd,
      side: "BUY",
      amount: 10_000_000_000n, // 10,000 QOR
      limitPrice: 1_250_000_000_000_000_000n, // 1.25 fUSD per QOR
      nonce: 1,
      expiryBlock: 10400000
    };

    it("should generate unique IV and distinct ciphertext for identical orders (zero IV reuse)", function () {
      const env1 = sealOrder(sampleOrder, sequencerKeypair.publicKey, 100);
      const env2 = sealOrder(sampleOrder, sequencerKeypair.publicKey, 100);

      expect(env1.iv).to.not.equal(env2.iv);
      expect(env1.encryptedPayload).to.not.equal(env2.encryptedPayload);
      expect(env1.kemCiphertext).to.not.equal(env2.kemCiphertext);
    });

    it("should fail unsealing if a single bit is flipped in the encrypted payload", function () {
      const env = sealOrder(sampleOrder, sequencerKeypair.publicKey, 100);
      const payloadBuf = Buffer.from(env.encryptedPayload.replace("0x", ""), "hex");
      payloadBuf[0] ^= 0x01; // flip 1 bit
      const tamperedEnv = { ...env, encryptedPayload: "0x" + payloadBuf.toString("hex") };

      expect(() => unsealOrder(tamperedEnv, sequencerKeypair.secretKey)).to.throw(
        "authentication decryption failed"
      );
    });

    it("should fail unsealing if a bit is flipped in the IV", function () {
      const env = sealOrder(sampleOrder, sequencerKeypair.publicKey, 100);
      const ivBuf = Buffer.from(env.iv.replace("0x", ""), "hex");
      ivBuf[0] ^= 0x01;
      const tamperedEnv = { ...env, iv: "0x" + ivBuf.toString("hex") };

      expect(() => unsealOrder(tamperedEnv, sequencerKeypair.secretKey)).to.throw(
        "authentication decryption failed"
      );
    });

    it("should fail unsealing if a bit is flipped in the GCM authTag", function () {
      const env = sealOrder(sampleOrder, sequencerKeypair.publicKey, 100);
      const tagBuf = Buffer.from(env.authTag.replace("0x", ""), "hex");
      tagBuf[0] ^= 0x01;
      const tamperedEnv = { ...env, authTag: "0x" + tagBuf.toString("hex") };

      expect(() => unsealOrder(tamperedEnv, sequencerKeypair.secretKey)).to.throw(
        "authentication decryption failed"
      );
    });

    it("should reject replaying envelope with a different chainId (AAD mismatch)", function () {
      const env = sealOrder(sampleOrder, sequencerKeypair.publicKey, 100, 9800);
      const crossChainEnv: SealedOrderEnvelope = { ...env, chainId: 1 }; // replay onto Ethereum Mainnet

      expect(() => unsealOrder(crossChainEnv, sequencerKeypair.secretKey)).to.throw(
        "authentication decryption failed"
      );
    });

    it("should reject replaying envelope with a different epochId (AAD mismatch)", function () {
      const env = sealOrder(sampleOrder, sequencerKeypair.publicKey, 100, 9800);
      const nextEpochEnv: SealedOrderEnvelope = { ...env, epochId: 101 }; // replay onto later epoch

      expect(() => unsealOrder(nextEpochEnv, sequencerKeypair.secretKey)).to.throw(
        "authentication decryption failed"
      );
    });
  });

  describe("Layer 3: Property-Based Roundtrip & Fuzzing (100 Random Orders)", function () {
    it("should correctly seal and unseal an order with exact BigInt fidelity", function () {
      const order: OrderParams = {
        trader: mockTrader,
        baseToken: mockNativeQor,
        quoteToken: mockFusd,
        side: "SELL",
        amount: 50_000_000_000_000_000_000n, // 50 QOR
        limitPrice: 2_500_000_000_000_000_000n, // 2.5 fUSD
        nonce: 42,
        expiryBlock: 10500000
      };

      const envelope = sealOrder(order, sequencerKeypair.publicKey, 200);
      const restored = unsealOrder(envelope, sequencerKeypair.secretKey);

      expect(restored.trader).to.equal(order.trader);
      expect(restored.baseToken).to.equal(order.baseToken);
      expect(restored.quoteToken).to.equal(order.quoteToken);
      expect(restored.side).to.equal(order.side);
      expect(restored.amount).to.equal(order.amount);
      expect(restored.limitPrice).to.equal(order.limitPrice);
      expect(restored.nonce).to.equal(order.nonce);
      expect(restored.expiryBlock).to.equal(order.expiryBlock);
    });

    it("should handle extreme values up to 10^24 wei with zero precision loss", function () {
      const largeOrder: OrderParams = {
        trader: mockTrader,
        baseToken: mockFusd,
        quoteToken: mockFbtc,
        side: "BUY",
        amount: 1_000_000_000_000_000_000_000_000n, // 1M tokens in 18 decimals
        limitPrice: 99_999_999_999_999_999_999n,
        nonce: 999999,
        expiryBlock: 20000000
      };

      const envelope = sealOrder(largeOrder, sequencerKeypair.publicKey, 300);
      const restored = unsealOrder(envelope, sequencerKeypair.secretKey);

      expect(restored.amount).to.equal(largeOrder.amount);
      expect(restored.limitPrice).to.equal(largeOrder.limitPrice);
    });

    it("should successfully execute 100 randomized order fuzzing roundtrips", function () {
      const tokens = [mockNativeQor, mockFusd, mockFeth, mockFbtc];
      const sides: ("BUY" | "SELL")[] = ["BUY", "SELL"];

      for (let i = 0; i < 100; i++) {
        const randomOrder: OrderParams = {
          trader: `0x${crypto.randomBytes(20).toString("hex")}`,
          baseToken: tokens[i % tokens.length],
          quoteToken: tokens[(i + 1) % tokens.length],
          side: sides[i % 2],
          amount: BigInt(Math.floor(Math.random() * 1_000_000) + 1) * 10n ** 18n,
          limitPrice: BigInt(Math.floor(Math.random() * 500_000) + 1) * 10n ** 14n,
          nonce: i + 1,
          expiryBlock: 10400000 + i
        };

        const env = sealOrder(randomOrder, sequencerKeypair.publicKey, i);
        const restored = unsealOrder(env, sequencerKeypair.secretKey);

        expect(restored.trader.toLowerCase()).to.equal(randomOrder.trader.toLowerCase());
        expect(restored.baseToken).to.equal(randomOrder.baseToken);
        expect(restored.quoteToken).to.equal(randomOrder.quoteToken);
        expect(restored.side).to.equal(randomOrder.side);
        expect(restored.amount).to.equal(randomOrder.amount);
        expect(restored.limitPrice).to.equal(randomOrder.limitPrice);
        expect(restored.nonce).to.equal(randomOrder.nonce);
        expect(restored.expiryBlock).to.equal(randomOrder.expiryBlock);
      }
    });
  });

  describe("Layer 4: Adversarial & Market Front-Running Simulations", function () {
    const sensitiveOrder: OrderParams = {
      trader: "0x7DE7d6CC73002f44A76334392555C9A4dDc0B561",
      baseToken: mockNativeQor,
      quoteToken: mockFusd,
      side: "BUY",
      amount: 999_888_777n,
      limitPrice: 1_234_567_890n,
      nonce: 777,
      expiryBlock: 10450000
    };

    it("should guarantee complete mempool opacity (raw envelope contains zero trade substrings)", function () {
      const envelope = sealOrder(sensitiveOrder, sequencerKeypair.publicKey, 500);

      const rawSerializedEnvelope = JSON.stringify(envelope);
      expect(rawSerializedEnvelope).to.not.include("999888777");
      expect(rawSerializedEnvelope).to.not.include("1234567890");
      expect(rawSerializedEnvelope).to.not.include("7DE7d6CC73002f44A76334392555C9A4dDc0B561");
      expect(rawSerializedEnvelope).to.not.include("BUY");
    });

    it("should fail decapsulation if an attacker attempts to unseal using an unauthorized sequencer key", function () {
      const rogueSequencer = generateKemKeypair();
      const envelope = sealOrder(sensitiveOrder, sequencerKeypair.publicKey, 500);

      expect(() => unsealOrder(envelope, rogueSequencer.secretKey)).to.throw(
        "authentication decryption failed"
      );
    });

    it("should reject sealing an order with non-positive amount or limitPrice", function () {
      const invalidAmount: OrderParams = { ...sensitiveOrder, amount: 0n };
      expect(() => sealOrder(invalidAmount, sequencerKeypair.publicKey, 500)).to.throw(
        "amount must be greater than zero"
      );

      const invalidPrice: OrderParams = { ...sensitiveOrder, limitPrice: 0n };
      expect(() => sealOrder(invalidPrice, sequencerKeypair.publicKey, 500)).to.throw(
        "limitPrice must be greater than zero"
      );
    });
  });

  describe("Layer 5: Protocol Message Encoding & QoreChain Registration", function () {
    it("should build valid /qorechain.pqc.v1.MsgRegisterKEMKey message via @qorechain/sdk", function () {
      const cosmosSender = "qor10hnadnrnqqh5ffmrxsuj24wf5nwupdtp0zw8kt";
      const kemMsg = msg.pqc.registerKemKey({
        sender: cosmosSender,
        publicKey: sequencerKeypair.publicKey,
        algorithmId: AlgorithmMLKEM1024
      });

      expect(kemMsg.typeUrl).to.equal("/qorechain.pqc.v1.MsgRegisterKEMKey");
      expect(kemMsg.value.sender).to.equal(cosmosSender);
      expect(kemMsg.value.algorithmId).to.equal(AlgorithmMLKEM1024);
      expect(kemMsg.value.publicKey.length).to.equal(ML_KEM_1024_PUBLIC_KEY_SIZE);
    });
  });
});
