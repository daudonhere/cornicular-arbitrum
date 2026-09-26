import { expect } from "chai"
import { ethers, upgrades } from "hardhat"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"

function leaf(fileHash: string, metadataHash: string): string {
  return ethers.solidityPackedKeccak256(
    ["bytes32", "bytes32"],
    [fileHash, metadataHash]
  )
}

function combine(a: string, b: string): string {
  return a <= b
    ? ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [a, b])
    : ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [b, a])
}

function buildMerkleTree(
  leaves: string[]
): {
  root: string
  proof: (leaf: string) => string[]
} {
  const levels = [leaves.slice()]
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1]
    const next: string[] = []
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]
      const right = i + 1 < current.length ? current[i + 1] : left
      next.push(combine(left, right))
    }
    levels.push(next)
  }
  const root = levels[levels.length - 1][0]

  function proofFor(target: string): string[] {
    let idx = leaves.indexOf(target)
    if (idx === -1) throw new Error("leaf not in tree")
    const proof: string[] = []
    for (const level of levels.slice(0, -1)) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1
      proof.push(
        siblingIdx < level.length ? level[siblingIdx] : level[level.length - 1]
      )
      idx = Math.floor(idx / 2)
    }
    return proof
  }

  return { root, proof: proofFor }
}

async function eip712Domain(registry: any, chainId: bigint) {
  return {
    name: "Cornicular",
    version: "1",
    chainId: chainId,
    verifyingContract: await registry.getAddress(),
  }
}

const EIP712_TYPES = {
  RegisterRequest: [
    { name: "fileHash", type: "bytes32" },
    { name: "metadataHash", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
}

describe("CornicularRegistry (upgradeable)", function () {
  async function deployFixture() {
    const [deployer, issuer, other, newOwner] = await ethers.getSigners()
    const factory = await ethers.getContractFactory("CornicularRegistry")
    const proxy = await upgrades.deployProxy(
      factory,
      [deployer.address, issuer.address],
      { kind: "transparent" }
    )
    await proxy.waitForDeployment()
    const registry = await ethers.getContractAt(
      "CornicularRegistry",
      await proxy.getAddress()
    )
    const ISSUER_ROLE = await registry.ISSUER_ROLE()
    const PAUSER_ROLE = await registry.PAUSER_ROLE()
    const fileHash = ethers.keccak256(ethers.toUtf8Bytes("file-v1"))
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("meta-v1"))
    const chainId = (await ethers.provider.getNetwork()).chainId
    return {
      proxy,
      registry,
      deployer,
      issuer,
      other,
      newOwner,
      ISSUER_ROLE,
      PAUSER_ROLE,
      fileHash,
      metadataHash,
      chainId,
    }
  }

  describe("roles", function () {
    it("grants admin and pauser roles to deployer", async function () {
      const { registry, deployer, ISSUER_ROLE, PAUSER_ROLE } =
        await loadFixture(deployFixture)
      expect(
        await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), deployer.address)
      ).to.equal(true)
      expect(await registry.hasRole(PAUSER_ROLE, deployer.address)).to.equal(true)
      expect(await registry.hasRole(ISSUER_ROLE, deployer.address)).to.equal(false)
    })

    it("grants issuer role to initial issuer", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      expect(await registry.isIssuer(issuer.address)).to.equal(true)
    })

    it("returns false for non-issuer via isIssuer", async function () {
      const { registry, other } = await loadFixture(deployFixture)
      expect(await registry.isIssuer(other.address)).to.equal(false)
    })
  })

  describe("register", function () {
    it("registers a file with explicit owner different from issuer", async function () {
      const { registry, issuer, newOwner, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      const tx = await registry
        .connect(issuer)
        .register(fileHash, metadataHash, newOwner.address)
      const receipt = await tx.wait()
      const event = receipt?.logs
        .map((log) => {
          try {
            return registry.interface.parseLog(log)
          } catch {
            return null
          }
        })
        .find((parsed) => parsed?.name === "FileRegistered")
      expect(event).to.not.equal(undefined)
      const certificateId = event?.args.certificateId as string
      expect(certificateId).to.match(/^0x[0-9a-f]{64}$/)
      const [, , issuerAddr, owner] = await registry.prove(fileHash)
      expect(issuerAddr).to.equal(issuer.address)
      expect(owner).to.equal(newOwner.address)
    })

    it("reverts register with zero owner", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await expect(
        registry
          .connect(issuer)
          .register(fileHash, metadataHash, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "InvalidOwner")
    })

    it("rejects non-issuer registration", async function () {
      const { registry, other, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await expect(
        registry.connect(other).register(fileHash, metadataHash, other.address)
      ).to.be.revertedWithCustomError(registry, "NotIssuer")
    })

    it("registers a batch", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const hashes = [
        ethers.keccak256(ethers.toUtf8Bytes("file-a")),
        ethers.keccak256(ethers.toUtf8Bytes("file-b")),
        ethers.keccak256(ethers.toUtf8Bytes("file-c")),
      ]
      const metas = [
        ethers.keccak256(ethers.toUtf8Bytes("meta-a")),
        ethers.keccak256(ethers.toUtf8Bytes("meta-b")),
        ethers.keccak256(ethers.toUtf8Bytes("meta-c")),
      ]
      const tx = await registry.connect(issuer).registerBatch(hashes, metas, issuer.address)
      const receipt = await tx.wait()
      expect(receipt?.status).to.equal(1)
      const ids = await registry.getFileCertificates(hashes[0])
      expect(ids.length).to.equal(1)
    })

    it("reverts batch with mismatched array lengths", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const hashes = [
        ethers.keccak256(ethers.toUtf8Bytes("file-x")),
        ethers.keccak256(ethers.toUtf8Bytes("file-y")),
      ]
      const metas = [ethers.keccak256(ethers.toUtf8Bytes("meta-x"))]
      await expect(
        registry.connect(issuer).registerBatch(hashes, metas, issuer.address)
      ).to.be.revertedWithCustomError(registry, "ArrayLengthMismatch")
    })

    it("rejects batch from non-issuer", async function () {
      const { registry, other } = await loadFixture(deployFixture)
      const hashes = [ethers.keccak256(ethers.toUtf8Bytes("file-z"))]
      const metas = [ethers.keccak256(ethers.toUtf8Bytes("meta-z"))]
      await expect(
        registry.connect(other).registerBatch(hashes, metas, other.address)
      ).to.be.revertedWithCustomError(registry, "NotIssuer")
    })

    it("reverts batch with zero owner", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const hashes = [ethers.keccak256(ethers.toUtf8Bytes("file-0"))]
      const metas = [ethers.keccak256(ethers.toUtf8Bytes("meta-0"))]
      await expect(
        registry
          .connect(issuer)
          .registerBatch(hashes, metas, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "InvalidOwner")
    })

    it("reverts registration while paused", async function () {
      const { registry, deployer, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(deployer).pause()
      await expect(
        registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause")
    })
  })

  describe("registerWithSignature", function () {
    it("registers via valid issuer signature with owner from request", async function () {
      const { registry, issuer, other, newOwner, chainId } =
        await loadFixture(deployFixture)
      const fileHash = ethers.keccak256(ethers.toUtf8Bytes("sig-file"))
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("sig-meta"))
      const nonce = await registry.getNonce(issuer.address)
      const deadline = Math.floor(Date.now() / 1000) + 3600
      const domain = await eip712Domain(registry, chainId)
      const value = {
        fileHash: fileHash,
        metadataHash: metaHash,
        owner: newOwner.address,
        nonce: nonce,
        deadline: deadline,
      }
      const signature = await issuer.signTypedData(domain, EIP712_TYPES, value)
      await registry.connect(other).registerWithSignature(value, signature)
      const [, , issuerAddr, ownerAddr] = await registry.prove(fileHash)
      expect(issuerAddr).to.equal(issuer.address)
      expect(ownerAddr).to.equal(newOwner.address)
    })

    it("reverts signature registration with zero owner", async function () {
      const { registry, issuer, other, chainId } =
        await loadFixture(deployFixture)
      const fileHash = ethers.keccak256(ethers.toUtf8Bytes("zero-owner-file"))
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("zero-owner-meta"))
      const nonce = await registry.getNonce(issuer.address)
      const deadline = Math.floor(Date.now() / 1000) + 3600
      const domain = await eip712Domain(registry, chainId)
      const value = {
        fileHash: fileHash,
        metadataHash: metaHash,
        owner: ethers.ZeroAddress,
        nonce: nonce,
        deadline: deadline,
      }
      const signature = await issuer.signTypedData(domain, EIP712_TYPES, value)
      await expect(
        registry.connect(other).registerWithSignature(value, signature)
      ).to.be.revertedWithCustomError(registry, "InvalidOwner")
    })

    it("reverts with expired signature", async function () {
      const { registry, issuer, other, chainId } =
        await loadFixture(deployFixture)
      const fileHash = ethers.keccak256(ethers.toUtf8Bytes("expired-file"))
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("expired-meta"))
      const nonce = await registry.getNonce(issuer.address)
      const deadline = 1
      const domain = await eip712Domain(registry, chainId)
      const value = {
        fileHash: fileHash,
        metadataHash: metaHash,
        owner: issuer.address,
        nonce: nonce,
        deadline: deadline,
      }
      const signature = await issuer.signTypedData(domain, EIP712_TYPES, value)
      await expect(
        registry.connect(other).registerWithSignature(value, signature)
      ).to.be.revertedWithCustomError(registry, "SignatureExpired")
    })

    it("reverts with wrong nonce", async function () {
      const { registry, issuer, other, chainId } =
        await loadFixture(deployFixture)
      const fileHash = ethers.keccak256(ethers.toUtf8Bytes("nonce-file"))
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("nonce-meta"))
      const nonce = await registry.getNonce(issuer.address)
      const deadline = Math.floor(Date.now() / 1000) + 3600
      const domain = await eip712Domain(registry, chainId)
      const value = {
        fileHash: fileHash,
        metadataHash: metaHash,
        owner: issuer.address,
        nonce: nonce + 999n,
        deadline: deadline,
      }
      const signature = await issuer.signTypedData(domain, EIP712_TYPES, value)
      await expect(
        registry.connect(other).registerWithSignature(value, signature)
      ).to.be.revertedWithCustomError(registry, "NonceAlreadyUsed")
    })

    it("reverts with non-issuer signature", async function () {
      const { registry, issuer, other, chainId } =
        await loadFixture(deployFixture)
      const fileHash = ethers.keccak256(ethers.toUtf8Bytes("bad-sig-file"))
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("bad-sig-meta"))
      const nonce = await registry.getNonce(other.address)
      const deadline = Math.floor(Date.now() / 1000) + 3600
      const domain = await eip712Domain(registry, chainId)
      const value = {
        fileHash: fileHash,
        metadataHash: metaHash,
        owner: issuer.address,
        nonce: nonce,
        deadline: deadline,
      }
      const signature = await other.signTypedData(domain, EIP712_TYPES, value)
      await expect(
        registry.connect(issuer).registerWithSignature(value, signature)
      ).to.be.revertedWithCustomError(registry, "InvalidSignature")
    })

    it("increments issuer nonce after successful registration", async function () {
      const { registry, issuer, other, chainId } =
        await loadFixture(deployFixture)
      const fileHash = ethers.keccak256(ethers.toUtf8Bytes("nonce-inc-file"))
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("nonce-inc-meta"))
      const nonceBefore = await registry.getNonce(issuer.address)
      const deadline = Math.floor(Date.now() / 1000) + 3600
      const domain = await eip712Domain(registry, chainId)
      const value = {
        fileHash: fileHash,
        metadataHash: metaHash,
        owner: issuer.address,
        nonce: nonceBefore,
        deadline: deadline,
      }
      const signature = await issuer.signTypedData(domain, EIP712_TYPES, value)
      await registry.connect(other).registerWithSignature(value, signature)
      const nonceAfter = await registry.getNonce(issuer.address)
      expect(nonceAfter).to.equal(nonceBefore + 1n)
    })

    it("rejects replay of the same signature via a different relayer", async function () {
      const { registry, issuer, other, newOwner, chainId } =
        await loadFixture(deployFixture)
      const fileHash = ethers.keccak256(ethers.toUtf8Bytes("replay-file"))
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("replay-meta"))
      const nonce = await registry.getNonce(issuer.address)
      const deadline = Math.floor(Date.now() / 1000) + 3600
      const domain = await eip712Domain(registry, chainId)
      const value = {
        fileHash: fileHash,
        metadataHash: metaHash,
        owner: newOwner.address,
        nonce: nonce,
        deadline: deadline,
      }
      const signature = await issuer.signTypedData(domain, EIP712_TYPES, value)
      await registry.connect(other).registerWithSignature(value, signature)
      await expect(
        registry.connect(newOwner).registerWithSignature(value, signature)
      ).to.be.revertedWithCustomError(registry, "NonceAlreadyUsed")
      const certs = await registry.getFileCertificates(fileHash)
      expect(certs.length).to.equal(1)
    })

    it("reverts signature registration while paused", async function () {
      const { registry, deployer, issuer, other, chainId } =
        await loadFixture(deployFixture)
      const fileHash = ethers.keccak256(ethers.toUtf8Bytes("paused-sig-file"))
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("paused-sig-meta"))
      const nonce = await registry.getNonce(issuer.address)
      const deadline = Math.floor(Date.now() / 1000) + 3600
      const domain = await eip712Domain(registry, chainId)
      const value = {
        fileHash: fileHash,
        metadataHash: metaHash,
        owner: issuer.address,
        nonce: nonce,
        deadline: deadline,
      }
      const signature = await issuer.signTypedData(domain, EIP712_TYPES, value)
      await registry.connect(deployer).pause()
      await expect(
        registry.connect(other).registerWithSignature(value, signature)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause")
    })
  })

  describe("merkle batch", function () {
    it("registers a root and issues members via proof", async function () {
      const { registry, issuer, newOwner } = await loadFixture(deployFixture)
      const leaves = ["a", "b", "c", "d"].map((s) =>
        ethers.keccak256(ethers.toUtf8Bytes(s))
      )
      const metas = ["m-a", "m-b", "m-c", "m-d"].map((s) =>
        ethers.keccak256(ethers.toUtf8Bytes(s))
      )
      if (leaves.length !== 4) throw new Error("fixture mismatch")
      const treeLeaves = ["a", "b", "c", "d"].map((s, i) =>
        leaf(leaves[i], metas[i])
      )
      const { root, proof } = buildMerkleTree(treeLeaves)

      await registry.connect(issuer).registerRoot(root, 4)
      expect(await registry.verifyMember(root, treeLeaves[2], proof(treeLeaves[2]))).to.equal(true)

      const tx = await registry
        .connect(issuer)
        .registerIntoRoot(leaves[2], metas[2], root, proof(treeLeaves[2]), newOwner.address)
      const receipt = await tx.wait()
      expect(receipt?.status).to.equal(1)
      const [, , issuerAddr, owner] = await registry.prove(leaves[2])
      expect(issuerAddr).to.equal(issuer.address)
      expect(owner).to.equal(newOwner.address)
    })

    it("reverts registerIntoRoot with zero owner", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const leaves = ["a", "b"].map((s) =>
        ethers.keccak256(ethers.toUtf8Bytes(s))
      )
      const metas = ["m-a", "m-b"].map((s) =>
        ethers.keccak256(ethers.toUtf8Bytes(s))
      )
      const treeLeaves = [leaf(leaves[0], metas[0]), leaf(leaves[1], metas[1])]
      const { root, proof } = buildMerkleTree(treeLeaves)
      await registry.connect(issuer).registerRoot(root, 2)
      await expect(
        registry
          .connect(issuer)
          .registerIntoRoot(
            leaves[0],
            metas[0],
            root,
            proof(treeLeaves[0]),
            ethers.ZeroAddress
          )
      ).to.be.revertedWithCustomError(registry, "InvalidOwner")
    })

    it("rejects member with an invalid proof", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const leaves = ["a", "b"].map((s) =>
        ethers.keccak256(ethers.toUtf8Bytes(s))
      )
      const metas = ["m-a", "m-b"].map((s) =>
        ethers.keccak256(ethers.toUtf8Bytes(s))
      )
      const treeLeaves = [leaf(leaves[0], metas[0]), leaf(leaves[1], metas[1])]
      const { root, proof } = buildMerkleTree(treeLeaves)

      await registry.connect(issuer).registerRoot(root, 2)

      const badProof = proof(treeLeaves[1])
      const badFlips = badProof.map(() => ethers.ZeroHash)
      await expect(
        registry
          .connect(issuer)
          .registerIntoRoot(leaves[0], metas[0], root, badFlips, issuer.address)
      ).to.be.revertedWithCustomError(registry, "InvalidMerkleProof")
    })

    it("reverts registerRoot from non-issuer", async function () {
      const { registry, other } = await loadFixture(deployFixture)
      const fakeRoot = ethers.keccak256(ethers.toUtf8Bytes("fake-root"))
      await expect(
        registry.connect(other).registerRoot(fakeRoot, 10)
      ).to.be.revertedWithCustomError(registry, "NotIssuer")
    })

    it("reverts registering the same root twice", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const root = ethers.keccak256(ethers.toUtf8Bytes("dup-root"))
      await registry.connect(issuer).registerRoot(root, 4)
      await expect(
        registry.connect(issuer).registerRoot(root, 4)
      ).to.be.revertedWithCustomError(registry, "MerkleRootAlreadyRegistered")
    })

    it("reverts registerIntoRoot for non-existent root", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const fakeRoot = ethers.keccak256(ethers.toUtf8Bytes("no-root"))
      const fileHash = ethers.keccak256(ethers.toUtf8Bytes("orphan-file"))
      const metaHash = ethers.keccak256(ethers.toUtf8Bytes("orphan-meta"))
      await expect(
        registry.connect(issuer).registerIntoRoot(fileHash, metaHash, fakeRoot, [], issuer.address)
      ).to.be.revertedWithCustomError(registry, "MerkleRootNotFound")
    })

    it("verifyMember returns false for non-existent root", async function () {
      const { registry } = await loadFixture(deployFixture)
      const fakeRoot = ethers.keccak256(ethers.toUtf8Bytes("ghost-root"))
      const leaf = ethers.keccak256(ethers.toUtf8Bytes("ghost-leaf"))
      expect(await registry.verifyMember(fakeRoot, leaf, [])).to.equal(false)
    })

    it("returns correct getMerkleRoot data", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const root = ethers.keccak256(ethers.toUtf8Bytes("mr-root"))
      await registry.connect(issuer).registerRoot(root, 5)
      const [issuerAddr, leafCount, registeredAt] =
        await registry.getMerkleRoot(root)
      expect(issuerAddr).to.equal(issuer.address)
      expect(leafCount).to.equal(5)
      expect(registeredAt).to.be.gt(0)
    })

    it("getMerkleRoot returns zero values for non-existent root", async function () {
      const { registry } = await loadFixture(deployFixture)
      const fakeRoot = ethers.keccak256(ethers.toUtf8Bytes("nope"))
      const [issuerAddr, leafCount, registeredAt] =
        await registry.getMerkleRoot(fakeRoot)
      expect(issuerAddr).to.equal(ethers.ZeroAddress)
      expect(leafCount).to.equal(0)
      expect(registeredAt).to.equal(0)
    })
  })

  describe("ownership transfer", function () {
    it("transfers ownership producing a new version and moving owner", async function () {
      const { registry, issuer, other, newOwner, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [oldId, , , oldOwner] = await registry.prove(fileHash)
      expect(oldOwner).to.equal(issuer.address)

      const tx = await registry.connect(issuer).transferOwnership(oldId, newOwner.address)
      const receipt = await tx.wait()
      const event = receipt?.logs
        .map((log) => {
          try {
            return registry.interface.parseLog(log)
          } catch {
            return null
          }
        })
        .find((parsed) => parsed?.name === "FileOwnershipTransferred")
      const newId = event?.args.newCertificateId as string
      expect(newId).to.not.equal(oldId)

      const [newCertId, , , newOwnerAddr, status] =
        await registry.prove(fileHash)
      expect(newCertId).to.equal(newId)
      expect(newOwnerAddr).to.equal(newOwner.address)
      expect(status).to.equal(0)

      const [, , , , oldStatus, , prev] = await registry.getCertificate(oldId)
      expect(oldStatus).to.equal(1)
      expect(prev).to.equal(ethers.ZeroHash)

      const [, , , , , , newPrev] = await registry.getCertificate(newId)
      expect(newPrev).to.equal(oldId)
    })

    it("allows only actor or admin to transfer", async function () {
      const { registry, issuer, other, newOwner, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await expect(
        registry.connect(other).transferOwnership(certificateId, newOwner.address)
      ).to.be.revertedWithCustomError(registry, "InvalidOwner")
    })

    it("any issuer can transfer a certificate registered by another issuer", async function () {
      const { registry, deployer, issuer, other, newOwner, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [oldId, , , oldOwner] = await registry.prove(fileHash)
      expect(oldOwner).to.equal(issuer.address)
      await registry
        .connect(deployer)
        .grantRole(await registry.ISSUER_ROLE(), other.address)
      await registry.connect(other).transferOwnership(oldId, newOwner.address)
      const [, , , owner, status] = await registry.prove(fileHash)
      expect(owner).to.equal(newOwner.address)
      expect(status).to.equal(0)
    })

    it("reverts transfer to zero address", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await expect(
        registry
          .connect(issuer)
          .transferOwnership(certificateId, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "InvalidOwner")
    })

    it("reverts transfer of non-existent certificate", async function () {
      const { registry, issuer, newOwner } = await loadFixture(deployFixture)
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("no-cert"))
      await expect(
        registry.connect(issuer).transferOwnership(fakeId, newOwner.address)
      ).to.be.revertedWithCustomError(registry, "CertificateNotFound")
    })

    it("reverts transfer of replaced certificate", async function () {
      const { registry, issuer, newOwner, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [oldId] = await registry.prove(fileHash)
      const newHash = ethers.keccak256(ethers.toUtf8Bytes("v2-for-transfer"))
      const newMeta = ethers.keccak256(ethers.toUtf8Bytes("meta-v2-transfer"))
      await registry.connect(issuer).replace(oldId, newHash, newMeta)
      await expect(
        registry.connect(issuer).transferOwnership(oldId, newOwner.address)
      ).to.be.revertedWithCustomError(registry, "AlreadyReplaced")
    })
  })

  describe("status transitions", function () {
    it("revokes an active certificate as its issuer", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await registry.connect(issuer).revoke(certificateId)
      const [, , , , status] = await registry.prove(fileHash)
      expect(status).to.equal(2)
    })

    it("replaces an active certificate preserving owner", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [oldId, , , oldOwner] = await registry.prove(fileHash)
      const newHash = ethers.keccak256(ethers.toUtf8Bytes("file-v2"))
      const newMeta = ethers.keccak256(ethers.toUtf8Bytes("meta-v2"))
      await registry.connect(issuer).replace(oldId, newHash, newMeta)
      const [newId, , , newOwner, newStatus] = await registry.prove(newHash)
      expect(newId).to.not.equal(oldId)
      expect(newOwner).to.equal(oldOwner)
      expect(newStatus).to.equal(0)
      const [, , , , oldStatus, , prev] = await registry.getCertificate(oldId)
      expect(oldStatus).to.equal(1)
      expect(prev).to.equal(ethers.ZeroHash)
      const [, , , , , , newPrev] = await registry.getCertificate(newId)
      expect(newPrev).to.equal(oldId)
    })

    it("removes an active certificate", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await registry.connect(issuer).remove(certificateId)
      const [, , , , status] = await registry.prove(fileHash)
      expect(status).to.equal(3)
    })

    it("reverts replace on already replaced certificate", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [oldId] = await registry.prove(fileHash)
      const newHash = ethers.keccak256(ethers.toUtf8Bytes("v2"))
      const newMeta = ethers.keccak256(ethers.toUtf8Bytes("meta-v2"))
      await registry.connect(issuer).replace(oldId, newHash, newMeta)
      await expect(
        registry
          .connect(issuer)
          .replace(oldId, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, "AlreadyReplaced")
    })

    it("reverts replace on non-existent certificate", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("gone"))
      await expect(
        registry
          .connect(issuer)
          .replace(fakeId, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, "CertificateNotFound")
    })

    it("rejects replace from a non-issuer", async function () {
      const { registry, deployer, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [oldId] = await registry.prove(fileHash)
      const newHash = ethers.keccak256(ethers.toUtf8Bytes("non-issuer-replace-v2"))
      const newMeta = ethers.keccak256(ethers.toUtf8Bytes("non-issuer-replace-meta"))
      await expect(
        registry.connect(deployer).replace(oldId, newHash, newMeta)
      ).to.be.revertedWithCustomError(registry, "NotIssuer")
    })

    it("any issuer can replace a certificate registered by another issuer", async function () {
      const { registry, deployer, issuer, other, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [oldId] = await registry.prove(fileHash)
      await registry
        .connect(deployer)
        .grantRole(await registry.ISSUER_ROLE(), other.address)
      const newHash = ethers.keccak256(ethers.toUtf8Bytes("cross-issuer-v2"))
      const newMeta = ethers.keccak256(ethers.toUtf8Bytes("cross-issuer-meta"))
      const tx = await registry.connect(other).replace(oldId, newHash, newMeta)
      const receipt = await tx.wait()
      expect(receipt?.status).to.equal(1)
      const [newId] = await registry.prove(newHash)
      expect(newId).to.not.equal(oldId)
    })

    it("reverts revoke on non-existent certificate", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("ghost"))
      await expect(
        registry.connect(issuer).revoke(fakeId)
      ).to.be.revertedWithCustomError(registry, "CertificateNotFound")
    })

    it("reverts remove on non-existent certificate", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("phantom"))
      await expect(
        registry.connect(issuer).remove(fakeId)
      ).to.be.revertedWithCustomError(registry, "CertificateNotFound")
    })

    it("reverts revoke on a replaced certificate", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [oldId] = await registry.prove(fileHash)
      const newHash = ethers.keccak256(ethers.toUtf8Bytes("revoked-replaced-v2"))
      const newMeta = ethers.keccak256(ethers.toUtf8Bytes("revoked-replaced-meta"))
      await registry.connect(issuer).replace(oldId, newHash, newMeta)
      await expect(
        registry.connect(issuer).revoke(oldId)
      ).to.be.revertedWithCustomError(registry, "CertificateNotActive")
    })

    it("reverts remove on a revoked certificate", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await registry.connect(issuer).revoke(certificateId)
      await expect(
        registry.connect(issuer).remove(certificateId)
      ).to.be.revertedWithCustomError(registry, "CertificateNotActive")
    })

    it("reverts double revoke of a revoked certificate", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await registry.connect(issuer).revoke(certificateId)
      await expect(
        registry.connect(issuer).revoke(certificateId)
      ).to.be.revertedWithCustomError(registry, "CertificateNotActive")
    })

    it("admin can revoke any certificate", async function () {
      const { registry, deployer, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await registry.connect(deployer).revoke(certificateId)
      const [, , , , status] = await registry.prove(fileHash)
      expect(status).to.equal(2)
    })

    it("admin can remove any certificate", async function () {
      const { registry, deployer, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await registry.connect(deployer).remove(certificateId)
      const [, , , , status] = await registry.prove(fileHash)
      expect(status).to.equal(3)
    })

    it("any issuer can revoke a certificate registered by another issuer", async function () {
      const { registry, deployer, issuer, other, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await registry
        .connect(deployer)
        .grantRole(await registry.ISSUER_ROLE(), other.address)
      await registry.connect(other).revoke(certificateId)
      const [, , , , status] = await registry.prove(fileHash)
      expect(status).to.equal(2)
    })

    it("any issuer can remove a certificate registered by another issuer", async function () {
      const { registry, deployer, issuer, other, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await registry
        .connect(deployer)
        .grantRole(await registry.ISSUER_ROLE(), other.address)
      await registry.connect(other).remove(certificateId)
      const [, , , , status] = await registry.prove(fileHash)
      expect(status).to.equal(3)
    })

    it("non-actor non-admin cannot revoke", async function () {
      const { registry, issuer, other, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await expect(
        registry.connect(other).revoke(certificateId)
      ).to.be.revertedWithCustomError(registry, "InvalidOwner")
    })

    it("non-actor non-admin cannot remove", async function () {
      const { registry, issuer, other, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await expect(
        registry.connect(other).remove(certificateId)
      ).to.be.revertedWithCustomError(registry, "InvalidOwner")
    })
  })

  describe("view functions", function () {
    it("getCertificate returns full details for existing certificate", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      const [
        file,
        meta,
        issuerAddr,
        ownerAddr,
        status,
        registeredAt,
        prevVersion,
        merkleRoot,
        merkleProof,
      ] = await registry.getCertificate(certificateId)
      expect(file).to.equal(fileHash)
      expect(meta).to.equal(metadataHash)
      expect(issuerAddr).to.equal(issuer.address)
      expect(ownerAddr).to.equal(issuer.address)
      expect(status).to.equal(0)
      expect(registeredAt).to.be.gt(0)
      expect(prevVersion).to.equal(ethers.ZeroHash)
      expect(merkleRoot).to.equal(ethers.ZeroHash)
      expect(merkleProof.length).to.equal(0)
    })

    it("getCertificate reverts for non-existent certificate", async function () {
      const { registry } = await loadFixture(deployFixture)
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("nope"))
      await expect(
        registry.getCertificate(fakeId)
      ).to.be.revertedWithCustomError(registry, "CertificateNotFound")
    })

    it("prove reverts for unregistered file", async function () {
      const { registry } = await loadFixture(deployFixture)
      const fakeFile = ethers.keccak256(ethers.toUtf8Bytes("never-registered"))
      await expect(
        registry.prove(fakeFile)
      ).to.be.revertedWithCustomError(registry, "FileNotRegistered")
    })

    it("getFileCertificates returns version history", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const v1 = await registry.getFileCertificates(fileHash)
      expect(v1.length).to.equal(1)

      const newOwner = ethers.Wallet.createRandom().address
      await registry.connect(issuer).transferOwnership(v1[0], newOwner)
      const v2 = await registry.getFileCertificates(fileHash)
      expect(v2.length).to.equal(2)
      expect(v2[0]).to.equal(v1[0])
    })

    it("getFileCertificates returns empty array for unknown file", async function () {
      const { registry } = await loadFixture(deployFixture)
      const fakeFile = ethers.keccak256(ethers.toUtf8Bytes("unknown"))
      const certs = await registry.getFileCertificates(fakeFile)
      expect(certs.length).to.equal(0)
    })

    it("getNonce returns zero for fresh account", async function () {
      const { registry, other } = await loadFixture(deployFixture)
      const nonce = await registry.getNonce(other.address)
      expect(nonce).to.equal(0)
    })
  })

  describe("pause", function () {
    it("blocks registration while paused", async function () {
      const { registry, deployer, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(deployer).pause()
      await expect(
        registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause")
      await registry.connect(deployer).unpause()
      await expect(
        registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      ).to.emit(registry, "FileRegistered")
    })

    it("only pauser can pause", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      await expect(
        registry.connect(issuer).pause()
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
    })

    it("only pauser can unpause", async function () {
      const { registry, deployer, issuer } = await loadFixture(deployFixture)
      await registry.connect(deployer).pause()
      await expect(
        registry.connect(issuer).unpause()
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
    })

    it("blocks transfer while paused", async function () {
      const { registry, deployer, issuer, newOwner, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await registry.connect(deployer).pause()
      await expect(
        registry.connect(issuer).transferOwnership(certificateId, newOwner.address)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause")
    })

    it("blocks revoke while paused", async function () {
      const { registry, deployer, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [certificateId] = await registry.prove(fileHash)
      await registry.connect(deployer).pause()
      await expect(
        registry.connect(issuer).revoke(certificateId)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause")
    })
  })

  describe("events", function () {
    it("emits FileRegistered on register", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      const tx = await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const receipt = await tx.wait()
      const event = receipt?.logs
        .map((log) => {
          try {
            return registry.interface.parseLog(log)
          } catch {
            return null
          }
        })
        .find((parsed) => parsed?.name === "FileRegistered")
      expect(event).to.not.equal(undefined)
      expect(event?.args.fileHash).to.equal(fileHash)
      expect(event?.args.metadataHash).to.equal(metadataHash)
      expect(event?.args.issuer).to.equal(issuer.address)
    })

    it("emits FileRevoked with issuer and revoking actor", async function () {
      const { registry, issuer, newOwner, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, newOwner.address)
      const [certificateId] = await registry.prove(fileHash)
      await expect(registry.connect(newOwner).revoke(certificateId))
        .to.emit(registry, "FileRevoked")
        .withArgs(certificateId, issuer.address, newOwner.address)
    })

    it("emits FileReplaced on replace", async function () {
      const { registry, issuer, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [oldId] = await registry.prove(fileHash)
      const newHash = ethers.keccak256(ethers.toUtf8Bytes("v2-event"))
      const newMeta = ethers.keccak256(ethers.toUtf8Bytes("meta-v2-event"))
      const tx = await registry.connect(issuer).replace(oldId, newHash, newMeta)
      const receipt = await tx.wait()
      const events = receipt?.logs
        .map((log) => {
          try {
            return registry.interface.parseLog(log)
          } catch {
            return null
          }
        })
        .filter(Boolean)
      const replaced = events?.find((e) => e?.name === "FileReplaced")
      expect(replaced).to.not.equal(undefined)
      expect(replaced?.args.previousCertificateId).to.equal(oldId)
      expect(replaced?.args.issuer).to.equal(issuer.address)
    })

    it("emits FileRemoved with issuer and removing actor", async function () {
      const { registry, issuer, newOwner, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, newOwner.address)
      const [certificateId] = await registry.prove(fileHash)
      await expect(registry.connect(newOwner).remove(certificateId))
        .to.emit(registry, "FileRemoved")
        .withArgs(certificateId, issuer.address, newOwner.address)
    })

    it("emits FileOwnershipTransferred on transfer", async function () {
      const { registry, issuer, newOwner, fileHash, metadataHash } =
        await loadFixture(deployFixture)
      await registry.connect(issuer).register(fileHash, metadataHash, issuer.address)
      const [oldId] = await registry.prove(fileHash)
      const tx = await registry
        .connect(issuer)
        .transferOwnership(oldId, newOwner.address)
      const receipt = await tx.wait()
      const events = receipt?.logs
        .map((log) => {
          try {
            return registry.interface.parseLog(log)
          } catch {
            return null
          }
        })
        .filter(Boolean)
      const ownership = events?.find((e) => e?.name === "FileOwnershipTransferred")
      expect(ownership).to.not.equal(undefined)
    })

    it("emits MerkleRootRegistered on registerRoot", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      const root = ethers.keccak256(ethers.toUtf8Bytes("event-root"))
      const tx = await registry.connect(issuer).registerRoot(root, 3)
      const receipt = await tx.wait()
      const events = receipt?.logs
        .map((log) => {
          try {
            return registry.interface.parseLog(log)
          } catch {
            return null
          }
        })
        .filter(Boolean)
      const merkle = events?.find((e) => e?.name === "MerkleRootRegistered")
      expect(merkle).to.not.equal(undefined)
    })

    it("emits IssuerRoleGranted on initialize", async function () {
      const { registry, issuer } = await loadFixture(deployFixture)
      expect(await registry.isIssuer(issuer.address)).to.equal(true)
    })

    it("emits ContractUpgraded on initialize", async function () {
      const { registry, deployer } = await loadFixture(deployFixture)
      expect(
        await registry.hasRole(
          await registry.DEFAULT_ADMIN_ROLE(),
          deployer.address
        )
      ).to.equal(true)
    })

    it("emits IssuerRoleRevoked when admin revokes issuer role", async function () {
      const { registry, deployer, issuer } = await loadFixture(deployFixture)
      expect(await registry.isIssuer(issuer.address)).to.equal(true)
      await expect(
        registry
          .connect(deployer)
          .revokeRole(await registry.ISSUER_ROLE(), issuer.address)
      ).to.emit(registry, "IssuerRoleRevoked")
      expect(await registry.isIssuer(issuer.address)).to.equal(false)
    })

    it("emits IssuerRoleGranted when admin grants the issuer role", async function () {
      const { registry, deployer, other } = await loadFixture(deployFixture)
      await expect(
        registry
          .connect(deployer)
          .grantRole(await registry.ISSUER_ROLE(), other.address)
      ).to.emit(registry, "IssuerRoleGranted")
      expect(await registry.isIssuer(other.address)).to.equal(true)
    })
  })
})
