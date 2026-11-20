import { expect } from "chai";
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import {
  computeWithdrawalLeaf,
  hashPair,
  WithdrawalTree,
  WithdrawalEntry,
  prepareBatch2Payload,
  simulateBatch2Settlement,
  formatBatch2SimulationReport,
  loadSequencerKeypair
} from "../../scripts/lib/withdrawalTreePipeline";
import {
  DEFAULT_DIANA_RPC,
  DEFAULT_SETTLER_ADDRESS,
  DEFAULT_DEPLOYER_EVM
} from "../../scripts/lib/dryRunSimulation";
import {
  DIANA_CHAIN_ID,
  DIANA_MIN_GAS_FLOOR_WEI
} from "../../scripts/lib/safetyGuards";
import { OreVeilSettler__factory } from "../../typechain-types/factories/contracts/OreVeilSettler__factory";
import {
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SIGNATURE_LENGTH,
  pqVerify
} from "@qorechain/qoresign";

dotenv.config();

describe("Sub-Phase 3.2 Layer 2: Off-Chain Merkle Withdrawal Tree Pipeline & Batch #2 Quantum Anchor (Zero Mocks)", function () {
  this.timeout(90000); // 90s for live Diana network operations

  let provider: ethers.JsonRpcProvider;
  let onChainLatestBatchId: number;
  let onChainLatestStateRoot: string;

  before(async function () {
    provider = new ethers.JsonRpcProvider(DEFAULT_DIANA_RPC, undefined, {
      staticNetwork: ethers.Network.from(DIANA_CHAIN_ID)
    });

    const settler = OreVeilSettler__factory.connect(DEFAULT_SETTLER_ADDRESS, provider);

    // Resilient network query with retry for Windows DNS EAI_AGAIN
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        onChainLatestBatchId = Number(await settler.latestBatchId());
        onChainLatestStateRoot = await settler.latestStateRoot();
        break;
      } catch (err: any) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  });

  // =========================================================================
  // Dimension 1: Domain-Separated Leaf Serialization
  // =========================================================================
  describe("Dimension 1: Domain-Separated Leaf Serialization", function () {
    it("D1-1: should compute withdrawal leaf matching Solidity keccak256(abi.encodePacked(...))", function () {
      const recipient = DEFAULT_DEPLOYER_EVM;
      const asset = ethers.ZeroAddress;
      const amount = ethers.parseEther("1.0");
      const index = 0;

      const leaf = computeWithdrawalLeaf(DIANA_CHAIN_ID, index, recipient, asset, amount);

      // Verify manual encoding parity
      const manualPacked = ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "address", "address", "uint256"],
        [BigInt(DIANA_CHAIN_ID), BigInt(index), recipient, asset, amount]
      );

      expect(leaf).to.equal(manualPacked);
      expect(leaf).to.match(/^0x[0-9a-fA-F]{64}$/);
    });

    it("D1-2: should exhibit avalanche effect when any parameter is altered", function () {
      const baseLeaf = computeWithdrawalLeaf(
        DIANA_CHAIN_ID,
        0,
        DEFAULT_DEPLOYER_EVM,
        ethers.ZeroAddress,
        ethers.parseEther("1.0")
      );

      const modifiedIndex = computeWithdrawalLeaf(
        DIANA_CHAIN_ID,
        1, // modified index
        DEFAULT_DEPLOYER_EVM,
        ethers.ZeroAddress,
        ethers.parseEther("1.0")
      );

      const modifiedChainId = computeWithdrawalLeaf(
        1, // cross-chain attempt
        0,
        DEFAULT_DEPLOYER_EVM,
        ethers.ZeroAddress,
        ethers.parseEther("1.0")
      );

      const modifiedAmount = computeWithdrawalLeaf(
        DIANA_CHAIN_ID,
        0,
        DEFAULT_DEPLOYER_EVM,
        ethers.ZeroAddress,
        ethers.parseEther("1.000000000000000001") // 1 wei diff
      );

      expect(baseLeaf).to.not.equal(modifiedIndex);
      expect(baseLeaf).to.not.equal(modifiedChainId);
      expect(baseLeaf).to.not.equal(modifiedAmount);
    });

    it("D1-3: should normalize native asset identifiers seamlessly", function () {
      const leaf1 = computeWithdrawalLeaf(DIANA_CHAIN_ID, 0, DEFAULT_DEPLOYER_EVM, ethers.ZeroAddress, 100n);
      const leaf2 = computeWithdrawalLeaf(DIANA_CHAIN_ID, 0, DEFAULT_DEPLOYER_EVM, "", 100n);
      expect(leaf1).to.equal(leaf2);
    });
  });

  // =========================================================================
  // Dimension 2: Merkle Tree Construction & OpenZeppelin Proof Parity
  // =========================================================================
  describe("Dimension 2: Merkle Tree Construction & OpenZeppelin Proof Parity", function () {
    it("D2-1: should build Merkle tree for single entry where root equals leaf", function () {
      const entry: WithdrawalEntry = {
        withdrawalIndex: 0,
        recipient: DEFAULT_DEPLOYER_EVM,
        asset: ethers.ZeroAddress,
        amount: ethers.parseEther("1.0")
      };

      const tree = new WithdrawalTree([entry], DIANA_CHAIN_ID);
      expect(tree.leaves.length).to.equal(1);
      expect(tree.getRoot()).to.equal(tree.leaves[0]);
      expect(tree.getProof(0)).to.deep.equal([]);
      expect(tree.verifyProof(tree.leaves[0], [])).to.be.true;
    });

    it("D2-2: should build balanced tree for 2 entries and generate valid commutative proofs", function () {
      const entries: WithdrawalEntry[] = [
        {
          withdrawalIndex: 0,
          recipient: DEFAULT_DEPLOYER_EVM,
          asset: ethers.ZeroAddress,
          amount: ethers.parseEther("1.0")
        },
        {
          withdrawalIndex: 1,
          recipient: "0x1111111111111111111111111111111111111111",
          asset: ethers.ZeroAddress,
          amount: ethers.parseEther("2.0")
        }
      ];

      const tree = new WithdrawalTree(entries, DIANA_CHAIN_ID);
      expect(tree.leaves.length).to.equal(2);

      const expectedRoot = hashPair(tree.leaves[0], tree.leaves[1]);
      expect(tree.getRoot()).to.equal(expectedRoot);

      // Verify proof for leaf 0
      const proof0 = tree.getProof(0);
      expect(proof0.length).to.equal(1);
      expect(proof0[0]).to.equal(tree.leaves[1]);
      expect(tree.verifyProof(tree.leaves[0], proof0)).to.be.true;

      // Verify proof for leaf 1
      const proof1 = tree.getProof(1);
      expect(proof1.length).to.equal(1);
      expect(proof1[0]).to.equal(tree.leaves[0]);
      expect(tree.verifyProof(tree.leaves[1], proof1)).to.be.true;
    });

    it("D2-3: should build tree for non-power-of-two (3 entries) and verify all proofs", function () {
      const entries: WithdrawalEntry[] = [
        { withdrawalIndex: 0, recipient: DEFAULT_DEPLOYER_EVM, asset: ethers.ZeroAddress, amount: 100n },
        { withdrawalIndex: 1, recipient: "0x2222222222222222222222222222222222222222", asset: ethers.ZeroAddress, amount: 200n },
        { withdrawalIndex: 2, recipient: "0x3333333333333333333333333333333333333333", asset: ethers.ZeroAddress, amount: 300n }
      ];

      const tree = new WithdrawalTree(entries, DIANA_CHAIN_ID);
      for (let i = 0; i < entries.length; i++) {
        const proof = tree.getProof(i);
        expect(tree.verifyProof(tree.leaves[i], proof)).to.be.true;
      }
    });

    it("D2-4: should reject invalid leaf or tampered proof", function () {
      const entries: WithdrawalEntry[] = [
        { withdrawalIndex: 0, recipient: DEFAULT_DEPLOYER_EVM, asset: ethers.ZeroAddress, amount: 100n },
        { withdrawalIndex: 1, recipient: "0x2222222222222222222222222222222222222222", asset: ethers.ZeroAddress, amount: 200n }
      ];

      const tree = new WithdrawalTree(entries, DIANA_CHAIN_ID);
      const proof0 = tree.getProof(0);

      // Tampered leaf
      const fakeLeaf = ethers.keccak256(ethers.toUtf8Bytes("forged"));
      expect(tree.verifyProof(fakeLeaf, proof0)).to.be.false;

      // Tampered proof sibling
      const forgedProof = [ethers.ZeroHash];
      expect(tree.verifyProof(tree.leaves[0], forgedProof)).to.be.false;
    });
  });

  // =========================================================================
  // Dimension 3: Batch #2 State Continuity & Monotonicity Guards
  // =========================================================================
  describe("Dimension 3: Batch #2 State Continuity & Monotonicity Guards", function () {
    it("D3-1: should synchronize live on-chain state and target targetBatchId == onChainLatestBatchId + 1", async function () {
      const payload = await prepareBatch2Payload({ provider });
      expect(payload.batchId).to.equal(onChainLatestBatchId + 1);
      expect(payload.batchId).to.be.at.least(2);
    });

    it("D3-2: should enforce prevStateRoot strictly equals live on-chain latestStateRoot", async function () {
      const payload = await prepareBatch2Payload({ provider });
      expect(payload.prevStateRoot).to.equal(onChainLatestStateRoot);
      expect(payload.prevStateRoot).to.match(/^0x[0-9a-fA-F]{64}$/);
    });

    it("D3-3: should incorporate non-zero active withdrawalRoot and attached proof", async function () {
      const payload = await prepareBatch2Payload({ provider });
      expect(payload.withdrawalRoot).to.not.equal(ethers.ZeroHash);
      expect(payload.withdrawalRoot).to.match(/^0x[0-9a-fA-F]{64}$/);
      expect(payload.withdrawalEntries.length).to.be.at.least(1);

      const aliceEntry = payload.withdrawalEntries[0];
      expect(aliceEntry.leafHash).to.not.be.undefined;
      expect(aliceEntry.proof).to.not.be.undefined;
      expect(aliceEntry.amount).to.equal(ethers.parseEther("1.0"));
    });
  });

  // =========================================================================
  // Dimension 4: NIST FIPS 204 ML-DSA-87 Digital Signature Parity
  // =========================================================================
  describe("Dimension 4: NIST FIPS 204 ML-DSA-87 Digital Signature Parity", function () {
    it("D4-1: should produce digital signature of strictly 4,627 bytes", async function () {
      const payload = await prepareBatch2Payload({ provider });
      const sigBytes = ethers.getBytes(payload.signature);
      expect(sigBytes.length).to.equal(ML_DSA_87_SIGNATURE_LENGTH);
    });

    it("D4-2: should verify signature validates locally via pqVerify against sequencer key", async function () {
      const keypair = loadSequencerKeypair();
      expect(keypair.publicKey.length).to.equal(ML_DSA_87_PUBLIC_KEY_LENGTH);

      const payload = await prepareBatch2Payload({ provider });
      const valid = pqVerify(
        keypair.publicKey,
        ethers.getBytes(payload.commitmentHash),
        ethers.getBytes(payload.signature)
      );

      expect(valid).to.be.true;
    });

    it("D4-3: should reject tampered commitment digest during local validation", async function () {
      const keypair = loadSequencerKeypair();
      const payload = await prepareBatch2Payload({ provider });

      const tamperedDigest = ethers.keccak256(ethers.toUtf8Bytes("tampered"));
      const valid = pqVerify(
        keypair.publicKey,
        ethers.getBytes(tamperedDigest),
        ethers.getBytes(payload.signature)
      );

      expect(valid).to.be.false;
    });
  });

  // =========================================================================
  // Dimension 5: Live Diana EVM Simulation Rehearsal
  // =========================================================================
  describe("Dimension 5: Live Diana EVM Simulation Rehearsal", function () {
    it("D5-1: should successfully simulate Batch #2 settlement carrying active withdrawalRoot on Diana Testnet", async function () {
      const payload = await prepareBatch2Payload({ provider });
      const report = await simulateBatch2Settlement(payload, { provider });

      expect(report.success).to.be.true;
      expect(report.batchId).to.equal(payload.batchId);
      expect(report.withdrawalRoot).to.equal(payload.withdrawalRoot);
      expect(report.simulatedGas).to.be.greaterThan(100000n);
      expect(report.simulatedGas).to.be.lessThan(3000000n);
      expect(report.effectiveGasPriceWei).to.be.at.least(DIANA_MIN_GAS_FLOOR_WEI);
    });

    it("D5-2: should format clean diagnostic simulation rehearsal report", async function () {
      const payload = await prepareBatch2Payload({ provider });
      const report = await simulateBatch2Settlement(payload, { provider });

      const formatted = formatBatch2SimulationReport(report);
      expect(formatted).to.include("OREVEIL BATCH #2 WITH ACTIVE MERKLE WITHDRAWAL ROOT REHEARSAL");
      expect(formatted).to.include("PASS [SIMULATED]");
      expect(formatted).to.include(payload.withdrawalRoot);
      expect(formatted).to.include(DEFAULT_SETTLER_ADDRESS);
    });
  });
});
