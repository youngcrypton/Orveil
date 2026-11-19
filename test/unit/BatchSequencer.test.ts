import { expect } from "chai";
import { ethers } from "hardhat";
import * as crypto from "crypto";
import {
  BatchSequencer,
  DIANA_CHAIN_ID,
  DIANA_MIN_GAS_FLOOR,
  BatchCommitmentPayload
} from "../../sequencer/batchSequencer";
import {
  executeBatchFBA,
  AccountLedger,
  BatchExecutionResult
} from "../../sequencer/matchingEngine";
import {
  generateKemKeypair,
  sealOrder,
  unsealOrder,
  OrderParams
} from "../../client/orderClient";
import {
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SECRET_KEY_LENGTH,
  ML_DSA_87_SIGNATURE_LENGTH
} from "@qorechain/qoresign";
import { OreVeilSettler } from "../../typechain-types";

describe("Sub-Phase 2.3: L1 Batch Anchor Signer & Diana EVM Submitter", function () {
  let settler: OreVeilSettler;
  let owner: any;
  let sequencer: BatchSequencer;
  let chainId: number;

  const PQC_PRECOMPILE = "0x0000000000000000000000000000000000000a01";
  const BYTECODE_RETURN_TRUE = "0x600160005260206000f3"; // PUSH1 0x01, PUSH1 0x00, MSTORE, PUSH1 0x20, PUSH1 0x00, RETURN (true)
  const BYTECODE_RETURN_FALSE = "0x600060005260206000f3"; // PUSH1 0x00, PUSH1 0x00, MSTORE, PUSH1 0x20, PUSH1 0x00, RETURN (false)

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    chainId = Number((await ethers.provider.getNetwork()).chainId);

    // Generate real ML-DSA-87 sequencer keypair
    const keypair = BatchSequencer.generateKeypair();

    // Reset precompile mock on local Hardhat EVM to return true
    await ethers.provider.send("hardhat_setCode", [PQC_PRECOMPILE, BYTECODE_RETURN_TRUE]);

    // Deploy OreVeilSettler initialized with the sequencer's ML-DSA-87 public key
    const OreVeilSettlerFactory = await ethers.getContractFactory("OreVeilSettler");
    const pubKeyHex = "0x" + Buffer.from(keypair.publicKey).toString("hex");
    settler = (await OreVeilSettlerFactory.deploy(owner.address, pubKeyHex)) as OreVeilSettler;
    await settler.waitForDeployment();

    const settlerAddress = await settler.getAddress();
    sequencer = new BatchSequencer(keypair, settlerAddress, chainId);
  });

  describe("Layer 1: Commitment Hash Parity & Domain Separation Invariants", function () {
    it("should match Solidity abi.encodePacked and keccak256 byte-for-byte", function () {
      const batchId = 1;
      const prevStateRoot = ethers.ZeroHash;
      const newStateRoot = ethers.keccak256(Buffer.from("new-state-1"));
      const withdrawalRoot = ethers.keccak256(Buffer.from("withdrawals-1"));
      const dataHash = ethers.keccak256(Buffer.from("data-1"));

      const computedHash = BatchSequencer.computeCommitmentHash(
        chainId,
        batchId,
        prevStateRoot,
        newStateRoot,
        withdrawalRoot,
        dataHash
      );

      const expectedSolidityHash = ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "bytes32", "bytes32", "bytes32", "bytes32"],
        [BigInt(chainId), BigInt(batchId), prevStateRoot, newStateRoot, withdrawalRoot, dataHash]
      );

      expect(computedHash).to.equal(expectedSolidityHash);
    });

    it("should enforce strict chainId domain separation (cross-chain replay protection)", function () {
      const batchId = 1;
      const prevStateRoot = ethers.ZeroHash;
      const newStateRoot = ethers.keccak256(Buffer.from("new-state"));
      const withdrawalRoot = ethers.ZeroHash;
      const dataHash = ethers.ZeroHash;

      const hashDiana = BatchSequencer.computeCommitmentHash(
        9800,
        batchId,
        prevStateRoot,
        newStateRoot,
        withdrawalRoot,
        dataHash
      );
      const hashEth = BatchSequencer.computeCommitmentHash(
        1,
        batchId,
        prevStateRoot,
        newStateRoot,
        withdrawalRoot,
        dataHash
      );
      const hashHardhat = BatchSequencer.computeCommitmentHash(
        31337,
        batchId,
        prevStateRoot,
        newStateRoot,
        withdrawalRoot,
        dataHash
      );

      expect(hashDiana).to.not.equal(hashEth);
      expect(hashDiana).to.not.equal(hashHardhat);
      expect(hashEth).to.not.equal(hashHardhat);
    });

    it("should exhibit avalanche effect when any single parameter is modified", function () {
      const baseArgs = {
        chainId: 9800,
        batchId: 1,
        prevStateRoot: ethers.keccak256(Buffer.from("state-0")),
        newStateRoot: ethers.keccak256(Buffer.from("state-1")),
        withdrawalRoot: ethers.keccak256(Buffer.from("w-1")),
        dataHash: ethers.keccak256(Buffer.from("d-1"))
      };

      const baseline = BatchSequencer.computeCommitmentHash(
        baseArgs.chainId,
        baseArgs.batchId,
        baseArgs.prevStateRoot,
        baseArgs.newStateRoot,
        baseArgs.withdrawalRoot,
        baseArgs.dataHash
      );

      // Mutate batchId
      const mutBatchId = BatchSequencer.computeCommitmentHash(
        baseArgs.chainId,
        2,
        baseArgs.prevStateRoot,
        baseArgs.newStateRoot,
        baseArgs.withdrawalRoot,
        baseArgs.dataHash
      );
      expect(mutBatchId).to.not.equal(baseline);

      // Mutate prevStateRoot
      const mutPrevState = BatchSequencer.computeCommitmentHash(
        baseArgs.chainId,
        baseArgs.batchId,
        ethers.keccak256(Buffer.from("state-different")),
        baseArgs.newStateRoot,
        baseArgs.withdrawalRoot,
        baseArgs.dataHash
      );
      expect(mutPrevState).to.not.equal(baseline);

      // Mutate newStateRoot
      const mutNewState = BatchSequencer.computeCommitmentHash(
        baseArgs.chainId,
        baseArgs.batchId,
        baseArgs.prevStateRoot,
        ethers.keccak256(Buffer.from("state-mutated")),
        baseArgs.withdrawalRoot,
        baseArgs.dataHash
      );
      expect(mutNewState).to.not.equal(baseline);

      // Mutate withdrawalRoot
      const mutWithdrawal = BatchSequencer.computeCommitmentHash(
        baseArgs.chainId,
        baseArgs.batchId,
        baseArgs.prevStateRoot,
        baseArgs.newStateRoot,
        ethers.ZeroHash,
        baseArgs.dataHash
      );
      expect(mutWithdrawal).to.not.equal(baseline);

      // Mutate dataHash
      const mutData = BatchSequencer.computeCommitmentHash(
        baseArgs.chainId,
        baseArgs.batchId,
        baseArgs.prevStateRoot,
        baseArgs.newStateRoot,
        baseArgs.withdrawalRoot,
        ethers.ZeroHash
      );
      expect(mutData).to.not.equal(baseline);
    });
  });

  describe("Layer 2: NIST FIPS 204 (ML-DSA-87) Cryptographic Invariants", function () {
    it("should derive ML-DSA-87 keypair with strict dimensions (2,592B pubkey, 4,896B secretKey)", function () {
      const keypair = BatchSequencer.generateKeypair();
      expect(keypair.publicKey.length).to.equal(ML_DSA_87_PUBLIC_KEY_LENGTH);
      expect(keypair.publicKey.length).to.equal(2592);
      expect(keypair.secretKey.length).to.equal(ML_DSA_87_SECRET_KEY_LENGTH);
      expect(keypair.secretKey.length).to.equal(4896);
    });

    it("should produce signature of strictly 4,627 bytes", function () {
      const hash = ethers.keccak256(Buffer.from("test-commitment-hash"));
      const sigHex = sequencer.signCommitment(hash);
      const sigBytes = ethers.getBytes(sigHex);

      expect(sigBytes.length).to.equal(ML_DSA_87_SIGNATURE_LENGTH);
      expect(sigBytes.length).to.equal(4627);
      expect(sigHex.length).to.equal(2 + 4627 * 2);
    });

    it("should verify valid signature locally via pqVerify", function () {
      const hash = ethers.keccak256(Buffer.from("test-verification-hash"));
      const sigHex = sequencer.signCommitment(hash);
      const isValid = sequencer.verifySignatureLocally(hash, sigHex);

      expect(isValid).to.be.true;
    });

    it("should reject tampered commitment hash during local verification", function () {
      const hash = ethers.keccak256(Buffer.from("original-hash"));
      const sigHex = sequencer.signCommitment(hash);

      const tamperedHash = ethers.keccak256(Buffer.from("tampered-hash"));
      const isValid = sequencer.verifySignatureLocally(tamperedHash, sigHex);

      expect(isValid).to.be.false;
    });

    it("should reject tampered signature (single bit flip) during local verification", function () {
      const hash = ethers.keccak256(Buffer.from("valid-hash"));
      const sigHex = sequencer.signCommitment(hash);

      const sigBytes = ethers.getBytes(sigHex);
      sigBytes[100] ^= 0x01; // flip 1 bit
      const tamperedSigHex = ethers.hexlify(sigBytes);

      const isValid = sequencer.verifySignatureLocally(hash, tamperedSigHex);
      expect(isValid).to.be.false;
    });

    it("should reject verification against an unauthorized public key", function () {
      const hash = ethers.keccak256(Buffer.from("auth-test"));
      const sigHex = sequencer.signCommitment(hash);

      const otherKeypair = BatchSequencer.generateKeypair();
      const isValid = sequencer.verifySignatureLocally(hash, sigHex, otherKeypair.publicKey);

      expect(isValid).to.be.false;
    });

    it("should revert instantiation if key dimensions are invalid", function () {
      const shortPub = new Uint8Array(100);
      const validSec = new Uint8Array(ML_DSA_87_SECRET_KEY_LENGTH);
      expect(
        () => new BatchSequencer({ publicKey: shortPub, secretKey: validSec }, ethers.ZeroAddress)
      ).to.throw("Invalid ML-DSA-87 public key length");

      const validPub = new Uint8Array(ML_DSA_87_PUBLIC_KEY_LENGTH);
      const shortSec = new Uint8Array(100);
      expect(
        () => new BatchSequencer({ publicKey: validPub, secretKey: shortSec }, ethers.ZeroAddress)
      ).to.throw("Invalid ML-DSA-87 secret key length");
    });
  });

  describe("Layer 3: State Synchronization & Monotonicity Guards", function () {
    it("should correctly synchronize latestBatchId and latestStateRoot from settler contract", async function () {
      const state = await sequencer.syncState(settler);
      expect(state.latestBatchId).to.equal(0n);
      expect(state.latestStateRoot).to.equal(ethers.ZeroHash);
    });

    it("should reject preparing batch if expectedBatchId does not match result.batchId", function () {
      const mockResult: BatchExecutionResult = {
        batchId: 2, // mismatch with expected 1
        epochId: 1,
        clearingPrice: 0n,
        totalVolume: 0n,
        fills: [],
        prevStateRoot: ethers.ZeroHash,
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        unfilledOrders: []
      };

      expect(() => sequencer.prepareAndSignBatch(mockResult, 1, ethers.ZeroHash)).to.throw(
        "Batch sequence mismatch"
      );
    });

    it("should reject preparing batch if expectedPrevStateRoot does not match result.prevStateRoot", function () {
      const mockResult: BatchExecutionResult = {
        batchId: 1,
        epochId: 1,
        clearingPrice: 0n,
        totalVolume: 0n,
        fills: [],
        prevStateRoot: ethers.keccak256(Buffer.from("stale-state")),
        newStateRoot: ethers.ZeroHash,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        unfilledOrders: []
      };

      expect(() => sequencer.prepareAndSignBatch(mockResult, 1, ethers.ZeroHash)).to.throw(
        "State root mismatch"
      );
    });
  });

  describe("Layer 4: Calldata Encoding, Gas Floor & Simulation Guards", function () {
    it("should encode settleBatch calldata matching ABI and exceeding 4.6KB", function () {
      const payload: BatchCommitmentPayload = {
        batchId: 1,
        prevStateRoot: ethers.ZeroHash,
        newStateRoot: ethers.keccak256(Buffer.from("new-state")),
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        commitmentHash: ethers.ZeroHash,
        signature: sequencer.signCommitment(ethers.ZeroHash),
        chainId
      };

      const iface = settler.interface;
      const calldata = iface.encodeFunctionData("settleBatch", [
        BigInt(payload.batchId),
        payload.prevStateRoot,
        payload.newStateRoot,
        payload.withdrawalRoot,
        payload.dataHash,
        payload.signature
      ]);

      // 4627 bytes signature + 4 words of 32 bytes + batchId (32 bytes) + offsets/length words
      // Total calldata exceeds 4,800 bytes
      expect(ethers.getBytes(calldata).length).to.be.greaterThan(4800);
    });

    it("should successfully simulate settlement via simulateSettlement staticcall", async function () {
      const mockResult: BatchExecutionResult = {
        batchId: 1,
        epochId: 1,
        clearingPrice: 0n,
        totalVolume: 0n,
        fills: [],
        prevStateRoot: ethers.ZeroHash,
        newStateRoot: ethers.keccak256(Buffer.from("state-1")),
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        unfilledOrders: []
      };

      const payload = sequencer.prepareAndSignBatch(mockResult, 1, ethers.ZeroHash);
      const canSettle = await sequencer.simulateSettlement(settler, payload);
      expect(canSettle).to.be.true;
    });

    it("should return false in simulateSettlement when batch parameters are invalid", async function () {
      // Create invalid batchId (2 instead of 1)
      const mockResult: BatchExecutionResult = {
        batchId: 99,
        epochId: 1,
        clearingPrice: 0n,
        totalVolume: 0n,
        fills: [],
        prevStateRoot: ethers.ZeroHash,
        newStateRoot: ethers.keccak256(Buffer.from("state-1")),
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        unfilledOrders: []
      };

      const payload = sequencer.prepareAndSignBatch(mockResult);
      const canSettle = await sequencer.simulateSettlement(settler, payload);
      expect(canSettle).to.be.false;
    });
  });

  describe("Layer 5: End-to-End On-Chain Settlement Pipeline & Multi-Batch Stress Tests", function () {
    it("should execute full end-to-end pipeline: match orders -> prepareAndSignBatch -> submitBatch -> verify event", async function () {
      const ledger = new AccountLedger();
      const trader1 = "0x7DE7d6CC73002f44A76334392555C9A4dDc0B561";
      const trader2 = "0x1111111111111111111111111111111111111111";
      const FUSD = "0x2222222222222222222222222222222222222222";

      // 1. Pre-fund accounts and initialize genesis state on-chain
      ledger.credit(trader1, FUSD, ethers.parseEther("1000.0"));
      ledger.credit(trader2, ethers.ZeroAddress, 100n * 10n ** 6n);
      const genesisRoot = ledger.computeStateRoot();

      const genesisHash = BatchSequencer.computeCommitmentHash(
        chainId,
        1,
        ethers.ZeroHash,
        genesisRoot,
        ethers.ZeroHash,
        ethers.ZeroHash
      );
      const genesisPayload: BatchCommitmentPayload = {
        batchId: 1,
        prevStateRoot: ethers.ZeroHash,
        newStateRoot: genesisRoot,
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        commitmentHash: genesisHash,
        signature: sequencer.signCommitment(genesisHash),
        chainId
      };
      await sequencer.submitBatch(settler, genesisPayload);
      expect(await settler.latestBatchId()).to.equal(1n);
      expect(await settler.latestStateRoot()).to.equal(genesisRoot);

      // 2. Client orders sealed via ML-KEM-1024
      const kemKeypair = generateKemKeypair();
      const buyParams: OrderParams = {
        trader: trader1,
        baseToken: ethers.ZeroAddress,
        quoteToken: FUSD,
        side: "BUY",
        amount: 50n * 10n ** 6n,
        limitPrice: ethers.parseUnits("5", 18),
        nonce: 1,
        expiryBlock: 1000
      };
      const sealedBuy = sealOrder(buyParams, kemKeypair.publicKey, 1, chainId);
      const unsealedBuy = unsealOrder(sealedBuy, kemKeypair.secretKey);

      const sellParams: OrderParams = {
        trader: trader2,
        baseToken: ethers.ZeroAddress,
        quoteToken: FUSD,
        side: "SELL",
        amount: 50n * 10n ** 6n,
        limitPrice: ethers.parseUnits("5", 18),
        nonce: 2,
        expiryBlock: 1000
      };
      const sealedSell = sealOrder(sellParams, kemKeypair.publicKey, 1, chainId);
      const unsealedSell = unsealOrder(sealedSell, kemKeypair.secretKey);

      // 3. FBA matching engine execution for Batch 2
      const executionResult = executeBatchFBA(2, 2, [unsealedBuy, unsealedSell], ledger, [], chainId);
      expect(executionResult.totalVolume).to.equal(50n * 10n ** 6n);

      // 4. Sequencer signs batch 2
      const payload = sequencer.prepareAndSignBatch(executionResult, 2, genesisRoot);
      expect(payload.signature.length).to.equal(2 + 4627 * 2);

      // 5. Submit transaction on-chain
      const receipt = await sequencer.submitBatch(settler, payload);
      expect(receipt.status).to.equal(1);

      // 6. Verify on-chain state updated
      expect(await settler.latestBatchId()).to.equal(2n);
      expect(await settler.latestStateRoot()).to.equal(executionResult.newStateRoot);
      expect(await settler.batchStateRoots(2n)).to.equal(executionResult.newStateRoot);
    });

    it("should execute 5 consecutive batches sequentially without state desynchronization", async function () {
      let currentStateRoot = await settler.latestStateRoot();

      for (let i = 1; i <= 5; i++) {
        const newStateRoot = ethers.keccak256(Buffer.from(`state-epoch-${i}`));
        const withdrawalRoot = ethers.keccak256(Buffer.from(`withdrawals-epoch-${i}`));
        const dataHash = ethers.keccak256(Buffer.from(`data-epoch-${i}`));

        const result: BatchExecutionResult = {
          batchId: i,
          epochId: i,
          clearingPrice: ethers.parseUnits("10", 18),
          totalVolume: 100n * 10n ** 6n,
          fills: [],
          prevStateRoot: currentStateRoot,
          newStateRoot,
          withdrawalRoot,
          dataHash,
          unfilledOrders: []
        };

        const payload = sequencer.prepareAndSignBatch(result, i, currentStateRoot);

        // Pre-flight simulation check
        const canSettle = await sequencer.simulateSettlement(settler, payload);
        expect(canSettle).to.be.true;

        // Submit transaction
        const receipt = await sequencer.submitBatch(settler, payload);
        expect(receipt.status).to.equal(1);

        // Assert on-chain state
        expect(await settler.latestBatchId()).to.equal(BigInt(i));
        expect(await settler.latestStateRoot()).to.equal(newStateRoot);

        // Advance to next epoch
        currentStateRoot = newStateRoot;
      }

      expect(await settler.latestBatchId()).to.equal(5n);
    });

    it("should revert on-chain if forged signature is submitted (precompile staticcall returns false)", async function () {
      // Mock precompile to return false (0x...00)
      await ethers.provider.send("hardhat_setCode", [PQC_PRECOMPILE, BYTECODE_RETURN_FALSE]);

      const mockResult: BatchExecutionResult = {
        batchId: 1,
        epochId: 1,
        clearingPrice: 0n,
        totalVolume: 0n,
        fills: [],
        prevStateRoot: ethers.ZeroHash,
        newStateRoot: ethers.keccak256(Buffer.from("state-1")),
        withdrawalRoot: ethers.ZeroHash,
        dataHash: ethers.ZeroHash,
        unfilledOrders: []
      };

      const payload = sequencer.prepareAndSignBatch(mockResult, 1, ethers.ZeroHash);

      await expect(
        settler.settleBatch(
          BigInt(payload.batchId),
          payload.prevStateRoot,
          payload.newStateRoot,
          payload.withdrawalRoot,
          payload.dataHash,
          payload.signature
        )
      ).to.be.revertedWithCustomError(settler, "InvalidMLDSASignature");
    });
  });
});
