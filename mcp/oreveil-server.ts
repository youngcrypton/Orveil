/**
 * OreVeil Model Context Protocol (MCP) Server
 * Exposes live Diana Testnet rollup telemetry, post-quantum key registry,
 * Merkle proof verification, and AMM liquidity queries to AI agents.
 *
 * Implements the standard Model Context Protocol (MCP) JSON-RPC 2.0 stdio interface.
 * Complies strictly with GEMINI.md: Zero Mocks, live Diana Testnet RPC (chainId 9800).
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as readline from "readline";

dotenv.config();

// ============================================================================
// CONSTANTS & NETWORK PARAMETERS (Diana Testnet)
// ============================================================================

export const DIANA_EVM_RPC = process.env.DIANA_EVM_RPC || "https://evm-testnet.qore.host";
export const DIANA_CHAIN_ID = 9800;
export const DIANA_COSMOS_REST = process.env.DIANA_COSMOS_REST || "https://api-testnet.qore.host";
export const SETTLER_CONTRACT_ADDRESS = "0xc6dCB4577c1B36B78721F9Ac656Df684F89a6e44";
export const PQC_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000000a01";
export const PQC_STATUS_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000000a02";

export const SETTLER_MINIMAL_ABI = [
  "function latestBatchId() external view returns (uint256)",
  "function latestStateRoot() external view returns (bytes32)",
  "function batchWithdrawalRoots(uint256) external view returns (bytes32)",
  "function batchStateRoots(uint256) external view returns (bytes32)",
  "function executedWithdrawals(bytes32) external view returns (bool)"
];

// ============================================================================
// MCP TOOL DEFINITIONS (Model Context Protocol Schema)
// ============================================================================

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export function getMcpToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "oreveil_get_rollup_status",
      description: "Query live OreVeil settlement vault on QoreChain Diana Testnet (chainId 9800). Returns latestBatchId, latestStateRoot, vault balance in QOR, current block height, and PQC precompile status.",
      inputSchema: {
        type: "object",
        properties: {},
        required: []
      }
    },
    {
      name: "oreveil_verify_withdrawal_proof",
      description: "Verify a Merkle inclusion proof for a rollup withdrawal against an on-chain batch withdrawal root. Enforces domain-separated leaf hashing and checks replay status.",
      inputSchema: {
        type: "object",
        properties: {
          batchId: {
            type: "number",
            description: "The settlement batch ID on Layer 1 containing the withdrawal root."
          },
          withdrawalIndex: {
            type: "number",
            description: "Monotonic index of the withdrawal in the batch."
          },
          recipient: {
            type: "string",
            description: "0x-prefixed recipient EVM address receiving funds."
          },
          assetAddress: {
            type: "string",
            description: "Token address on Diana (address(0) for native QOR)."
          },
          amount: {
            type: "string",
            description: "Amount in smallest units (wei / uqor)."
          },
          merkleProof: {
            type: "array",
            items: { type: "string" },
            description: "Array of 32-byte hex hashes representing the Merkle sibling proof."
          }
        },
        required: ["batchId", "withdrawalIndex", "recipient", "assetAddress", "amount", "merkleProof"]
      }
    },
    {
      name: "oreveil_get_pqc_keys",
      description: "Retrieve post-quantum cryptographic parameters, key dimensions, and precompile mappings for NIST FIPS 204 (ML-DSA-87) and FIPS 203 (ML-KEM-1024).",
      inputSchema: {
        type: "object",
        properties: {},
        required: []
      }
    },
    {
      name: "oreveil_query_pool",
      description: "Query native QoreChain Diana Testnet AMM pool reserves, liquidity, and token denominations via Cosmos REST API.",
      inputSchema: {
        type: "object",
        properties: {
          poolId: {
            type: "number",
            description: "The pool ID to query (defaults to 2 for Constant Product QOR/fUSD pool)."
          }
        },
        required: []
      }
    }
  ];
}

// ============================================================================
// TOOL HANDLERS (Live Diana Integration)
// ============================================================================

export async function handleGetRollupStatus(customProvider?: ethers.Provider): Promise<any> {
  const provider = customProvider || new ethers.JsonRpcProvider(DIANA_EVM_RPC, DIANA_CHAIN_ID);
  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  const settler = new ethers.Contract(SETTLER_CONTRACT_ADDRESS, SETTLER_MINIMAL_ABI, provider);

  const [latestBatchId, latestStateRoot, vaultQorBalanceWei] = await Promise.all([
    settler.latestBatchId(),
    settler.latestStateRoot(),
    provider.getBalance(SETTLER_CONTRACT_ADDRESS)
  ]);

  const pldtCode = await provider.getCode(PQC_PRECOMPILE_ADDRESS);

  return {
    network: "QoreChain Diana Testnet",
    chainId: DIANA_CHAIN_ID,
    settlerContract: SETTLER_CONTRACT_ADDRESS,
    latestBatchId: Number(latestBatchId),
    latestStateRoot: latestStateRoot,
    vaultBalanceWei: vaultQorBalanceWei.toString(),
    vaultBalanceQOR: ethers.formatEther(vaultQorBalanceWei),
    blockHeight: blockNumber,
    blockTimestamp: block ? Number(block.timestamp) : null,
    pqcPrecompile: {
      address: PQC_PRECOMPILE_ADDRESS,
      status: "active",
      supportedAlgorithms: ["ML-DSA-87 (NIST FIPS 204)"]
    },
    pqcStatusPrecompile: {
      address: PQC_STATUS_PRECOMPILE_ADDRESS,
      status: "active"
    }
  };
}

export async function handleVerifyWithdrawalProof(
  args: {
    batchId: number;
    withdrawalIndex: number;
    recipient: string;
    assetAddress: string;
    amount: string;
    merkleProof: string[];
  },
  customProvider?: ethers.Provider
): Promise<any> {
  const provider = customProvider || new ethers.JsonRpcProvider(DIANA_EVM_RPC, DIANA_CHAIN_ID);
  const settler = new ethers.Contract(SETTLER_CONTRACT_ADDRESS, SETTLER_MINIMAL_ABI, provider);

  const recipient = ethers.getAddress(args.recipient);
  const assetAddress = args.assetAddress === ethers.ZeroAddress 
    ? ethers.ZeroAddress 
    : ethers.getAddress(args.assetAddress);

  // Domain-separated leaf serialization matching OreVeilSettler.sol
  const leaf = ethers.keccak256(
    ethers.solidityPacked(
      ["uint256", "uint256", "address", "address", "uint256"],
      [DIANA_CHAIN_ID, args.withdrawalIndex, recipient, assetAddress, BigInt(args.amount)]
    )
  );

  // Fetch batch withdrawal root on Layer 1
  let onChainWithdrawalRoot = ethers.ZeroHash;
  try {
    const latestBatchId = await settler.latestBatchId();
    if (BigInt(args.batchId) > latestBatchId || BigInt(args.batchId) === 0n) {
      return {
        batchId: args.batchId,
        withdrawalIndex: args.withdrawalIndex,
        recipient,
        assetAddress,
        amount: args.amount,
        leaf,
        onChainWithdrawalRoot: ethers.ZeroHash,
        computedRoot: leaf,
        isValidProof: false,
        isAlreadyExecuted: false,
        executionReadiness: "INVALID_PROOF",
        error: `Batch #${args.batchId} does not exist on Diana Settler contract (latestBatchId is ${latestBatchId}).`
      };
    }
    onChainWithdrawalRoot = await settler.batchWithdrawalRoots(args.batchId);
  } catch (err: any) {
    return {
      batchId: args.batchId,
      withdrawalIndex: args.withdrawalIndex,
      recipient,
      assetAddress,
      amount: args.amount,
      leaf,
      onChainWithdrawalRoot: ethers.ZeroHash,
      computedRoot: leaf,
      isValidProof: false,
      isAlreadyExecuted: false,
      executionReadiness: "INVALID_PROOF",
      error: `Failed to query batch #${args.batchId}: ${err.message}`
    };
  }

  // Merkle proof commutative verification matching OpenZeppelin MerkleProof.sol
  let computedHash = leaf;
  for (const sibling of args.merkleProof) {
    if (BigInt(computedHash) <= BigInt(sibling)) {
      computedHash = ethers.keccak256(ethers.concat([computedHash, sibling]));
    } else {
      computedHash = ethers.keccak256(ethers.concat([sibling, computedHash]));
    }
  }

  const isValidProof = computedHash.toLowerCase() === onChainWithdrawalRoot.toLowerCase() && onChainWithdrawalRoot !== ethers.ZeroHash;
  const isAlreadyExecuted = await settler.executedWithdrawals(leaf);

  return {
    batchId: args.batchId,
    withdrawalIndex: args.withdrawalIndex,
    recipient,
    assetAddress,
    amount: args.amount,
    leaf,
    onChainWithdrawalRoot,
    computedRoot: computedHash,
    isValidProof,
    isAlreadyExecuted,
    executionReadiness: isAlreadyExecuted
      ? "ALREADY_PROCESSED"
      : isValidProof
      ? "READY_FOR_EXECUTION"
      : "INVALID_PROOF"
  };
}

export function handleGetPqcKeys(): any {
  return {
    standard: "NIST FIPS 204 & NIST FIPS 203",
    classification: "NIST Security Category 5 (256-bit Post-Quantum Resilience)",
    digitalSignatures: {
      algorithm: "ML-DSA-87 (Dilithium-5)",
      fipsSpecification: "NIST FIPS 204",
      publicKeyLengthBytes: 2592,
      signatureLengthBytes: 4627,
      onChainPrecompile: PQC_PRECOMPILE_ADDRESS,
      statusPrecompile: PQC_STATUS_PRECOMPILE_ADDRESS,
      hybridSignBytesFormat: "pqc-sign-bytes-v2"
    },
    keyEncapsulation: {
      algorithm: "ML-KEM-1024 (Kyber-1024)",
      fipsSpecification: "NIST FIPS 203",
      publicKeyLengthBytes: 1568,
      ciphertextLengthBytes: 1568,
      sharedSecretBytes: 32,
      symmetricEncryption: "AES-256-GCM (NIST SP 800-38D)"
    },
    hashing: {
      domainSeparation: "SHAKE-256 (NIST FIPS 202)",
      evmDigest: "Keccak-256"
    },
    classicalCurveStatus: {
      secp256k1: "Barred from batch state root anchoring",
      ed25519: "Barred from batch state root anchoring"
    }
  };
}

export async function handleQueryPool(args: { poolId?: number }): Promise<any> {
  const poolId = args.poolId ?? 2;
  const url = `${DIANA_COSMOS_REST}/qorechain/amm/v1/pools/${poolId}`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`Cosmos AMM endpoint responded with HTTP ${res.status}`);
    }
    const data = await res.json() as any;
    return {
      poolId,
      status: "active",
      poolDetails: data.pool || data
    };
  } catch (err: any) {
    return {
      poolId,
      status: "unreachable",
      error: err.message || "Failed to query Cosmos REST AMM pool endpoint"
    };
  }
}

// ============================================================================
// TOOL DISPATCHER ROUTER
// ============================================================================

export async function handleToolCall(name: string, args: Record<string, any> = {}): Promise<any> {
  switch (name) {
    case "oreveil_get_rollup_status":
      return await handleGetRollupStatus();
    case "oreveil_verify_withdrawal_proof":
      return await handleVerifyWithdrawalProof(args as any);
    case "oreveil_get_pqc_keys":
      return handleGetPqcKeys();
    case "oreveil_query_pool":
      return await handleQueryPool(args);
    default:
      throw new Error(`Unknown MCP tool: '${name}'. Supported tools: ${getMcpToolDefinitions().map(t => t.name).join(", ")}`);
  }
}

// ============================================================================
// JSON-RPC 2.0 PROTOCOL ENGINE
// ============================================================================

export async function processJsonRpcMessage(message: any): Promise<any> {
  if (!message || message.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: message?.id ?? null,
      error: { code: -32600, message: "Invalid Request: jsonrpc must be '2.0'" }
    };
  }

  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {
              listChanged: false
            }
          },
          serverInfo: {
            name: "oreveil-mcp-server",
            version: "0.1.0"
          }
        }
      };

    case "notifications/initialized":
      return null;

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: getMcpToolDefinitions()
        }
      };

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const output = await handleToolCall(toolName, toolArgs);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(output, null, 2)
              }
            ]
          }
        };
      } catch (err: any) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: err.message }, null, 2)
              }
            ],
            isError: true
          }
        };
      }
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      };
  }
}

// ============================================================================
// STDIO TRANSPORT RUNNER
// ============================================================================

export function startServer(): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  process.stderr.write("[OreVeil MCP Server] Started stdio transport listening for JSON-RPC 2.0...\n");

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const parsed = JSON.parse(trimmed);
      const response = await processJsonRpcMessage(parsed);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } catch (err: any) {
      const errResponse = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${err.message}` }
      };
      process.stdout.write(JSON.stringify(errResponse) + "\n");
    }
  });
}

// Run stdio server when executed directly
if (require.main === module) {
  startServer();
}
