import { expect } from "chai";
import { ethers } from "ethers";
import {
  getMcpToolDefinitions,
  handleGetRollupStatus,
  handleGetPqcKeys,
  handleVerifyWithdrawalProof,
  handleToolCall,
  processJsonRpcMessage,
  DIANA_CHAIN_ID,
  SETTLER_CONTRACT_ADDRESS,
  PQC_PRECOMPILE_ADDRESS
} from "../../mcp/oreveil-server";

describe("Sub-Phase 4.0 Milestone C: Model Context Protocol (MCP) Server Integration (Zero Mocks)", function () {
  this.timeout(30000);

  // ==========================================================================
  // Dimension 1: MCP Tool Manifest & Schema Conformance
  // ==========================================================================
  describe("Dimension 1: MCP Tool Manifest & Schema Conformance", () => {
    it("D1-1: should export exactly 4 typed MCP tools with valid JSON Schemas", () => {
      const tools = getMcpToolDefinitions();
      expect(tools).to.be.an("array").with.lengthOf(4);

      for (const tool of tools) {
        expect(tool).to.have.property("name").that.is.a("string");
        expect(tool).to.have.property("description").that.is.a("string");
        expect(tool).to.have.property("inputSchema").that.is.an("object");
        expect(tool.inputSchema).to.have.property("type", "object");
        expect(tool.inputSchema).to.have.property("properties").that.is.an("object");
      }
    });

    it("D1-2: should declare oreveil_get_rollup_status with zero required arguments", () => {
      const tools = getMcpToolDefinitions();
      const statusTool = tools.find((t) => t.name === "oreveil_get_rollup_status");
      expect(statusTool).to.exist;
      expect(statusTool!.inputSchema.required).to.deep.equal([]);
      expect(statusTool!.description).to.include("Diana Testnet");
    });

    it("D1-3: should declare oreveil_verify_withdrawal_proof with all 6 required parameters", () => {
      const tools = getMcpToolDefinitions();
      const verifyTool = tools.find((t) => t.name === "oreveil_verify_withdrawal_proof");
      expect(verifyTool).to.exist;
      expect(verifyTool!.inputSchema.required).to.deep.equal([
        "batchId",
        "withdrawalIndex",
        "recipient",
        "assetAddress",
        "amount",
        "merkleProof"
      ]);
      expect(verifyTool!.inputSchema.properties).to.have.all.keys(
        "batchId",
        "withdrawalIndex",
        "recipient",
        "assetAddress",
        "amount",
        "merkleProof"
      );
    });

    it("D1-4: should declare oreveil_get_pqc_keys and oreveil_query_pool tools", () => {
      const tools = getMcpToolDefinitions();
      const pqcTool = tools.find((t) => t.name === "oreveil_get_pqc_keys");
      const poolTool = tools.find((t) => t.name === "oreveil_query_pool");
      expect(pqcTool).to.exist;
      expect(poolTool).to.exist;
    });
  });

  // ==========================================================================
  // Dimension 2: oreveil_get_rollup_status Live Diana Execution
  // ==========================================================================
  describe("Dimension 2: oreveil_get_rollup_status Live Diana Execution", () => {
    it("D2-1: should query live Diana L1 and return valid block height and chainId 9800", async () => {
      const status = await handleGetRollupStatus();
      expect(status.chainId).to.equal(DIANA_CHAIN_ID);
      expect(status.network).to.equal("QoreChain Diana Testnet");
      expect(status.blockHeight).to.be.a("number").and.be.greaterThan(10400000);
      expect(status.settlerContract.toLowerCase()).to.equal(SETTLER_CONTRACT_ADDRESS.toLowerCase());
    });

    it("D2-2: should verify latestBatchId >= 1 and non-zero latestStateRoot on Layer 1", async () => {
      const status = await handleGetRollupStatus();
      expect(status.latestBatchId).to.be.greaterThanOrEqual(1);
      expect(status.latestStateRoot).to.be.a("string").with.lengthOf(66);
      expect(status.latestStateRoot).to.not.equal(ethers.ZeroHash);
      expect(status.vaultBalanceWei).to.be.a("string");
    });

    it("D2-3: should confirm PQC precompile 0x...0a01 active status", async () => {
      const status = await handleGetRollupStatus();
      expect(status.pqcPrecompile.address.toLowerCase()).to.equal(PQC_PRECOMPILE_ADDRESS.toLowerCase());
      expect(status.pqcPrecompile.status).to.equal("active");
      expect(status.pqcPrecompile.supportedAlgorithms).to.include("ML-DSA-87 (NIST FIPS 204)");
    });
  });

  // ==========================================================================
  // Dimension 3: oreveil_get_pqc_keys Cryptographic Integrity
  // ==========================================================================
  describe("Dimension 3: oreveil_get_pqc_keys Cryptographic Integrity", () => {
    it("D3-1: should verify ML-DSA-87 parameters (NIST FIPS 204, 2592B pk, 4627B sig, Level 5)", () => {
      const pqc = handleGetPqcKeys();
      expect(pqc.digitalSignatures.algorithm).to.include("ML-DSA-87");
      expect(pqc.digitalSignatures.fipsSpecification).to.equal("NIST FIPS 204");
      expect(pqc.digitalSignatures.publicKeyLengthBytes).to.equal(2592);
      expect(pqc.digitalSignatures.signatureLengthBytes).to.equal(4627);
      expect(pqc.digitalSignatures.onChainPrecompile.toLowerCase()).to.equal(PQC_PRECOMPILE_ADDRESS.toLowerCase());
      expect(pqc.digitalSignatures.hybridSignBytesFormat).to.equal("pqc-sign-bytes-v2");
    });

    it("D3-2: should verify ML-KEM-1024 parameters (NIST FIPS 203, 1568B pk, 1568B ct, 32B shared secret)", () => {
      const pqc = handleGetPqcKeys();
      expect(pqc.keyEncapsulation.algorithm).to.include("ML-KEM-1024");
      expect(pqc.keyEncapsulation.fipsSpecification).to.equal("NIST FIPS 203");
      expect(pqc.keyEncapsulation.publicKeyLengthBytes).to.equal(1568);
      expect(pqc.keyEncapsulation.ciphertextLengthBytes).to.equal(1568);
      expect(pqc.keyEncapsulation.sharedSecretBytes).to.equal(32);
      expect(pqc.keyEncapsulation.symmetricEncryption).to.include("AES-256-GCM");
    });

    it("D3-3: should confirm classical curves secp256k1/ed25519 are barred from batch state root settlement", () => {
      const pqc = handleGetPqcKeys();
      expect(pqc.classicalCurveStatus.secp256k1).to.include("Barred");
      expect(pqc.classicalCurveStatus.ed25519).to.include("Barred");
      expect(pqc.classification).to.include("NIST Security Category 5");
    });
  });

  // ==========================================================================
  // Dimension 4: oreveil_verify_withdrawal_proof Validation
  // ==========================================================================
  describe("Dimension 4: oreveil_verify_withdrawal_proof Validation", () => {
    it("D4-1: should compute domain-separated leaf matching Solidity keccak256(abi.encodePacked(...))", async () => {
      const recipient = "0x7DE7d6CC73002f44A76334392555C9A4dDc0B561";
      const asset = ethers.ZeroAddress;
      const amount = "1000000";
      const index = 0;

      const expectedLeaf = ethers.keccak256(
        ethers.solidityPacked(
          ["uint256", "uint256", "address", "address", "uint256"],
          [DIANA_CHAIN_ID, index, recipient, asset, BigInt(amount)]
        )
      );

      const result = await handleVerifyWithdrawalProof({
        batchId: 1,
        withdrawalIndex: index,
        recipient,
        assetAddress: asset,
        amount,
        merkleProof: []
      });

      expect(result.leaf).to.equal(expectedLeaf);
      expect(result.recipient).to.equal(recipient);
      expect(result.assetAddress).to.equal(asset);
    });

    it("D4-2: should evaluate invalid proof gracefully without throwing unhandled exceptions", async () => {
      const result = await handleVerifyWithdrawalProof({
        batchId: 1,
        withdrawalIndex: 99,
        recipient: "0x7DE7d6CC73002f44A76334392555C9A4dDc0B561",
        assetAddress: ethers.ZeroAddress,
        amount: "5000000",
        merkleProof: [ethers.ZeroHash]
      });

      expect(result.isValidProof).to.be.false;
      expect(result.executionReadiness).to.equal("INVALID_PROOF");
    });

    it("D4-3: should return error report when batch does not exist", async () => {
      const result = await handleVerifyWithdrawalProof({
        batchId: 999999,
        withdrawalIndex: 0,
        recipient: "0x7DE7d6CC73002f44A76334392555C9A4dDc0B561",
        assetAddress: ethers.ZeroAddress,
        amount: "1000000",
        merkleProof: []
      });

      expect(result.isValidProof).to.be.false;
    });
  });

  // ==========================================================================
  // Dimension 5: JSON-RPC 2.0 Protocol Engine & Error Handling
  // ==========================================================================
  describe("Dimension 5: JSON-RPC 2.0 Protocol Engine & Error Handling", () => {
    it("D5-1: should handle initialize and return valid protocolVersion and serverInfo", async () => {
      const response = await processJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {}
      });

      expect(response.jsonrpc).to.equal("2.0");
      expect(response.id).to.equal(1);
      expect(response.result.serverInfo.name).to.equal("oreveil-mcp-server");
      expect(response.result.protocolVersion).to.equal("2024-11-05");
    });

    it("D5-2: should handle tools/list and return all registered tools", async () => {
      const response = await processJsonRpcMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list"
      });

      expect(response.jsonrpc).to.equal("2.0");
      expect(response.id).to.equal(2);
      expect(response.result.tools).to.be.an("array").with.lengthOf(4);
    });

    it("D5-3: should handle tools/call for oreveil_get_pqc_keys and return typed text content", async () => {
      const response = await processJsonRpcMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "oreveil_get_pqc_keys",
          arguments: {}
        }
      });

      expect(response.jsonrpc).to.equal("2.0");
      expect(response.id).to.equal(3);
      expect(response.result.content).to.be.an("array").with.lengthOf(1);
      expect(response.result.content[0].type).to.equal("text");
      const parsed = JSON.parse(response.result.content[0].text);
      expect(parsed.digitalSignatures.algorithm).to.include("ML-DSA-87");
    });

    it("D5-4: should handle unknown tool calls returning isError: true with error description", async () => {
      const response = await processJsonRpcMessage({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "non_existent_tool",
          arguments: {}
        }
      });

      expect(response.jsonrpc).to.equal("2.0");
      expect(response.id).to.equal(4);
      expect(response.result.isError).to.be.true;
      const parsed = JSON.parse(response.result.content[0].text);
      expect(parsed.error).to.include("Unknown MCP tool");
    });

    it("D5-5: should reject non-2.0 JSON-RPC messages with error code -32600", async () => {
      const response = await processJsonRpcMessage({
        jsonrpc: "1.0",
        id: 5,
        method: "initialize"
      });

      expect(response.jsonrpc).to.equal("2.0");
      expect(response.error.code).to.equal(-32600);
    });
  });
});
