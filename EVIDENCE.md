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
