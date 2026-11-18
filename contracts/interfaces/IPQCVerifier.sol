// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IPQCVerifier
 * @notice Native EVM Post-Quantum Verification Precompile Interface on QoreChain.
 * Target Precompile Address: 0x0000000000000000000000000000000000000a01
 * Verifies NIST FIPS 204 (ML-DSA-87 / Dilithium-5) signatures on-chain.
 */
interface IPQCVerifier {
    /**
     * @notice Verifies an ML-DSA-87 signature over a given message.
     * @param pubkey Exactly 2,592 bytes representing the ML-DSA-87 public key.
     * @param signature Exactly 4,627 bytes representing the ML-DSA-87 signature.
     * @param message Arbitrary length byte message or 32-byte commitment digest.
     * @return valid True if the signature is cryptographically valid for the given public key and message.
     */
    function pqcVerify(
        bytes calldata pubkey,
        bytes calldata signature,
        bytes calldata message
    ) external view returns (bool valid);
}
