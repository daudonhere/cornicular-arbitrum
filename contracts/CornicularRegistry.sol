// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title CornicularRegistry
/// @notice Upgradeable file integrity registry deployed behind a
/// transparent proxy. Tracks certificates keyed by a derived id, supports
/// versioning, ownership transfer and Merkle-batched registration.
/// @dev Upgradeable pattern: initializer instead of constructor, OZ
/// upgradeable base contracts, reserved __gap for future storage.
contract CornicularRegistry is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable
{
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    enum Status {
        ACTIVE,
        REPLACED,
        REVOKED,
        REMOVED
    }

    /// @notice A registered file certificate, versioned over time.
    struct Certificate {
        bytes32 fileHash;
        bytes32 metadataHash;
        address issuer;
        address owner;
        Status status;
        uint256 registeredAt;
        bytes32 previousVersionId;
        bytes32 parentMerkleRoot;
        bytes32[] merkleProof;
    }

    /// @notice Off-chain signed payload for permissionless registration.
    struct RegisterRequest {
        bytes32 fileHash;
        bytes32 metadataHash;
        address owner;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice A Merkle root committed by an issuer, representing a batch.
    struct MerkleRootRecord {
        address issuer;
        uint256 leafCount;
        uint256 registeredAt;
        bool exists;
    }

    bytes32 private constant REGISTER_REQUEST_TYPEHASH =
        keccak256(
            "RegisterRequest(bytes32 fileHash,bytes32 metadataHash,address owner,uint256 nonce,uint256 deadline)"
        );

    mapping(bytes32 => Certificate) private certificates;
    mapping(bytes32 => bytes32[]) private fileCertificates;
    mapping(bytes32 => bytes32) private latestCertificate;
    mapping(address => uint256) private nonces;
    mapping(bytes32 => MerkleRootRecord) private merkleRoots;

    event FileRegistered(
        bytes32 indexed certificateId,
        bytes32 indexed fileHash,
        bytes32 metadataHash,
        address indexed issuer,
        uint256 registeredAt
    );
    event FileRevoked(
        bytes32 indexed certificateId,
        address indexed issuer,
        address indexed actor
    );
    event FileReplaced(
        bytes32 indexed previousCertificateId,
        bytes32 indexed newCertificateId,
        address indexed issuer,
        address newOwner
    );
    event FileRemoved(
        bytes32 indexed certificateId,
        address indexed issuer,
        address indexed actor
    );
    event FileOwnershipTransferred(
        bytes32 indexed previousCertificateId,
        bytes32 indexed newCertificateId,
        address indexed from,
        address to
    );
    event IssuerRoleGranted(address indexed issuer);
    event IssuerRoleRevoked(address indexed issuer);
    event MerkleRootRegistered(
        bytes32 indexed merkleRoot,
        uint256 leafCount,
        address indexed issuer
    );
    event ContractUpgraded(address indexed admin, uint256 version);

    error CertificateNotFound(bytes32 certificateId);
    error CertificateNotActive(bytes32 certificateId);
    error FileNotRegistered(bytes32 fileHash);
    error InvalidSignature(bytes32 certificateId);
    error SignatureExpired(uint256 deadline);
    error NonceAlreadyUsed(uint256 nonce);
    error AlreadyReplaced(bytes32 certificateId);
    error ArrayLengthMismatch(uint256 hashes, uint256 metadatas);
    error MerkleRootNotFound(bytes32 merkleRoot);
    error MerkleRootAlreadyRegistered(bytes32 merkleRoot);
    error InvalidMerkleProof(bytes32 merkleRoot, bytes32 leaf);
    error InvalidOwner(address owner);
    error NotIssuer(address sender);

    modifier onlyIssuer() {
        if (!hasRole(ISSUER_ROLE, msg.sender)) {
            revert NotIssuer(msg.sender);
        }
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the proxy implementation. Called once by the
    /// proxy deployment flow.
    function initialize(
        address admin,
        address initialIssuer
    ) external initializer {
        __AccessControl_init();
        __Pausable_init();
        __EIP712_init("Cornicular", "1");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        if (initialIssuer != address(0)) {
            _grantRole(ISSUER_ROLE, initialIssuer);
        }
        emit ContractUpgraded(admin, 1);
    }

    /// @notice Registers a single file standalone. Issuer is the caller,
    /// owner is the given account.
    function register(
        bytes32 fileHash,
        bytes32 metadataHash,
        address owner
    ) external whenNotPaused onlyIssuer returns (bytes32 certificateId) {
        if (owner == address(0)) {
            revert InvalidOwner(owner);
        }
        certificateId = _issueCertificate(
            fileHash,
            metadataHash,
            msg.sender,
            owner,
            bytes32(0),
            new bytes32[](0)
        );
    }

    /// @notice Registers several files in one transaction under the same
    /// owner.
    function registerBatch(
        bytes32[] calldata fileHashes,
        bytes32[] calldata metadataHashes,
        address owner
    )
        external
        whenNotPaused
        onlyIssuer
        returns (bytes32[] memory certificateIds)
    {
        if (owner == address(0)) {
            revert InvalidOwner(owner);
        }
        uint256 length = fileHashes.length;
        if (length != metadataHashes.length) {
            revert ArrayLengthMismatch(length, metadataHashes.length);
        }
        certificateIds = new bytes32[](length);
        for (uint256 i = 0; i < length; ++i) {
            certificateIds[i] = _issueCertificate(
                fileHashes[i],
                metadataHashes[i],
                msg.sender,
                owner,
                bytes32(0),
                new bytes32[](0)
            );
        }
    }

    /// @notice Registers a file from an off-chain signature. Issuer is
    /// the recovered signer, owner comes from the signed request.
    function registerWithSignature(
        RegisterRequest calldata request,
        bytes calldata signature
    ) external whenNotPaused returns (bytes32 certificateId) {
        if (request.owner == address(0)) {
            revert InvalidOwner(request.owner);
        }
        if (block.timestamp > request.deadline) {
            revert SignatureExpired(request.deadline);
        }
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    REGISTER_REQUEST_TYPEHASH,
                    request.fileHash,
                    request.metadataHash,
                    request.owner,
                    request.nonce,
                    request.deadline
                )
            )
        );
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(ISSUER_ROLE, signer)) {
            revert InvalidSignature(request.fileHash);
        }
        uint256 currentNonce = nonces[signer];
        if (request.nonce != currentNonce) {
            revert NonceAlreadyUsed(request.nonce);
        }
        nonces[signer] = currentNonce + 1;
        certificateId = _issueCertificate(
            request.fileHash,
            request.metadataHash,
            signer,
            request.owner,
            bytes32(0),
            new bytes32[](0)
        );
    }

    /// @notice Commits a Merkle root as an aggregated batch. Atomically
    /// stores the batch so members can later be issued certificates.
    function registerRoot(
        bytes32 merkleRoot,
        uint256 leafCount
    ) external whenNotPaused onlyIssuer {
        if (merkleRoots[merkleRoot].exists) {
            revert MerkleRootAlreadyRegistered(merkleRoot);
        }
        merkleRoots[merkleRoot] = MerkleRootRecord({
            issuer: msg.sender,
            leafCount: leafCount,
            registeredAt: block.timestamp,
            exists: true
        });
        emit MerkleRootRegistered(merkleRoot, leafCount, msg.sender);
    }

    /// @notice Issues a certificate for a file that is a verified member
    /// of a previously committed Merkle root. Issuer is the caller, owner
    /// is the given account.
    function registerIntoRoot(
        bytes32 fileHash,
        bytes32 metadataHash,
        bytes32 merkleRoot,
        bytes32[] calldata proof,
        address owner
    ) external whenNotPaused onlyIssuer returns (bytes32 certificateId) {
        if (owner == address(0)) {
            revert InvalidOwner(owner);
        }
        bytes32 leaf = _leaf(fileHash, metadataHash);
        if (!merkleRoots[merkleRoot].exists) {
            revert MerkleRootNotFound(merkleRoot);
        }
        if (!_verifyMerkleProof(merkleRoot, leaf, proof)) {
            revert InvalidMerkleProof(merkleRoot, leaf);
        }
        certificateId = _issueCertificate(
            fileHash,
            metadataHash,
            msg.sender,
            owner,
            merkleRoot,
            proof
        );
    }

    /// @notice Verifies a leaf is a member of a committed Merkle root.
    function verifyMember(
        bytes32 merkleRoot,
        bytes32 leaf,
        bytes32[] calldata proof
    ) external view returns (bool) {
        if (!merkleRoots[merkleRoot].exists) {
            return false;
        }
        return _verifyMerkleProof(merkleRoot, leaf, proof);
    }

    /// @notice Transfers certificate ownership to a new owner. The current
    /// certificate is replaced and a new version carrying the new owner is
    /// issued.
    function transferOwnership(
        bytes32 certificateId,
        address newOwner
    ) external whenNotPaused returns (bytes32 newCertificateId) {
        if (newOwner == address(0)) {
            revert InvalidOwner(newOwner);
        }
        Certificate storage certificate = certificates[certificateId];
        if (certificate.issuer == address(0)) {
            revert CertificateNotFound(certificateId);
        }
        _requireCertificateActor(certificate);
        if (certificate.status != Status.ACTIVE) {
            revert AlreadyReplaced(certificateId);
        }
        newCertificateId = _issueCertificate(
            certificate.fileHash,
            certificate.metadataHash,
            certificate.issuer,
            newOwner,
            certificate.parentMerkleRoot,
            certificate.merkleProof
        );
        certificate.status = Status.REPLACED;
        certificates[newCertificateId].previousVersionId = certificateId;
        emit FileOwnershipTransferred(certificateId, newCertificateId, certificate.owner, newOwner);
    }

    /// @notice Replaces file content with a new version. The current
    /// owner is preserved.
    function replace(
        bytes32 certificateId,
        bytes32 newFileHash,
        bytes32 newMetadataHash
    ) external whenNotPaused onlyIssuer returns (bytes32 newCertificateId) {
        Certificate storage certificate = certificates[certificateId];
        if (certificate.issuer == address(0)) {
            revert CertificateNotFound(certificateId);
        }
        if (certificate.status != Status.ACTIVE) {
            revert AlreadyReplaced(certificateId);
        }
        newCertificateId = _issueCertificate(
            newFileHash,
            newMetadataHash,
            msg.sender,
            certificate.owner,
            bytes32(0),
            new bytes32[](0)
        );
        certificate.status = Status.REPLACED;
        certificates[newCertificateId].previousVersionId = certificateId;
        emit FileReplaced(certificateId, newCertificateId, msg.sender, certificate.owner);
    }

    /// @notice Revokes a certificate, restricted to its owner, issuer, or
    /// admin. Any issuer can act on any certificate.
    function revoke(bytes32 certificateId) external whenNotPaused {
        Certificate storage certificate = certificates[certificateId];
        if (certificate.issuer == address(0)) {
            revert CertificateNotFound(certificateId);
        }
        _requireCertificateActor(certificate);
        if (certificate.status != Status.ACTIVE) {
            revert CertificateNotActive(certificateId);
        }
        certificate.status = Status.REVOKED;
        emit FileRevoked(certificateId, certificate.issuer, msg.sender);
    }

    /// @notice Marks a certificate removed.
    function remove(bytes32 certificateId) external whenNotPaused {
        Certificate storage certificate = certificates[certificateId];
        if (certificate.issuer == address(0)) {
            revert CertificateNotFound(certificateId);
        }
        _requireCertificateActor(certificate);
        if (certificate.status != Status.ACTIVE) {
            revert CertificateNotActive(certificateId);
        }
        certificate.status = Status.REMOVED;
        emit FileRemoved(certificateId, certificate.issuer, msg.sender);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Returns the full certificate for a given id, including its
    /// current owner and Merkle provenance.
    function getCertificate(
        bytes32 certificateId
    )
        external
        view
        returns (
            bytes32 fileHash,
            bytes32 metadataHash,
            address issuer,
            address owner,
            uint8 status,
            uint256 registeredAt,
            bytes32 previousVersionId,
            bytes32 parentMerkleRoot,
            bytes32[] memory merkleProof
        )
    {
        Certificate memory certificate = certificates[certificateId];
        if (certificate.issuer == address(0)) {
            revert CertificateNotFound(certificateId);
        }
        return (
            certificate.fileHash,
            certificate.metadataHash,
            certificate.issuer,
            certificate.owner,
            uint8(certificate.status),
            certificate.registeredAt,
            certificate.previousVersionId,
            certificate.parentMerkleRoot,
            certificate.merkleProof
        );
    }

    /// @notice Returns the latest certificate for a file hash to prove
    /// its current state.
    function prove(
        bytes32 fileHash
    )
        external
        view
        returns (
            bytes32 certificateId,
            bytes32 metadataHash,
            address issuer,
            address owner,
            uint8 status,
            uint256 registeredAt
        )
    {
        certificateId = latestCertificate[fileHash];
        if (certificateId == bytes32(0)) {
            revert FileNotRegistered(fileHash);
        }
        Certificate memory certificate = certificates[certificateId];
        return (
            certificateId,
            certificate.metadataHash,
            certificate.issuer,
            certificate.owner,
            uint8(certificate.status),
            certificate.registeredAt
        );
    }

    function getFileCertificates(
        bytes32 fileHash
    ) external view returns (bytes32[] memory) {
        return fileCertificates[fileHash];
    }

    function getNonce(address account) external view returns (uint256) {
        return nonces[account];
    }

    function isIssuer(address account) external view returns (bool) {
        return hasRole(ISSUER_ROLE, account);
    }

    function getMerkleRoot(
        bytes32 merkleRoot
    )
        external
        view
        returns (address issuer, uint256 leafCount, uint256 registeredAt)
    {
        MerkleRootRecord memory record = merkleRoots[merkleRoot];
        return (record.issuer, record.leafCount, record.registeredAt);
    }

    /// @notice Issues a certificate and updates all bookkeeping mappings.
    function _issueCertificate(
        bytes32 fileHash,
        bytes32 metadataHash,
        address issuer,
        address owner,
        bytes32 parentMerkleRoot,
        bytes32[] memory merkleProof
    ) internal returns (bytes32 certificateId) {
        certificateId = keccak256(
            abi.encodePacked(
                fileHash,
                metadataHash,
                issuer,
                block.timestamp,
                fileCertificates[fileHash].length
            )
        );
        certificates[certificateId] = Certificate({
            fileHash: fileHash,
            metadataHash: metadataHash,
            issuer: issuer,
            owner: owner,
            status: Status.ACTIVE,
            registeredAt: block.timestamp,
            previousVersionId: bytes32(0),
            parentMerkleRoot: parentMerkleRoot,
            merkleProof: merkleProof
        });
        fileCertificates[fileHash].push(certificateId);
        latestCertificate[fileHash] = certificateId;
        emit FileRegistered(
            certificateId,
            fileHash,
            metadataHash,
            issuer,
            block.timestamp
        );
    }

    function _requireCertificateActor(
        Certificate storage certificate
    ) internal view {
        if (
            certificate.owner != msg.sender &&
            !hasRole(ISSUER_ROLE, msg.sender) &&
            !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)
        ) {
            revert InvalidOwner(msg.sender);
        }
    }

    function _grantRole(
        bytes32 role,
        address account
    ) internal virtual override returns (bool) {
        bool result = super._grantRole(role, account);
        if (role == ISSUER_ROLE) {
            emit IssuerRoleGranted(account);
        }
        return result;
    }

    function _revokeRole(
        bytes32 role,
        address account
    ) internal virtual override returns (bool) {
        bool result = super._revokeRole(role, account);
        if (role == ISSUER_ROLE) {
            emit IssuerRoleRevoked(account);
        }
        return result;
    }

    function _leaf(
        bytes32 fileHash,
        bytes32 metadataHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(fileHash, metadataHash));
    }

    function _verifyMerkleProof(
        bytes32 merkleRoot,
        bytes32 leaf,
        bytes32[] memory proof
    ) internal pure returns (bool) {
        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 proofElement = proof[i];
            if (computedHash <= proofElement) {
                computedHash = keccak256(
                    abi.encodePacked(computedHash, proofElement)
                );
            } else {
                computedHash = keccak256(
                    abi.encodePacked(proofElement, computedHash)
                );
            }
        }
        return computedHash == merkleRoot;
    }

    /// @dev Reserved storage slots for future upgradeability.
    uint256[50] private __gap;
}
