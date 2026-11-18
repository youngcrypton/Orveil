// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IPQCVerifier} from "./interfaces/IPQCVerifier.sol";

/**
 * @title OreVeilSettler
 * @notice Layer 1 settlement vault and post-quantum verification anchor for OreVeil FBA Rollup.
 * Deployed on QoreChain Diana Testnet (chainId: 9800).
 *
 * Enforces:
 * 1. Monotonic batch commitment via NIST FIPS 204 (ML-DSA-87) EVM precompile (0x...0a01).
 * 2. Multi-asset deposits (Native QOR mapped to address(0) and approved ERC-20 tokens).
 * 3. Trustless, reentrancy-guarded Merkle-proof withdrawals on Layer 1.
 */
contract OreVeilSettler is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // MANDATORY: Lowercase hex literal avoids Solidity EIP-55 checksum compiler failure
    address public constant PQC_PRECOMPILE = 0x0000000000000000000000000000000000000a01;

    // Cryptographic dimensions per NIST FIPS 204 (ML-DSA-87 / Dilithium-5)
    uint256 public constant ML_DSA_87_PUBKEY_LENGTH = 2592;
    uint256 public constant ML_DSA_87_SIGNATURE_LENGTH = 4627;

    /// @notice Authorized sequencer post-quantum public key (2,592 bytes)
    bytes public sequencerPublicKey;

    /// @notice Monotonically increasing batch counter
    uint256 public latestBatchId;

    /// @notice Current rollup state root anchored on Layer 1
    bytes32 public latestStateRoot;

    /// @notice Mapping from batchId => stateRoot
    mapping(uint256 => bytes32) public batchStateRoots;

    /// @notice Mapping from batchId => Merkle withdrawal root
    mapping(uint256 => bytes32) public batchWithdrawalRoots;

    /// @notice Replay protection mapping for executed Merkle withdrawal leaves
    mapping(bytes32 => bool) public executedWithdrawals;

    /// @notice Escrow deposit balance tracking: user => asset => amount
    mapping(address => mapping(address => uint256)) public deposits;

    /// @notice Whitelist for supported ERC-20 tokens (e.g. fUSD, fETH, fBTC)
    mapping(address => bool) public supportedTokens;

    // --- Events ---
    event Deposited(address indexed user, address indexed asset, uint256 amount);
    event BatchSettled(
        uint256 indexed batchId,
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 withdrawalRoot,
        bytes32 dataHash
    );
    event WithdrawalExecuted(
        uint256 indexed batchId,
        uint256 indexed withdrawalIndex,
        address indexed recipient,
        address asset,
        uint256 amount
    );
    event TokenSupportUpdated(address indexed token, bool supported);
    event SequencerKeyUpdated(bytes newPublicKey);

    // --- Custom Errors ---
    error InvalidKeyLength();
    error InvalidAddress();
    error InvalidAmount();
    error TokenNotSupported();
    error InvalidBatchId();
    error StateRootMismatch();
    error PrecompileCallFailed();
    error InvalidMLDSASignature();
    error InvalidMerkleProof();
    error WithdrawalAlreadyProcessed();
    error NativeTransferFailed();

    /**
     * @param initialOwner Contract admin address
     * @param _sequencerPublicKey Authorized sequencer ML-DSA-87 public key (exactly 2,592 bytes)
     */
    constructor(address initialOwner, bytes memory _sequencerPublicKey) Ownable(initialOwner) {
        if (_sequencerPublicKey.length != ML_DSA_87_PUBKEY_LENGTH) revert InvalidKeyLength();
        sequencerPublicKey = _sequencerPublicKey;
        latestBatchId = 0;
        latestStateRoot = bytes32(0);
    }

    /**
     * @notice Deposit native QOR (represented as address(0)) into the rollup escrow.
     */
    function depositNative() external payable nonReentrant {
        if (msg.value == 0) revert InvalidAmount();
        deposits[msg.sender][address(0)] += msg.value;
        emit Deposited(msg.sender, address(0), msg.value);
    }

    /**
     * @notice Deposit supported ERC-20 test tokens into the rollup escrow.
     * @param token Address of the ERC-20 token contract
     * @param amount Token amount to deposit
     */
    function depositERC20(address token, uint256 amount) external nonReentrant {
        if (token == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (!supportedTokens[token]) revert TokenNotSupported();

        deposits[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Anchors a completed Frequent Batch Auction rollup epoch to Layer 1.
     * Enforces strict monotonicity and validates ML-DSA-87 signature via native precompile 0x...0a01.
     *
     * @param batchId Monotonic batch sequence index (must equal latestBatchId + 1)
     * @param prevStateRoot Rollup state root before this batch (must equal latestStateRoot)
     * @param newStateRoot Rollup state root resulting from batch execution
     * @param withdrawalRoot Merkle root of withdrawal actions generated in this batch
     * @param dataHash Cryptographic digest of ordered batch transaction data
     * @param signature Exactly 4,627 bytes ML-DSA-87 signature over the batch commitment
     */
    function settleBatch(
        uint256 batchId,
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 withdrawalRoot,
        bytes32 dataHash,
        bytes calldata signature
    ) external {
        if (batchId != latestBatchId + 1) revert InvalidBatchId();
        if (prevStateRoot != latestStateRoot) revert StateRootMismatch();
        if (signature.length != ML_DSA_87_SIGNATURE_LENGTH) revert InvalidMLDSASignature();

        // Construct commitment digest with strict chainid domain separation
        bytes32 commitmentHash = keccak256(
            abi.encodePacked(
                block.chainid,
                batchId,
                prevStateRoot,
                newStateRoot,
                withdrawalRoot,
                dataHash
            )
        );

        // Forward verification to QoreChain native PQC precompile
        (bool success, bytes memory returnData) = PQC_PRECOMPILE.staticcall(
            abi.encodeWithSelector(
                IPQCVerifier.pqcVerify.selector,
                sequencerPublicKey,
                signature,
                abi.encodePacked(commitmentHash)
            )
        );

        // Assert staticcall returned valid 32-byte boolean word
        if (!success || returnData.length != 32) revert PrecompileCallFailed();

        bool isValid = abi.decode(returnData, (bool));
        if (!isValid) revert InvalidMLDSASignature();

        // Commit batch transition
        latestBatchId = batchId;
        latestStateRoot = newStateRoot;
        batchStateRoots[batchId] = newStateRoot;
        batchWithdrawalRoots[batchId] = withdrawalRoot;

        emit BatchSettled(batchId, prevStateRoot, newStateRoot, withdrawalRoot, dataHash);
    }

    /**
     * @notice Disburses escrowed funds to user via trustless Merkle proof on Layer 1.
     *
     * @param batchId Batch ID in which the withdrawal was committed
     * @param withdrawalIndex Unique index of the withdrawal within the batch
     * @param recipient L1 address receiving the disbursed funds
     * @param asset Asset address (address(0) for native QOR, or token contract address)
     * @param amount Amount to withdraw
     * @param merkleProof Cryptographic Merkle audit path
     */
    function executeWithdrawal(
        uint256 batchId,
        uint256 withdrawalIndex,
        address recipient,
        address asset,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external nonReentrant {
        if (batchId == 0 || batchId > latestBatchId) revert InvalidBatchId();
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        // Construct leaf with strict domain separation
        bytes32 leaf = keccak256(
            abi.encodePacked(block.chainid, withdrawalIndex, recipient, asset, amount)
        );

        if (executedWithdrawals[leaf]) revert WithdrawalAlreadyProcessed();

        bytes32 withdrawalRoot = batchWithdrawalRoots[batchId];
        if (!MerkleProof.verify(merkleProof, withdrawalRoot, leaf)) revert InvalidMerkleProof();

        // Checks-Effects-Interactions: state update strictly precedes transfer
        executedWithdrawals[leaf] = true;

        emit WithdrawalExecuted(batchId, withdrawalIndex, recipient, asset, amount);

        if (asset == address(0)) {
            (bool sent, ) = recipient.call{value: amount}("");
            if (!sent) revert NativeTransferFailed();
        } else {
            IERC20(asset).safeTransfer(recipient, amount);
        }
    }

    /**
     * @notice Admin function to whitelist or remove an ERC-20 token for escrow.
     */
    function setSupportedToken(address token, bool supported) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    /**
     * @notice Admin function to rotate the authorized sequencer ML-DSA-87 public key.
     */
    function updateSequencerKey(bytes memory newKey) external onlyOwner {
        if (newKey.length != ML_DSA_87_PUBKEY_LENGTH) revert InvalidKeyLength();
        sequencerPublicKey = newKey;
        emit SequencerKeyUpdated(newKey);
    }

    /// @notice Allows the contract to receive native QOR
    receive() external payable {}
}
