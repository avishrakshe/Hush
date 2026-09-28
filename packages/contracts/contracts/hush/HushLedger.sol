// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {HushRegistry} from "./HushRegistry.sol";

/**
 * @title HushLedger
 * @notice Public commitments for hush-credit. Providers (or their facilitator) periodically commit the Merkle root
 *         of the vouchers they consumed; agents later prove their own vouchers were included.
 * @dev Deliberately stores ONLY roots: no voucher counts, no amounts, no per-agent data — any of those would leak
 *      call frequency or spend. Facilitators commit on a fixed cadence (padding empty batches with a dummy leaf) so
 *      even commit timing says nothing about activity.
 *
 *      This contract is also the EIP-712 `verifyingContract` for Hush vouchers and credit receipts
 *      (domain {name:"Hush", version:"1", chainId, verifyingContract: this}), which stops a voucher signed for one
 *      deployment or chain from being replayed against another.
 */
contract HushLedger is EIP712 {
    /// @notice Signed by the agent for every paid call. `cumulativeSpent` is a running total (USDC atomic units), so
    ///         a newer voucher supersedes older ones — the same model as x402's batch-settlement scheme.
    struct Voucher {
        address agent;
        address provider;
        uint256 cumulativeSpent;
        uint64 nonce;
        bytes32 requestHash;
        uint64 expiry;
    }

    /// @notice Signed by the provider after it decrypts a private top-up and credits the agent.
    struct CreditReceipt {
        address agent;
        address provider;
        uint256 creditedTotal;
        bytes32 topupTxHash;
        uint64 issuedAt;
    }

    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256(
            "Voucher(address agent,address provider,uint256 cumulativeSpent,uint64 nonce,bytes32 requestHash,uint64 expiry)"
        );
    bytes32 public constant CREDIT_RECEIPT_TYPEHASH =
        keccak256(
            "CreditReceipt(address agent,address provider,uint256 creditedTotal,bytes32 topupTxHash,uint64 issuedAt)"
        );

    HushRegistry public immutable registry;

    mapping(address provider => mapping(uint256 batchId => bytes32 root)) private _roots;
    /// @notice Highest committed batchId per provider (0 = none yet, so the first batchId must be >= 1).
    mapping(address provider => uint256) public latestBatchId;

    event BatchCommitted(address indexed provider, uint256 indexed batchId, bytes32 merkleRoot, address committer);

    error NotAuthorized();
    error EmptyRoot();
    error NonIncreasingBatchId(uint256 batchId, uint256 latest);

    constructor(HushRegistry registry_) EIP712("Hush", "1") {
        registry = registry_;
    }

    /// @notice Commit the Merkle root of a voucher batch. Only the provider or its registered facilitator.
    /// @dev batchIds must strictly increase per provider (gaps allowed) so a committed batch can never be rewritten.
    function commitBatch(address provider, uint256 batchId, bytes32 merkleRoot) external {
        if (!registry.isAuthorizedCommitter(provider, msg.sender)) revert NotAuthorized();
        if (merkleRoot == bytes32(0)) revert EmptyRoot();
        uint256 latest = latestBatchId[provider];
        if (batchId <= latest) revert NonIncreasingBatchId(batchId, latest);

        latestBatchId[provider] = batchId;
        _roots[provider][batchId] = merkleRoot;
        emit BatchCommitted(provider, batchId, merkleRoot, msg.sender);
    }

    function getRoot(address provider, uint256 batchId) external view returns (bytes32) {
        return _roots[provider][batchId];
    }

    /// @notice True if `leaf` is in the batch `batchId` committed for `provider`.
    /// @dev Takes a raw leaf hash, so it cannot tell a leaf from an internal node. Callers must derive `leaf` from
    ///      a voucher with `voucherLeaf` — or use `verifyVoucherInclusion`, which does that on-chain.
    function verifyInclusion(
        address provider,
        uint256 batchId,
        bytes32 leaf,
        bytes32[] calldata proof
    ) public view returns (bool) {
        bytes32 root = _roots[provider][batchId];
        if (root == bytes32(0)) return false;
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }

    /// @notice Safe variant: proves a specific signed voucher was included in a batch for its provider.
    function verifyVoucherInclusion(
        uint256 batchId,
        Voucher calldata v,
        bytes calldata signature,
        bytes32[] calldata proof
    ) external view returns (bool) {
        return verifyInclusion(v.provider, batchId, voucherLeaf(v, signature), proof);
    }

    // ─────────────────── Hashing helpers (single source of truth for the SDK) ───────────────────

    /// @notice Merkle leaf for a signed voucher, identical to OZ StandardMerkleTree with types
    ///         [address,address,uint256,uint64,bytes32,uint64,bytes].
    /// @dev The double keccak is the StandardMerkleTree convention: a leaf preimage (a hash, 32 bytes) can never be
    ///      64 bytes, so nobody can craft voucher data whose leaf equals an internal node (second-preimage protection).
    function voucherLeaf(Voucher calldata v, bytes calldata signature) public pure returns (bytes32) {
        return
            keccak256(
                bytes.concat(
                    keccak256(abi.encode(v.agent, v.provider, v.cumulativeSpent, v.nonce, v.requestHash, v.expiry, signature))
                )
            );
    }

    function hashVoucher(Voucher calldata v) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(VOUCHER_TYPEHASH, v.agent, v.provider, v.cumulativeSpent, v.nonce, v.requestHash, v.expiry)
                )
            );
    }

    function hashCreditReceipt(CreditReceipt calldata r) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(CREDIT_RECEIPT_TYPEHASH, r.agent, r.provider, r.creditedTotal, r.topupTxHash, r.issuedAt)
                )
            );
    }

    /// @notice Voucher must be signed by its agent (EOA or ERC-1271).
    function isValidVoucherSignature(Voucher calldata v, bytes calldata signature) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(v.agent, hashVoucher(v), signature);
    }

    /// @notice Receipt must be signed by its provider — this is what makes a provider accountable for a top-up.
    function isValidCreditReceiptSignature(
        CreditReceipt calldata r,
        bytes calldata signature
    ) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(r.provider, hashCreditReceipt(r), signature);
    }
}
