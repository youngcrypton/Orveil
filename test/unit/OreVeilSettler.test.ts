import { expect } from "chai";
import { ethers } from "hardhat";
import * as crypto from "crypto";
import { OreVeilSettler } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("Sub-Phase 1.1: OreVeilSettler Unit Test Suite", function () {
  let settler: OreVeilSettler;
  let owner: SignerWithAddress;
  let trader: SignerWithAddress;
  let recipient: SignerWithAddress;
  let otherAccount: SignerWithAddress;

  const PQC_PRECOMPILE = "0x0000000000000000000000000000000000000a01";
  const ML_DSA_87_PUBKEY_LENGTH = 2592;
  const ML_DSA_87_SIGNATURE_LENGTH = 4627;

  // Real-dimensioned 2,592-byte dummy public key
  const validPubKey = "0x" + crypto.randomBytes(ML_DSA_87_PUBKEY_LENGTH).toString("hex");
  // Real-dimensioned 4,627-byte dummy signature
  const validSig = "0x" + crypto.randomBytes(ML_DSA_87_SIGNATURE_LENGTH).toString("hex");

  // EVM Bytecode shims for Hardhat local EVM testing of precompile staticcalls:
  // Returns 32-byte boolean word 0x...01 (true)
  const BYTECODE_RETURN_TRUE = "0x600160005260206000f3";
  // Returns 32-byte boolean word 0x...00 (false)
  const BYTECODE_RETURN_FALSE = "0x600060005260206000f3";
  // Returns 0 bytes (empty return data)
  const BYTECODE_EMPTY = "0x";

  // Helper to hash pairs in ascending byte order per OpenZeppelin MerkleProof.sol
  function hashPair(a: string, b: string): string {
    const aBig = BigInt(a);
    const bBig = BigInt(b);
    return aBig < bBig
      ? ethers.keccak256(ethers.concat([a, b]))
      : ethers.keccak256(ethers.concat([b, a]));
  }

  beforeEach(async function () {
    [owner, trader, recipient, otherAccount] = await ethers.getSigners();

    // Reset precompile address to empty by default
    await ethers.provider.send("hardhat_setCode", [PQC_PRECOMPILE, BYTECODE_EMPTY]);

    const OreVeilSettlerFactory = await ethers.getContractFactory("OreVeilSettler");
    settler = (await OreVeilSettlerFactory.deploy(owner.address, validPubKey)) as OreVeilSettler;
    await settler.waitForDeployment();
  });

  describe("1. Deployment & Key Validation", function () {
    it("should deploy cleanly and initialize state parameters", async function () {
      expect(await settler.owner()).to.equal(owner.address);
      expect(await settler.sequencerPublicKey()).to.equal(validPubKey);
      expect(await settler.latestBatchId()).to.equal(0n);
      expect(await settler.latestStateRoot()).to.equal(ethers.ZeroHash);
      expect(await settler.PQC_PRECOMPILE()).to.equal(PQC_PRECOMPILE);
    });

    it("should revert deployment if public key length is not exactly 2,592 bytes", async function () {
      const OreVeilSettlerFactory = await ethers.getContractFactory("OreVeilSettler");
      const invalidShortKey = "0x" + crypto.randomBytes(100).toString("hex");

      await expect(
        OreVeilSettlerFactory.deploy(owner.address, invalidShortKey)
      ).to.be.revertedWithCustomError(settler, "InvalidKeyLength");
    });
  });

  describe("2. Multi-Asset Deposits & Token Whitelist", function () {
    it("should accept native QOR deposits and credit user balance", async function () {
      const depositAmount = ethers.parseEther("10.0");

      await expect(
        settler.connect(trader).depositNative({ value: depositAmount })
      )
        .to.emit(settler, "Deposited")
        .withArgs(trader.address, ethers.ZeroAddress, depositAmount);

      expect(await settler.deposits(trader.address, ethers.ZeroAddress)).to.equal(depositAmount);
      expect(await ethers.provider.getBalance(await settler.getAddress())).to.equal(depositAmount);
    });

    it("should revert native deposit if msg.value is zero", async function () {
      await expect(
        settler.connect(trader).depositNative({ value: 0n })
      ).to.be.revertedWithCustomError(settler, "InvalidAmount");
    });

    it("should revert ERC-20 deposit if token is not whitelisted", async function () {
      const dummyToken = ethers.Wallet.createRandom().address;
      await expect(
        settler.connect(trader).depositERC20(dummyToken, 1000n)
      ).to.be.revertedWithCustomError(settler, "TokenNotSupported");
    });

    it("should allow owner to whitelist and remove supported tokens", async function () {
      const testToken = ethers.Wallet.createRandom().address;

      await expect(settler.connect(owner).setSupportedToken(testToken, true))
        .to.emit(settler, "TokenSupportUpdated")
        .withArgs(testToken, true);

      expect(await settler.supportedTokens(testToken)).to.be.true;

      await settler.connect(owner).setSupportedToken(testToken, false);
      expect(await settler.supportedTokens(testToken)).to.be.false;
    });

    it("should revert setSupportedToken if caller is not owner", async function () {
      const testToken = ethers.Wallet.createRandom().address;
      await expect(
        settler.connect(otherAccount).setSupportedToken(testToken, true)
      ).to.be.revertedWithCustomError(settler, "OwnableUnauthorizedAccount");
    });
  });

  describe("3. Batch Anchoring Invariants & Staticcall Security", function () {
    const prevStateRoot = ethers.ZeroHash;
    const newStateRoot = ethers.keccak256(Buffer.from("state-root-1"));
    const withdrawalRoot = ethers.keccak256(Buffer.from("withdrawal-root-1"));
    const dataHash = ethers.keccak256(Buffer.from("batch-data-1"));

    it("should revert settleBatch if batchId is out of sequence", async function () {
      await expect(
        settler.settleBatch(2n, prevStateRoot, newStateRoot, withdrawalRoot, dataHash, validSig)
      ).to.be.revertedWithCustomError(settler, "InvalidBatchId");
    });

    it("should revert settleBatch if prevStateRoot does not match latestStateRoot", async function () {
      const wrongPrevState = ethers.keccak256(Buffer.from("wrong-root"));
      await expect(
        settler.settleBatch(1n, wrongPrevState, newStateRoot, withdrawalRoot, dataHash, validSig)
      ).to.be.revertedWithCustomError(settler, "StateRootMismatch");
    });

    it("should revert settleBatch if signature length is not 4,627 bytes", async function () {
      const shortSig = "0x" + crypto.randomBytes(65).toString("hex");
      await expect(
        settler.settleBatch(1n, prevStateRoot, newStateRoot, withdrawalRoot, dataHash, shortSig)
      ).to.be.revertedWithCustomError(settler, "InvalidMLDSASignature");
    });

    it("should revert with PrecompileCallFailed when precompile returns empty data (0 bytes)", async function () {
      // Precompile has no code / empty return
      await ethers.provider.send("hardhat_setCode", [PQC_PRECOMPILE, BYTECODE_EMPTY]);

      await expect(
        settler.settleBatch(1n, prevStateRoot, newStateRoot, withdrawalRoot, dataHash, validSig)
      ).to.be.revertedWithCustomError(settler, "PrecompileCallFailed");
    });

    it("should revert with InvalidMLDSASignature when precompile returns false (0x...00)", async function () {
      await ethers.provider.send("hardhat_setCode", [PQC_PRECOMPILE, BYTECODE_RETURN_FALSE]);

      await expect(
        settler.settleBatch(1n, prevStateRoot, newStateRoot, withdrawalRoot, dataHash, validSig)
      ).to.be.revertedWithCustomError(settler, "InvalidMLDSASignature");
    });

    it("should successfully settle batch and update state roots when precompile returns true (0x...01)", async function () {
      await ethers.provider.send("hardhat_setCode", [PQC_PRECOMPILE, BYTECODE_RETURN_TRUE]);

      await expect(
        settler.settleBatch(1n, prevStateRoot, newStateRoot, withdrawalRoot, dataHash, validSig)
      )
        .to.emit(settler, "BatchSettled")
        .withArgs(1n, prevStateRoot, newStateRoot, withdrawalRoot, dataHash);

      expect(await settler.latestBatchId()).to.equal(1n);
      expect(await settler.latestStateRoot()).to.equal(newStateRoot);
      expect(await settler.batchStateRoots(1n)).to.equal(newStateRoot);
      expect(await settler.batchWithdrawalRoots(1n)).to.equal(withdrawalRoot);
    });
  });

  describe("4. Trustless Merkle Withdrawals & Replay Protection", function () {
    let chainId: bigint;
    let withdrawalIndex = 0n;
    let withdrawalAmount = ethers.parseEther("5.0");
    let leaf1: string;
    let leaf2: string;
    let root: string;
    let proof1: string[];

    beforeEach(async function () {
      const network = await ethers.provider.getNetwork();
      chainId = network.chainId;

      // Leaf 1: Valid native QOR withdrawal for recipient
      leaf1 = ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "address", "address", "uint256"],
        [chainId, withdrawalIndex, recipient.address, ethers.ZeroAddress, withdrawalAmount]
      );

      // Leaf 2: Sibling leaf in Merkle tree
      leaf2 = ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "address", "address", "uint256"],
        [chainId, 1n, otherAccount.address, ethers.ZeroAddress, ethers.parseEther("1.0")]
      );

      root = hashPair(leaf1, leaf2);
      proof1 = [leaf2];

      // Fund settler contract with native QOR for withdrawals
      await owner.sendTransaction({
        to: await settler.getAddress(),
        value: ethers.parseEther("20.0")
      });

      // Anchor batch 1 with the computed withdrawal root
      await ethers.provider.send("hardhat_setCode", [PQC_PRECOMPILE, BYTECODE_RETURN_TRUE]);
      await settler.settleBatch(
        1n,
        ethers.ZeroHash,
        ethers.keccak256(Buffer.from("state-1")),
        root,
        ethers.keccak256(Buffer.from("data-1")),
        validSig
      );
    });

    it("should revert withdrawal if batchId is greater than latestBatchId", async function () {
      await expect(
        settler.executeWithdrawal(99n, withdrawalIndex, recipient.address, ethers.ZeroAddress, withdrawalAmount, proof1)
      ).to.be.revertedWithCustomError(settler, "InvalidBatchId");
    });

    it("should revert withdrawal if Merkle proof is forged or invalid", async function () {
      const fakeProof = [ethers.ZeroHash];
      await expect(
        settler.executeWithdrawal(1n, withdrawalIndex, recipient.address, ethers.ZeroAddress, withdrawalAmount, fakeProof)
      ).to.be.revertedWithCustomError(settler, "InvalidMerkleProof");
    });

    it("should successfully disburse native QOR upon valid Merkle proof", async function () {
      const balanceBefore = await ethers.provider.getBalance(recipient.address);

      await expect(
        settler.executeWithdrawal(1n, withdrawalIndex, recipient.address, ethers.ZeroAddress, withdrawalAmount, proof1)
      )
        .to.emit(settler, "WithdrawalExecuted")
        .withArgs(1n, withdrawalIndex, recipient.address, ethers.ZeroAddress, withdrawalAmount);

      const balanceAfter = await ethers.provider.getBalance(recipient.address);
      expect(balanceAfter - balanceBefore).to.equal(withdrawalAmount);

      // Check executed mapping is recorded
      expect(await settler.executedWithdrawals(leaf1)).to.be.true;
    });

    it("should revert if the same withdrawal is executed more than once (replay prevention)", async function () {
      // First execution succeeds
      await settler.executeWithdrawal(1n, withdrawalIndex, recipient.address, ethers.ZeroAddress, withdrawalAmount, proof1);

      // Second execution must revert
      await expect(
        settler.executeWithdrawal(1n, withdrawalIndex, recipient.address, ethers.ZeroAddress, withdrawalAmount, proof1)
      ).to.be.revertedWithCustomError(settler, "WithdrawalAlreadyProcessed");
    });
  });

  describe("5. Sequencer Key Rotation", function () {
    it("should allow owner to rotate the authorized sequencer public key", async function () {
      const newKey = "0x" + crypto.randomBytes(ML_DSA_87_PUBKEY_LENGTH).toString("hex");

      await expect(settler.connect(owner).updateSequencerKey(newKey))
        .to.emit(settler, "SequencerKeyUpdated")
        .withArgs(newKey);

      expect(await settler.sequencerPublicKey()).to.equal(newKey);
    });

    it("should revert key rotation if called by non-owner", async function () {
      const newKey = "0x" + crypto.randomBytes(ML_DSA_87_PUBKEY_LENGTH).toString("hex");
      await expect(
        settler.connect(trader).updateSequencerKey(newKey)
      ).to.be.revertedWithCustomError(settler, "OwnableUnauthorizedAccount");
    });

    it("should revert key rotation if new key length != 2,592 bytes", async function () {
      const invalidKey = "0x" + crypto.randomBytes(500).toString("hex");
      await expect(
        settler.connect(owner).updateSequencerKey(invalidKey)
      ).to.be.revertedWithCustomError(settler, "InvalidKeyLength");
    });
  });
});
