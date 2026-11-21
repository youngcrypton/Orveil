# OreVeil Protocol: Diana Testnet Cryptographic Evidence Ledger (`EVIDENCE.md`)

This document records cryptographically verifiable transaction receipts, block numbers, and
precompile execution proofs executed against QoreChain Diana Testnet (`chainId: 9800`).

---

## Live Batch Settlement Proof: Batch #1
- **Status**: `MINED_AND_VERIFIED`
- **Timestamp**: `2026-11-20T14:52:58.314Z`
- **Network**: QoreChain Diana Testnet (`chainId: 9800`, Cosmos `qorechain-diana`)
- **Settler Contract**: [`0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44`](https://explore.qore.network/address/0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44)
- **Transaction Hash**: [`0x9cc8a59ad33de51cf9d502954e7279d54628ba12609de190e684b6ff64636695`](https://explore.qore.network/tx/0x9cc8a59ad33de51cf9d502954e7279d54628ba12609de190e684b6ff64636695)
- **Mined Block**: [`#10438858`](https://explore.qore.network/block/10438858)
- **Block Hash**: `0x727e34881833fb45c60c267156dcb8506b2aade76366e2c67eb6e86cd22ed15a`
- **Gas Consumed**: `1,750,000` gas units
- **Effective Gas Price**: `126.56 gwei` (Consensus floor: `>= 100.0 gwei`)
- **Total Fee Burned**: `0.221484375 QOR`
- **Deployer Account**: `0x7DE7d6CC73002f44A76334392555C9A4dDc0B561`
- **Deployer Balance Delta**: `228.79979088 QOR` ➔ `228.578306505 QOR` (`-0.221484375 QOR`)
- **Anchored State Root**: `0xee7f44e0fcdcf09951ea456e0d9f8b5276aec06384a82e2497675f3c40381e24`
- **On-Chain Sequence Advancement**: `latestBatchId` advanced from `0` ➔ `1`
- **Cryptographic Invariants**:
  - NIST FIPS 203 (ML-KEM-1024): 1,568-byte client ciphertexts and authenticated AES-256-GCM payloads
  - NIST FIPS 204 (ML-DSA-87): 4,627-byte digital signature verified via precompile `0x...0a01`
  - Zero-Wei Conservation: Strict mathematical balance conservation across all matched accounts

---

## Live AMM Pool Swap Proof: Ship Weeks Badge ("First swap in a pool")
- **Status**: `MINED_AND_VERIFIED`
- **Timestamp**: `2026-11-21T09:04:56.000Z`
- **Network**: QoreChain Diana Testnet (Cosmos `qorechain-diana`)
- **Transaction Hash**: [`660C8D14A29D97358C235DBEB1BC2BE7FDCDACE25FD0E3B03A2101A585B8D415`](https://explore.qore.network/tx/660C8D14A29D97358C235DBEB1BC2BE7FDCDACE25FD0E3B03A2101A585B8D415)
- **Mined Block**: [`#10484670`](https://explore.qore.network/block/10484670)
- **Sender Address**: `qor10hnadnrnqqh5ffmrxsuj24wf5nwupdtp0zw8kt`
- **AMM Pool ID**: `Pool #2` (Constant Product)
- **Token In**: `1000 uqor` ($0.001\text{ QOR}$)
- **Token Out**: `erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA` (`fUSD`)
- **Gas Consumed**: `266,151` / `1,000,000` gas units
- **Fee Paid**: `200000 uqor` (`0.2 QOR`)
- **Message Type**: `/qorechain.amm.v1.MsgSwapExactIn`
- **Signer Mode**: Hybrid `pqc-sign-bytes-v2` (`EthNativeSigner` + ML-DSA-87 account key)
- **Portal Verification**: Enables 4th Ship Weeks Badge on `https://build.qorechain.io/me` and proves `AMM pools` network feature.

---

## Formal Post-Quantum CBOM Audit Proof (CycloneDX 1.6 & QoreScan)
- **Status**: `VERIFIED_AND_CERTIFIED`
- **Specification**: CycloneDX 1.6 (`cbom.json`)
- **Generator**: `scripts/generate-cbom.ts` (`npm run audit:cbom`)
- **Audit Toolchain**: `@qorechain/qorescan` (`^0.1.0`)
- **Test Suite**: `test/unit/CbomAudit.test.ts` (12/12 passing; 251/251 repository-wide)
- **Catalogued Cryptographic Primitives**:
  - **NIST FIPS 204 (ML-DSA-87 / Dilithium-5)**: NIST Security Level 5, 2,592-byte public key, 4,627-byte digital signature, verified on Diana Testnet via precompile `0x0000000000000000000000000000000000000a01`.
  - **NIST FIPS 203 (ML-KEM-1024 / Kyber-1024)**: NIST Security Level 5, 1,568-byte public key, 1,568-byte ciphertext, 32-byte shared secret for client order sealing.
  - **NIST FIPS 202 (SHAKE-256)**: XOF digest for `pqc-sign-bytes-v2` domain separation.
  - **NIST SP 800-38D (AES-256-GCM)**: Authenticated symmetric payload encryption (256-bit key, 96-bit IV, 128-bit auth tag).
  - **Keccak-256**: EVM state root and withdrawal Merkle leaf hashing.
- **Quantum-Safe Certification**: Certified `quantumSafe: true` for all state commitment paths. Zero classical signature schemes (ECDSA/Ed25519) permitted for batch anchoring.
- **Portal Verification**: Enables `QoreScan` verification under Kits and SDKs used and `Security auditing / CBOM` under Network features on `build.qorechain.io`.

---

## Live Multi-Asset Vault Ingress Proof: Deposit #1
- **Status**: `MINED_AND_VERIFIED`
- **Timestamp**: `2026-11-21T13:01:05.000Z`
- **Network**: QoreChain Diana Testnet (`chainId: 9800`, Cosmos `qorechain-diana`)
- **Settler Contract**: [`0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44`](https://explore.qore.network/address/0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44)
- **Transaction Hash**: [`0x78082f34688d43bab5edfb6e92f246d44ae5bf76dee36908e6668cd65eebfbaf`](https://explore.qore.network/tx/0x78082f34688d43bab5edfb6e92f246d44ae5bf76dee36908e6668cd65eebfbaf)
- **Mined Block**: [`#10494578`](https://explore.qore.network/block/10494578)
- **Depositor**: `0x7DE7d6CC73002f44A76334392555C9A4dDc0B561`
- **Asset Deposited**: `0x0000000000000000000000000000000000000000` (Native QOR)
- **Amount Deposited**: `1.0 QOR` ($10^{18}\text{ wei}$)
- **Gas Consumed**: `175,000` units
- **Fee Burned**: `0.0221484375 QOR`
- **Event Emitted**: `Deposited(0x7DE7d6CC..., address(0), 1.0 QOR)`

---

## Live Batch Settlement Proof: Batch #2 (Quantum Settlement Anchor)
- **Status**: `MINED_AND_VERIFIED`
- **Timestamp**: `2026-11-21T13:01:14.000Z`
- **Network**: QoreChain Diana Testnet (`chainId: 9800`, Cosmos `qorechain-diana`)
- **Settler Contract**: [`0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44`](https://explore.qore.network/address/0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44)
- **Transaction Hash**: [`0x1c2f661c67a2bd1cc46e7ba7ffb68bf8086a5ac527e6fecc135c9f38d9150539`](https://explore.qore.network/tx/0x1c2f661c67a2bd1cc46e7ba7ffb68bf8086a5ac527e6fecc135c9f38d9150539)
- **Mined Block**: [`#10494583`](https://explore.qore.network/block/10494583)
- **Target Batch ID**: `#2`
- **Previous State Root**: `0xee7f44e0fcdcf09951ea456e0d9f8b5276aec06384a82e2497675f3c40381e24` (Matches Batch #1)
- **New State Root**: `0xf376c36c3aa86fd06147ad291868cd35b28c338937f70fabc994aa0745c8608b`
- **Anchored Withdrawal Root**: `0xfd5acf917be2d0c2cb4cfecbb86fc9a630182549e25d4fd05590dfac074359d9`
- **Cryptographic Signature**: NIST FIPS 204 (ML-DSA-87 / Dilithium-5) 4,627 bytes verified on-chain via precompile `0x0000000000000000000000000000000000000a01`.
- **On-Chain Sequence Advancement**: `latestBatchId` advanced from `1` ➔ `2`

---

## Live Trustless Merkle Withdrawal Proof: Batch #2 (Index #0)
- **Status**: `MINED_AND_VERIFIED`
- **Timestamp**: `2026-11-21T13:01:23.225Z`
- **Network**: QoreChain Diana Testnet (`chainId: 9800`, Cosmos `qorechain-diana`)
- **Settler Contract**: [`0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44`](https://explore.qore.network/address/0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44)
- **Transaction Hash**: [`0xad360100c3257eeba220a18528f33cee7f604d1e14f3acd8f7d172acbdffb15f`](https://explore.qore.network/tx/0xad360100c3257eeba220a18528f33cee7f604d1e14f3acd8f7d172acbdffb15f)
- **Mined Block**: [`#10494588`](https://explore.qore.network/block/10494588)
- **Block Hash**: `0xf1a2e3ad117d2d46253b4b06ca49a35d174b1d0c2bd30586dd736e5fa1139979`
- **Recipient Address**: `0x7DE7d6CC73002f44A76334392555C9A4dDc0B561`
- **Asset Disbursed**: `0x0000000000000000000000000000000000000000` (Native QOR)
- **Disbursed Amount**: `1.0 QOR`
- **Merkle Domain Leaf**: `0xfd5acf917be2d0c2cb4cfecbb86fc9a630182549e25d4fd05590dfac074359d9`
- **Checks-Effects-Interactions**: `executedWithdrawals[leaf] = true` verified
- **Gas Consumed**: `125,000` gas units
- **Effective Gas Price**: `126.56 gwei` (Consensus floor: `>= 100.0 gwei`)
- **Total Fee Burned**: `0.0158203125 QOR`
- **Replay Protection**: Second submission strictly reverted on-chain with `WithdrawalAlreadyProcessed()`.

---
