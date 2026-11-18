# OreVeil

> **Post-Quantum Frequent Batch Auction (FBA) Rollup on QoreChain**

OreVeil is a post-quantum decentralized trading rollup designed to eliminate toxic Maximal Extractable Value (MEV), sandwich attacks, and front-running. By combining discrete-time Frequent Batch Auctions (FBA) with lattice-based cryptography, OreVeil guarantees uniform clearing prices and trustless Layer 1 settlement anchored by NIST post-quantum signatures.

---

## Core Architecture

```
                  ┌──────────────────────────────────────────────┐
                  │          Trader Client (orderClient)         │
                  │  - Generates orders                          │
                  │  - Encapsulates payload via ML-KEM-1024      │
                  └──────────────────────┬───────────────────────┘
                                         │ Encrypted Envelopes
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │       Sequencer (kemReceiver & Engine)       │
                  │  - Ingests sealed envelopes                  │
                  │  - Decapsulates orders after epoch close     │
                  │  - Clears orders at Uniform Price (FBA)      │
                  │  - Signs batch with ML-DSA-87 (4,627 bytes)  │
                  └──────────────────────┬───────────────────────┘
                                         │ Anchoring Transaction
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │      QoreChain Diana L1 (chainId: 9800)      │
                  │  - OreVeilSettler Vault                      │
                  │  - Native PQC Precompile (0x...0a01)         │
                  │  - Merkle Root Exit Verification             │
                  └──────────────────────────────────────────────┘
```

1. **Sealed Order Ingestion (NIST FIPS 203 / ML-KEM-1024)**:
   Traders encapsulate order payloads using Kyber-1024 public keys. Sequencers cannot view order directions or limits until the discrete batch window closes, preventing front-running and priority gas auctions.

2. **Frequent Batch Auctions (FBA)**:
   Orders within each discrete epoch are matched simultaneously at a single uniform market clearing price, structurally eliminating latency arbitrage and sandwich attacks.

3. **Quantum-Secure Settlement (NIST FIPS 204 / ML-DSA-87)**:
   Batch state transitions and Merkle roots are signed using Dilithium-5 (ML-DSA-87, 4,627-byte signatures) and verified on-chain via QoreChain's native EVM precompile `0x...0a01`.

---

## Diana Testnet Deployment Parameters

| Parameter | Specification |
| :--- | :--- |
| **EVM Chain ID** | `9800` |
| **Cosmos Chain ID** | `qorechain-diana` |
| **EVM JSON-RPC** | `https://evm-testnet.qore.host` |
| **Cosmos RPC / REST** | `https://rpc-testnet.qore.host` / `https://api-testnet.qore.host` |
| **Native Denom** | `uqor` ($1\text{ QOR} = 10^6\text{ uqor}$, exponent: 6) |
| **Minimum Gas Price Floor** | `0.1 uqor` (`100,000,000,000 wei`) |
| **PQC Verifier Precompile** | `0x0000000000000000000000000000000000000a01` |
| **PQC Key Status Precompile**| `0x0000000000000000000000000000000000000a02` |

---

## Project Structure

```
oreveil/
├── contracts/
│   └── interfaces/
│       ├── IPQCVerifier.sol      # Native precompile 0x...0a01 interface
│       └── IPQCStatus.sol        # Native precompile 0x...0a02 interface
├── test/
│   └── sdk-connection.test.ts    # Live Diana testnet & PQC verification suite
├── hardhat.config.ts             # Solidity 0.8.24 viaIR configuration
├── package.json                  # Dependencies (@qorechain/sdk, @qorechain/qoresign)
└── tsconfig.json                 # TypeScript ES2022 configuration
```

---

## Quickstart

### Prerequisites
- Node.js `>= 20.0.0`
- npm `>= 10.0.0`

### 1. Installation
```bash
npm install
```

### 2. Compile Contracts
```bash
npx hardhat compile
```
*Compiles Solidity interfaces with `viaIR: true` and 200 optimizer runs.*

### 3. Run Live Diana Testnet Verification Suite
```bash
npx hardhat test test/sdk-connection.test.ts
```

This live test suite performs real network queries without mock doubles:
- Connects to Diana EVM JSON-RPC (`chainId: 9800`).
- Validates the network gas price floor ($\ge 0.1\text{ uqor}$).
- Generates a real NIST FIPS 204 ML-DSA-87 keypair (2,592-byte public key) and signature (4,627 bytes) via `@qorechain/qoresign`.
- Executes a live `staticcall` to precompile `0x0000000000000000000000000000000000000a01`, receiving on-chain proof of post-quantum signature verification.

---

## License

This project is licensed under the [MIT License](LICENSE).
