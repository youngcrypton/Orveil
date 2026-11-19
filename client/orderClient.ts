import * as crypto from "crypto";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import {
  validateKemPublicKey,
  KEM_ALGORITHM_ML_KEM_1024,
  ML_KEM_1024_PUBLIC_KEY_SIZE
} from "@qorechain/sdk";

export type OrderSide = "BUY" | "SELL";

export interface OrderParams {
  trader: string;
  baseToken: string;
  quoteToken: string;
  side: OrderSide;
  amount: bigint;
  limitPrice: bigint;
  nonce: number;
  expiryBlock: number;
}

export interface SealedOrderEnvelope {
  kemCiphertext: string;
  iv: string;
  authTag: string;
  encryptedPayload: string;
  epochId: number;
  chainId: number;
}

export interface KemKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export const ML_KEM_1024_CIPHERTEXT_SIZE = 1568;
export const ML_KEM_1024_SHARED_SECRET_SIZE = 32;
export const ML_KEM_1024_SECRET_KEY_SIZE = 3168;

/**
 * Generate a NIST FIPS 203 (ML-KEM-1024) Keypair.
 * If a 64-byte seed is provided, derivation is deterministic.
 */
export function generateKemKeypair(seed?: Uint8Array): KemKeypair {
  if (seed) {
    if (seed.length !== 64) {
      throw new Error(`generateKemKeypair: seed must be 64 bytes, got ${seed.length}`);
    }
    return ml_kem1024.keygen(seed);
  }
  const randomSeed = crypto.randomBytes(64);
  return ml_kem1024.keygen(new Uint8Array(randomSeed));
}

/**
 * Construct domain-separated Additional Authenticated Data (AAD) for AES-256-GCM.
 * Prevents cross-chain and cross-epoch envelope replay attacks.
 */
export function computeEnvelopeAad(chainId: number, epochId: number): Buffer {
  return Buffer.from(`OREVEIL_FBA_V1:${chainId}:${epochId}`, "utf8");
}

/**
 * Client-Side Order Sealing:
 * 1. Encapsulates a 32-byte shared secret via NIST FIPS 203 (ML-KEM-1024).
 * 2. Encrypts structured order parameters using AES-256-GCM with fresh 12-byte IV.
 * 3. Binds chainId and epochId in authenticated AAD.
 */
export function sealOrder(
  params: OrderParams,
  sequencerKemPubKey: Uint8Array,
  epochId: number,
  chainId = 9800
): SealedOrderEnvelope {
  // 1. Validate inputs
  if (!params.trader) throw new Error("sealOrder: trader address is required");
  if (!params.baseToken) throw new Error("sealOrder: baseToken is required");
  if (!params.quoteToken) throw new Error("sealOrder: quoteToken is required");
  if (params.side !== "BUY" && params.side !== "SELL") {
    throw new Error(`sealOrder: invalid side ${params.side}, expected BUY or SELL`);
  }
  if (params.amount <= 0n) throw new Error("sealOrder: amount must be greater than zero");
  if (params.limitPrice <= 0n) throw new Error("sealOrder: limitPrice must be greater than zero");

  // 2. Validate Sequencer Public Key
  validateKemPublicKey(sequencerKemPubKey, KEM_ALGORITHM_ML_KEM_1024);

  // 3. Encapsulate 32-byte shared secret
  const { cipherText: kemCiphertext, sharedSecret } = ml_kem1024.encapsulate(sequencerKemPubKey);

  // 4. Serialize Order Parameters
  const serialized = JSON.stringify({
    trader: params.trader,
    baseToken: params.baseToken,
    quoteToken: params.quoteToken,
    side: params.side,
    amount: params.amount.toString(),
    limitPrice: params.limitPrice.toString(),
    nonce: params.nonce,
    expiryBlock: params.expiryBlock
  });

  // 5. Encrypt with AES-256-GCM
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(sharedSecret), iv);
  const aad = computeEnvelopeAad(chainId, epochId);
  cipher.setAAD(aad);

  const encrypted = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    kemCiphertext: "0x" + Buffer.from(kemCiphertext).toString("hex"),
    iv: "0x" + iv.toString("hex"),
    authTag: "0x" + authTag.toString("hex"),
    encryptedPayload: "0x" + encrypted.toString("hex"),
    epochId,
    chainId
  };
}

/**
 * Sequencer-Side Order Decapsulation & Decryption:
 * 1. Decapsulates the 32-byte shared secret using the sequencer's ML-KEM-1024 secret key.
 * 2. Authenticates and decrypts the AES-256-GCM envelope.
 * 3. Restores exact OrderParams typed fields with BigInt precision.
 */
export function unsealOrder(
  envelope: SealedOrderEnvelope,
  sequencerKemSecretKey: Uint8Array
): OrderParams {
  if (sequencerKemSecretKey.length !== ML_KEM_1024_SECRET_KEY_SIZE) {
    throw new Error(
      `unsealOrder: invalid secret key size: expected ${ML_KEM_1024_SECRET_KEY_SIZE}, got ${sequencerKemSecretKey.length}`
    );
  }

  // 1. Parse byte arrays
  const kemCipherBytes = Buffer.from(envelope.kemCiphertext.replace("0x", ""), "hex");
  if (kemCipherBytes.length !== ML_KEM_1024_CIPHERTEXT_SIZE) {
    throw new Error(
      `unsealOrder: invalid KEM ciphertext length: expected ${ML_KEM_1024_CIPHERTEXT_SIZE}, got ${kemCipherBytes.length}`
    );
  }

  const iv = Buffer.from(envelope.iv.replace("0x", ""), "hex");
  if (iv.length !== 12) {
    throw new Error(`unsealOrder: invalid IV length: expected 12 bytes, got ${iv.length}`);
  }

  const authTag = Buffer.from(envelope.authTag.replace("0x", ""), "hex");
  if (authTag.length !== 16) {
    throw new Error(`unsealOrder: invalid authTag length: expected 16 bytes, got ${authTag.length}`);
  }

  const encryptedBytes = Buffer.from(envelope.encryptedPayload.replace("0x", ""), "hex");

  // 2. Decapsulate shared secret
  const sharedSecret = ml_kem1024.decapsulate(new Uint8Array(kemCipherBytes), sequencerKemSecretKey);

  // 3. Decrypt with AES-256-GCM
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(sharedSecret), iv);
  const aad = computeEnvelopeAad(envelope.chainId, envelope.epochId);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  let decryptedStr: string;
  try {
    decryptedStr = Buffer.concat([decipher.update(encryptedBytes), decipher.final()]).toString("utf8");
  } catch (err: any) {
    throw new Error(`unsealOrder: authentication decryption failed (tampered ciphertext or invalid key): ${err.message}`);
  }

  // 4. Parse OrderParams and restore BigInt
  const parsed = JSON.parse(decryptedStr);
  return {
    trader: parsed.trader,
    baseToken: parsed.baseToken,
    quoteToken: parsed.quoteToken,
    side: parsed.side as OrderSide,
    amount: BigInt(parsed.amount),
    limitPrice: BigInt(parsed.limitPrice),
    nonce: Number(parsed.nonce),
    expiryBlock: Number(parsed.expiryBlock)
  };
}
