// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IPQCStatus
 * @notice Native EVM Post-Quantum Key Status Precompile Interface on QoreChain.
 * Target Precompile Address: 0x0000000000000000000000000000000000000a02
 * Queries whether an on-chain address has registered a valid post-quantum public key.
 */
interface IPQCStatus {
    /**
     * @notice Inspects the post-quantum key registration status of an address.
     * @param target Address to query on QoreChain.
     * @return hasKey True if the address has registered a valid post-quantum public key.
     * @return algorithm Numeric identifier of the registered PQC algorithm (1 = ML-DSA-87).
     * @return keyHash 32-byte cryptographic hash of the registered post-quantum public key.
     */
    function pqcStatus(
        address target
    ) external view returns (bool hasKey, uint8 algorithm, bytes32 keyHash);
}
