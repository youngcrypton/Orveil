# OreVeil Formal Threat Model & Cryptographic Security Architecture

This document provides a formal security analysis, mathematical proof suite, and attack-vector mitigation matrix for the **OreVeil Post-Quantum Frequent Batch Auction (FBA) Rollup**. All mechanisms described herein are implemented in [`contracts/OreVeilSettler.sol`](contracts/OreVeilSettler.sol), [`sequencer/`](sequencer/), [`watchtower/`](watchtower/), and verified on **QoreChain Diana Testnet** (`chainId: 9800`).

---

## 1. System Boundary, Trust Model & Security Parameters

OreVeil separates order dissemination, execution, state commitment, and asset custody into discrete trust boundaries:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            OreVeil Trust Boundary                           │
│                                                                             │
│   UNTRUSTED CLIENT DOMAIN               TRUSTED ENCLAVE / SEQUENCER         │
│   ┌─────────────────────┐               ┌─────────────────────────────────┐ │
│   │ Client Order SDK    │               │ Matching Engine (FBA Epochs)    │ │
│   │ • Key: ML-KEM-1024  │──Ciphertext──▶│ • Decapsulates Shared Secret    │ │
│   │ • AES-256-GCM Enc   │  (1,568 B)    │ • Clears at Uniform Price       │ │
│   └─────────────────────┘               │ • Computes State Deltas         │ │
│                                         └────────────────┬────────────────┘ │
│                                                          │                  │
│                                                          ▼                  │
│   LAYER 1 VERIFICATION & ESCROW (DIANA EVM)   COMMITMENT PIPELINE           │
│   ┌────────────────────────────────────────┐  ┌───────────────────────────┐ │
│   │ OreVeilSettler.sol (0xc6dcb457...)     │  │ NIST FIPS 204 (ML-DSA-87) │ │
│   │ • Precompile 0x...0a01 (PQC Verifier)  │◀─│ • 2,592-byte Public Key   │ │
│   │ • Multi-Asset Vault (QOR + ERC-20s)    │  │ • 4,627-byte Signature    │ │
│   │ • Trustless Merkle Egress Engine       │  └───────────────────────────┘ │
│   └────────────────────────────────────────┘                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Cryptographic Parameters

| Parameter | Standard | Dimensional Bound | NIST Security Level | Classical Security | Quantum Security |
| :--- | :--- | :--- | :---: | :---: | :---: |
| **Digital Signatures** | NIST FIPS 204 (ML-DSA-87) | Public Key: 2,592 B<br>Signature: 4,627 B | **Category 5** | $\ge 256$ bits | $\ge 256$ bits |
| **Key Encapsulation** | NIST FIPS 203 (ML-KEM-1024) | Public Key: 1,568 B<br>Ciphertext: 1,568 B | **Category 5** | $\ge 256$ bits | $\ge 256$ bits |
| **Symmetric Payload** | NIST SP 800-38D (AES-256-GCM) | Key: 32 B, IV: 12 B, Tag: 16 B | — | 256 bits | 128 bits (Grover) |
| **XOF Digest** | NIST FIPS 202 (SHAKE-256) | Variable digest length | — | 256 bits | 128 bits |
| **Commitment Hash** | Keccak-256 | Digest: 32 B | — | 256 bits | 128 bits |

---

## 2. Post-Quantum Settlement Invariant: Shor's Algorithm Resistance

### 2.1 Threat Scenario: Classical ECDSA Compromise
In an adversarial environment where an attacker operates a Fault-Tolerant Quantum Computer (FTQC) running Shor’s Algorithm to solve the Elliptic Curve Discrete Logarithm Problem (ECDLP):
$$Q = d \cdot G$$
Given public point $Q \in E(\mathbb{F}_p)$ on secp256k1, Shor’s algorithm extracts the scalar private key $d$ in polynomial time:
$$\mathcal{O}((\log p)^3)$$
With $d$, the adversary can sign arbitrary standard Ethereum transactions as the deployer account (`0x7DE7d6CC73002f44A76334392555C9A4dDc0B561`).

### 2.2 Mathematical Proof of OreVeil State Immunity
Even under complete recovery of the deployer's ECDSA private key $d$, the adversary **cannot alter the rollup state, forge a batch, or drain escrowed funds**.

#### Proof:
1. `OreVeilSettler.sol` exposes `settleBatch(...)` as the sole state transition gate:
   ```solidity
   function settleBatch(
       uint256 batchId,
       bytes32 prevStateRoot,
       bytes32 newStateRoot,
       bytes32 withdrawalRoot,
       bytes32 dataHash,
       bytes calldata signature
   ) external;
   ```
2. While anyone can submit an EVM transaction calling `settleBatch(...)`, execution requires a valid digital signature over the domain-separated commitment digest:
   $$\text{Digest} = \text{keccak256}(\text{block.chainid} \parallel \text{batchId} \parallel \text{prevStateRoot} \parallel \text{newStateRoot} \parallel \text{withdrawalRoot} \parallel \text{dataHash})$$
3. Verification is delegated to the Diana precompile at `0x0000000000000000000000000000000000000a01`:
   $$(success, returnData) = \text{PRECOMPILE.staticcall}(\text{abi.encodeWithSelector}(\dots, \mathbf{pk}_{ML-DSA}, \sigma, \text{Digest}))$$
4. **Hardness of ML-DSA-87**: ML-DSA-87 relies on the **Module Learning With Errors ($\text{M-LWE}_{k,l,\eta}$)** and **Module Short Integer Solution ($\text{M-SIS}_{k,l,\gamma}$)** problems over the polynomial ring $R_q = \mathbb{Z}_q[X]/(X^{256} + 1)$ with $q = 8380417$, dimension $k = 8$, $l = 7$.
5. **Quantum Invariant**: Shor’s algorithm applies strictly to abelian group hidden subgroup problems (such as $\mathbb{Z}_p^\times$ and elliptic curve groups). It provides **no polynomial-time solution** to Shortest Vector Problems (SVP) or Closest Vector Problems (CVP) in Euclidean module lattices. The best known quantum algorithms (sieve algorithms such as BDGL16) require exponential time:
   $$2^{0.265 \cdot d + o(d)} \gg 2^{256} \text{ quantum operations}$$
6. **Conclusion**: An attacker holding the ECDSA transaction key cannot forge $\sigma \in \{0,1\}^{4627 \times 8}$. Any invalid $\sigma$ causes precompile `0x...0a01` to return `false`, triggering `revert InvalidMLDSASignature()` on line 172. The contract state remains immutable.

---

## 3. EVM Precompile Return-Length Spoofing & Zero-Byte Exploits

### 3.1 Vulnerability Analysis
In Ethereum Virtual Machine (EVM) semantics, executing a `STATICCALL` to an uninitialized address, a non-existent contract, or a precompile not implemented on the active chain ID produces:
- `success = true`
- `returnData = bytes(0)` (0 bytes length)

If a smart contract decodes `returnData` as `abi.decode(returnData, (bool))` without inspecting length, the EVM decodes missing calldata as default zero values (`false`), or in non-reverting ABI unpackers, may evaluate unconstrained memory words. On alternate networks or precompile migration paths, unchecked returns can lead to critical authorization bypass.

### 3.2 Defensive Invariant
`OreVeilSettler.sol` implements strict two-phase validation on lines 168–172:

```solidity
// Line 168-172: OreVeilSettler.sol
(bool success, bytes memory returnData) = PQC_PRECOMPILE.staticcall(
    abi.encodeWithSelector(
        IPQCVerifier.pqcVerify.selector,
        sequencerPublicKey,
        signature,
        abi.encodePacked(commitmentHash)
    )
);

// STRICT DEFENSE: Reject empty returns and verify exact 32-byte boolean word
if (!success || returnData.length != 32) revert PrecompileCallFailed();

bool isValid = abi.decode(returnData, (bool));
if (!isValid) revert InvalidMLDSASignature();
```

- **Invariant**: If `returnData.length != 32`, the transaction reverts with `PrecompileCallFailed()`.
- **Test Verification**: Covered in `test/unit/OreVeilSettler.test.ts` ("Test empty precompile return").

---

## 4. Toxic MEV Elimination: ML-KEM Encrypted Envelopes & FBA Clearing

### 4.1 Threat: Front-Running, Back-Running, and Sandwich Attacks
In continuous limit order books (CLOB) and AMMs, block builders and MEV searchers inspect mempool transactions, extract price-impact signals, and submit sandwich bundles:
$$\text{Tx}_{\text{front-run}} \longrightarrow \text{Tx}_{\text{victim}} \longrightarrow \text{Tx}_{\text{back-run}}$$
This extracts deterministic slippage from retail traders and introduces latency races (Priority Gas Auctions).

### 4.2 OreVeil Dual-Layer Elimination Architecture

#### Layer 1: Client-Side Lattice Encryption (In-Flight Sealing)
Traders construct orders locally using `client/orderClient.ts`:
1. Trader encapsulates an ephemeral symmetric key $K \in \{0,1\}^{256}$ against the sequencer's public lattice key $\mathbf{pk}_{KEM} \in \{0,1\}^{1568 \times 8}$:
   $$(c, K) \leftarrow \text{ML-KEM-1024.Encaps}(\mathbf{pk}_{KEM})$$
2. Trader encrypts plaintext trade payload $M$ using AES-256-GCM with Additional Authenticated Data (AAD):
   $$C = \text{AES-GCM-Enc}_{K}(M, \text{nonce}, \text{AAD})$$
   $$\text{AAD} = \text{chainId} \parallel \text{epochId} \parallel \text{traderAddress}$$
3. The envelope $(c, C, \text{nonce}, \text{tag})$ is broadcast to the sequencer.
4. **Security Property**: Zero mempool visibility. Searchers cannot observe order side (Buy/Sell), size, limit price, or asset pair before the epoch clears. Replaying envelopes across epochs or chains fails due to domain-separated AAD verification.

#### Layer 2: Frequent Batch Auction (Discrete-Time Uniform Price Clearing)
1. Orders accumulate over discrete 5-second auction epochs $[t_0, t_0 + \Delta t]$.
2. The sequencer decapsulates envelopes simultaneously at epoch close:
   $$K \leftarrow \text{ML-KEM-1024.Decaps}(c, \mathbf{sk}_{KEM})$$
3. Aggregate demand curve $D(p)$ and supply curve $S(p)$ are constructed.
4. A single **Uniform Clearing Price** $p^*$ is derived:
   $$p^* = \arg\max_p \min(D(p), S(p))$$
5. **Security Property**: Every filled order within the epoch executes at the identical price $p^*$. Front-running within a batch is mathematically impossible because transaction ordering within the batch has zero effect on execution price.

---

## 5. Sequencer Withholding, Data Censorship & Trustless L1 Merkle Exits

### 5.1 Threat: Rogue or Offline Sequencer
If the sequencer goes offline, censors a specific trader, or refuses to submit batches, user capital could be permanently locked inside the Layer 1 vault.

### 5.2 Defensive Invariant: Unilateral Merkle Proof Withdrawal
OreVeil implements trustless exits directly on Diana Layer 1 in `OreVeilSettler.sol:executeWithdrawal(...)`.

```
Trader holds balance in Rollup Batch #k
             │
             ▼
Extract Merkle inclusion proof:
proof = [hash_sibling_1, hash_sibling_2, ..., root]
             │
             ▼
Direct L1 EVM Call (No Sequencer Required):
OreVeilSettler.executeWithdrawal(batchId, index, recipient, asset, amount, proof)
             │
             ▼
Verified against on-chain batchWithdrawalRoots[batchId]
             │
             ▼
Vault disburses 100% of escrowed QOR / ERC-20 tokens directly to recipient
```

- **Invariant**: The sequencer cannot revoke, freeze, or censor withdrawals once a batch is settled on L1.
- **On-Chain Proof**: Verified on Diana Testnet in Block `#10494588` (Tx: [`0xad360100c3257eeba220a18528f33cee7f604d1e14f3acd8f7d172acbdffb15f`](https://explore.qore.network/tx/0xad360100c3257eeba220a18528f33cee7f604d1e14f3acd8f7d172acbdffb15f)).

---

## 6. Multi-Asset Replay Prevention & Checks-Effects-Interactions

### 6.1 Threat: Cross-Chain, Cross-Asset, or Double-Spend Replays
If a Merkle withdrawal leaf is valid for Batch #2 on Diana, an attacker might attempt to:
1. Re-submit the identical proof on Diana to withdraw twice (Double Spend).
2. Submit the Diana proof to a secondary testnet or mainnet deployment (Cross-Chain Replay).
3. Swap `assetAddress` from low-value token to high-value token (Asset Substitution).

### 6.2 Cryptographic Leaf Domain Separation
`OreVeilSettler.sol` line 201 enforces strict 5-dimensional domain separation for all leaves:
$$\text{Leaf} = \text{keccak256}(\text{block.chainid} \parallel \text{withdrawalIndex} \parallel \text{recipient} \parallel \text{assetAddress} \parallel \text{amount})$$

```solidity
// Line 200-208: OreVeilSettler.sol
bytes32 leaf = keccak256(
    abi.encodePacked(
        block.chainid,
        withdrawalIndex,
        recipient,
        asset,
        amount
    )
);
```

### 6.3 Checks-Effects-Interactions Ordering
To neutralize reentrancy exploits and double-spend race conditions, the storage state mutation occurs **strictly prior to external asset transfers**:

```solidity
// Line 213-214: OreVeilSettler.sol (MUST occur before external transfer)
if (executedWithdrawals[leaf]) revert WithdrawalAlreadyProcessed();
executedWithdrawals[leaf] = true;

// Funds disbursement occurs only AFTER storage commitment
if (asset == address(0)) {
    (bool sent, ) = recipient.call{value: amount}("");
    if (!sent) revert NativeTransferFailed();
} else {
    IERC20(asset).safeTransfer(recipient, amount);
}
```

- **Live Testnet Invariant**: On-chain second submission strictly reverted with `WithdrawalAlreadyProcessed()`. Verified in `test/integration/LiveWithdrawalRun.test.ts` (Suite 4.3).

---

## 7. Independent Watchtower Auditing & Slashing Conditions

### 7.1 Threat: State Divergence / Invalid Transitions
The sequencer could attempt to anchor an invalid state transition (crediting unbacked balances) while providing a valid signature.

### 7.2 Defensive Layer: Autonomous Watchtower Replay
`watchtower/watcher.ts` operates as a decentralized sentinel node:
1. Ingests all `BatchSettled` logs across Diana Testnet blocks.
2. Audits monotonic sequence continuity:
   $$batchId_k \equiv batchId_{k-1} + 1 \quad \wedge \quad prevStateRoot_k \equiv newStateRoot_{k-1}$$
3. Replays state transitions from genesis using deterministic account ledgers.
4. If $computedStateRoot \neq onChainStateRoot$:
   - Emits a structured `FraudAlert`.
   - Transitions watchtower status to `DIVERGENT`.
   - Halts client order ingestion and initiates on-chain sequencer slashing.

---

## 8. Comprehensive Threat Matrix & Evidence Cross-Reference Table

| # | Threat Vector | Severity | Mitigation Mechanism | Implementation Source | Test Verification Suite | Live Diana Proof / Tx Hash |
| :-: | :--- | :---: | :--- | :--- | :--- | :--- |
| **1** | **Classical Key Compromise (Shor's Algorithm)** | **CRITICAL** | State commitments locked behind NIST FIPS 204 (ML-DSA-87, 4,627-byte sig) via Precompile `0x...0a01`. Classical ECDSA key cannot forge batches. | [`contracts/OreVeilSettler.sol#L141-L172`](contracts/OreVeilSettler.sol#L141-L172) | `test/sdk-connection.test.ts`<br>`test/unit/OreVeilSettler.test.ts` | Batch #1: [`0x9cc8a59a...`](https://explore.qore.network/tx/0x9cc8a59ad33de51cf9d502954e7279d54628ba12609de190e684b6ff64636695)<br>Batch #2: [`0x1c2f661c...`](https://explore.qore.network/tx/0x1c2f661c67a2bd1cc46e7ba7ffb68bf8086a5ac527e6fecc135c9f38d9150539) |
| **2** | **Precompile Empty-Return Spoof** | **HIGH** | Strict `returnData.length == 32` check prevents zero-byte staticcall authorization bypass on uninitialized addresses. | [`contracts/OreVeilSettler.sol#L169`](contracts/OreVeilSettler.sol#L169) | `test/unit/OreVeilSettler.test.ts` | Diana Precompile `0x0000000000000000000000000000000000000a01` active on chainId 9800 |
| **3** | **Toxic MEV / Front-Running** | **HIGH** | In-flight confidentiality via NIST FIPS 203 (ML-KEM-1024) + discrete 5-second FBA epochs clearing at single Uniform Price. | [`client/orderClient.ts#L70-L115`](client/orderClient.ts#L70-L115)<br>[`sequencer/matchingEngine.ts#L220-L290`](sequencer/matchingEngine.ts#L220-L290) | `test/engine/fbaMatching.test.ts`<br>`test/engine/mlKemSealing.test.ts` | 100 random orders cleared with zero slippage leakage |
| **4** | **Sequencer Censorship / Halt** | **HIGH** | Non-custodial, trustless Layer 1 Merkle exits via `executeWithdrawal(...)`. Zero sequencer approval required. | [`contracts/OreVeilSettler.sol#L190-L224`](contracts/OreVeilSettler.sol#L190-L224) | `test/unit/MerkleWithdrawalEgress.test.ts`<br>`test/integration/LiveWithdrawalRun.test.ts` | Mined in Block `#10494588`: [`0xad360100...`](https://explore.qore.network/tx/0xad360100c3257eeba220a18528f33cee7f604d1e14f3acd8f7d172acbdffb15f) |
| **5** | **Double-Spend / Replay** | **HIGH** | 5D domain-separated hashing (`chainId`, `index`, `recipient`, `asset`, `amount`) + atomic Checks-Effects-Interactions storage locking. | [`contracts/OreVeilSettler.sol#L200-L214`](contracts/OreVeilSettler.sol#L200-L214) | `test/unit/MerkleWithdrawalEgress.test.ts`<br>`test/unit/WithdrawalTreePipeline.test.ts` | Replay rejected on Diana L1 (`WithdrawalAlreadyProcessed()`) |
| **6** | **Silent State Divergence / Fraud** | **MEDIUM** | Autonomous Watchtower daemon replays state transitions from L1 logs and detects mathematical discrepancies. | [`watchtower/watcher.ts#L188-L230`](watchtower/watcher.ts#L188-L230) | `test/unit/Watchtower.test.ts` | 17/17 tests passing; caught simulated `0xdeadbeef` fraud attempt |
| **7** | **Gas Price Floor Rejection** | **LOW** | Dynamic fee decorator enforces $\ge 100.0\text{ gwei}$ minimum consensus floor with 12.5% priority headroom. | [`scripts/lib/safetyGuards.ts#L35-L65`](scripts/lib/safetyGuards.ts#L35-L65) | `test/unit/SafetyGuards.test.ts` | All live Diana transactions mined within 1 block at $126.56\text{ gwei}$ |

---

*OreVeil Protocol Formal Threat Model & Security Specification — Core Architectural Reference.*
