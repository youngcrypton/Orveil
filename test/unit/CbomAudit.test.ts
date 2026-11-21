import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { generateCbom, CycloneDxCbom } from "../../scripts/generate-cbom";

describe("Sub-Phase 4.0 Milestone B: Cryptographic Bill of Materials (CBOM) & QoreScan Audit (Zero Mocks)", function () {
  let cbom: CycloneDxCbom;
  const cbomPath = path.join(__dirname, "..", "..", "cbom.json");

  before(function () {
    cbom = generateCbom();
  });

  describe("Dimension 1: CycloneDX 1.6 Schema & Tool Specification Validation", function () {
    it("D1-1: should conform strictly to CycloneDX 1.6 specification header", function () {
      expect(cbom.bomFormat).to.equal("CycloneDX");
      expect(cbom.specVersion).to.equal("1.6");
      expect(cbom.version).to.equal(1);
      expect(cbom.serialNumber).to.match(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("D1-2: should declare @qorechain/qorescan as official audit tool in metadata", function () {
      expect(cbom.metadata.tools.components).to.be.an("array").with.lengthOf.at.least(1);
      const tool = cbom.metadata.tools.components[0];
      expect(tool.name).to.equal("@qorechain/qorescan");
      expect(tool.version).to.equal("0.1.0");
      expect(tool.author).to.equal("QoreChain Association");
    });

    it("D1-3: should declare oreveil protocol component with MIT license", function () {
      expect(cbom.metadata.component.name).to.equal("oreveil");
      expect(cbom.metadata.component.version).to.equal("0.1.0");
      expect(cbom.metadata.component.licenses?.[0].license.id).to.equal("MIT");
    });
  });

  describe("Dimension 2: NIST FIPS 204 (ML-DSA-87 / Dilithium-5) Cryptographic Asset Integrity", function () {
    it("D2-1: should verify ML-DSA-87 exact parameter set and Level 5 256-bit quantum security", function () {
      const comp = cbom.components.find((c) => c.name === "ML-DSA-87");
      expect(comp).to.exist;
      expect(comp!.type).to.equal("cryptographic-asset");

      const props = comp!.cryptoProperties.algorithmProperties;
      expect(props.primitive).to.equal("signature");
      expect(props.parameterSetIdentifier).to.equal("ML-DSA-87");
      expect(props.securityLevel).to.equal(5);
      expect(props.quantumSafe).to.be.true;
      expect(props.standards).to.include("NIST FIPS 204");
    });

    it("D2-2: should verify ML-DSA-87 key and signature dimensions match precompile 0x...0a01 exactly", function () {
      const comp = cbom.components.find((c) => c.name === "ML-DSA-87")!;
      const props = comp.cryptoProperties.algorithmProperties;

      // Absolute Protocol Invariant: 2,592 bytes public key & 4,627 bytes signature
      expect(props.keyLength).to.equal(2592);
      expect(props.signatureLength).to.equal(4627);
      expect(props.precompileAddress).to.equal("0x0000000000000000000000000000000000000a01");
    });
  });

  describe("Dimension 3: NIST FIPS 203 (ML-KEM-1024 / Kyber-1024) Cryptographic Asset Integrity", function () {
    it("D3-1: should verify ML-KEM-1024 parameter set and Level 5 security for confidential envelopes", function () {
      const comp = cbom.components.find((c) => c.name === "ML-KEM-1024");
      expect(comp).to.exist;

      const props = comp!.cryptoProperties.algorithmProperties;
      expect(props.primitive).to.equal("kem");
      expect(props.parameterSetIdentifier).to.equal("ML-KEM-1024");
      expect(props.securityLevel).to.equal(5);
      expect(props.quantumSafe).to.be.true;
      expect(props.standards).to.include("NIST FIPS 203");
    });

    it("D3-2: should verify ML-KEM-1024 key, ciphertext, and shared secret dimensional bounds", function () {
      const comp = cbom.components.find((c) => c.name === "ML-KEM-1024")!;
      const props = comp.cryptoProperties.algorithmProperties;

      // Absolute Protocol Invariant: 1,568 bytes public key, 1,568 bytes ciphertext, 32 bytes shared secret
      expect(props.keyLength).to.equal(1568);
      expect(props.cipherTextLength).to.equal(1568);
      expect(props.sharedSecretLength).to.equal(32);
    });
  });

  describe("Dimension 4: Auxiliary Primitives (SHAKE-256, AES-256-GCM, Keccak-256)", function () {
    it("D4-1: should verify SHAKE-256 domain-separation configuration (qorechain-pqc-hybrid-v2)", function () {
      const comp = cbom.components.find((c) => c.name === "SHAKE-256");
      expect(comp).to.exist;
      const props = comp!.cryptoProperties.algorithmProperties;
      expect(props.quantumSafe).to.be.true;
      expect(props.domain).to.equal("qorechain-pqc-hybrid-v2");
    });

    it("D4-2: should verify AES-256-GCM authenticated encryption parameters", function () {
      const comp = cbom.components.find((c) => c.name === "AES-256-GCM");
      expect(comp).to.exist;
      const props = comp!.cryptoProperties.algorithmProperties;
      expect(props.keyLength).to.equal(256);
      expect(props.ivLength).to.equal(96);
      expect(props.tagLength).to.equal(128);
      expect(props.quantumSafe).to.be.true;
    });

    it("D4-3: should verify Keccak-256 256-bit state root hashing properties", function () {
      const comp = cbom.components.find((c) => c.name === "Keccak-256");
      expect(comp).to.exist;
      const props = comp!.cryptoProperties.algorithmProperties;
      expect(props.digestLength).to.equal(256);
      expect(props.quantumSafe).to.be.true;
    });
  });

  describe("Dimension 5: Zero Classical Batch Anchoring Invariant & Disk Persistence Parity", function () {
    it("D5-1: should prove zero quantum-vulnerable signature schemes in rollup settlement pipeline", function () {
      for (const comp of cbom.components) {
        expect(comp.cryptoProperties.algorithmProperties.quantumSafe).to.be.true;
      }
    });

    it("D5-2: should verify cbom.json exists on disk and is valid CycloneDX 1.6 JSON", function () {
      expect(fs.existsSync(cbomPath)).to.be.true;
      const diskContent = JSON.parse(fs.readFileSync(cbomPath, "utf8")) as CycloneDxCbom;
      expect(diskContent.bomFormat).to.equal("CycloneDX");
      expect(diskContent.specVersion).to.equal("1.6");
      expect(diskContent.components).to.be.an("array").with.lengthOf(5);
    });
  });
});
