// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title HushAlpha
 * @notice Hush v2 — "private by default, provable on demand". Two jobs:
 *   1. The EIP-712 domain {name:"HushAlpha", version:"1"} for the Hush Desk's quotes, fill receipts and position
 *      statements, and for signal providers' signal records — with hash + signature views, so any signed record can be
 *      checked on-chain (e.g. as evidence when flagging a desk that didn't honour a fill).
 *   2. Chain heads: a subject (signal provider or agent) commits one hash per epoch for the epoch that just closed. Each
 *      head chains every earlier epoch, so a track record revealed later can be checked against these heads — records
 *      can't be added, dropped or back-dated after the fact.
 * @dev Stores hashes only: no counts, tickers or amounts. Subjects commit every epoch (heartbeats when idle) so commit
 *      timing says nothing about activity. HushLedger/HushRegistry are untouched; this is a separate deployment.
 */
contract HushAlpha is EIP712 {
    /// @notice Desk-signed price for one trade. side: 1 = buy, 2 = sell. size in 0.01-share units; price in USDC atomic
    ///         per share; notional = size * price / 100 (USDC atomic). Valid until `expiry` (unix seconds).
    struct Quote {
        bytes32 quoteId;
        address desk;
        address agent;
        bytes32 ticker;
        uint8 side;
        uint64 size;
        uint256 price;
        uint256 notional;
        uint64 expiry;
    }

    /// @notice Desk-signed proof that a quote was filled.
    struct FillReceipt {
        bytes32 quoteId;
        address desk;
        address agent;
        bytes32 ticker;
        uint8 side;
        uint64 size;
        uint256 price;
        uint64 filledAt;
    }

    /// @notice Desk-signed custody statement: what the desk holds for `agent` in `ticker` after the change numbered `seq`
    ///         (seq strictly increases per agent across all tickers, so a missing statement shows as a gap).
    struct PositionStatement {
        address desk;
        address agent;
        bytes32 ticker;
        uint64 position;
        uint256 avgCost;
        uint64 seq;
        uint64 issuedAt;
    }

    /// @notice Provider-signed signal. direction: 0 = flat (no call), 1 = up, 2 = down. Graded against the stock oracle
    ///         at issuedAt + horizonSec.
    struct SignalRecord {
        address provider;
        bytes32 ticker;
        uint8 direction;
        uint16 confidenceBps;
        uint256 price;
        uint64 issuedAt;
        uint64 horizonSec;
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 quoteId,address desk,address agent,bytes32 ticker,uint8 side,uint64 size,uint256 price,uint256 notional,uint64 expiry)"
    );
    bytes32 public constant FILL_RECEIPT_TYPEHASH = keccak256(
        "FillReceipt(bytes32 quoteId,address desk,address agent,bytes32 ticker,uint8 side,uint64 size,uint256 price,uint64 filledAt)"
    );
    bytes32 public constant POSITION_STATEMENT_TYPEHASH = keccak256(
        "PositionStatement(address desk,address agent,bytes32 ticker,uint64 position,uint256 avgCost,uint64 seq,uint64 issuedAt)"
    );
    bytes32 public constant SIGNAL_RECORD_TYPEHASH = keccak256(
        "SignalRecord(address provider,bytes32 ticker,uint8 direction,uint16 confidenceBps,uint256 price,uint64 issuedAt,uint64 horizonSec)"
    );

    /// @notice Epoch length in seconds (600 on Fuji; shorter on local chains so demos don't wait 20 minutes).
    uint256 public immutable epochLen;

    mapping(address subject => mapping(uint256 epoch => bytes32 head)) private _heads;
    /// @notice First and latest committed epoch per subject (both 0 until the first commit).
    mapping(address subject => uint256) public firstEpoch;
    mapping(address subject => uint256) public latestEpoch;
    /// @notice Optional key allowed to commit for a subject (e.g. a provider's always-on job). address(0) = none.
    mapping(address subject => address) public committerOf;

    event CommitterSet(address indexed subject, address indexed committer);
    event ChainHeadCommitted(address indexed subject, uint256 indexed epoch, bytes32 head, address committer);

    error ZeroEpochLen();
    error NotAuthorized();
    error EmptyHead();
    error WrongEpoch(uint256 epoch, uint256 expected);
    error AlreadyCommitted(uint256 epoch);

    constructor(uint256 epochLen_) EIP712("HushAlpha", "1") {
        if (epochLen_ == 0) revert ZeroEpochLen();
        epochLen = epochLen_;
    }

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / epochLen;
    }

    /// @notice Authorise `committer` to commit chain heads for msg.sender. address(0) revokes.
    function setCommitter(address committer) external {
        committerOf[msg.sender] = committer;
        emit CommitterSet(msg.sender, committer);
    }

    /**
     * @notice Commit the head of `subject`'s record chain for `epoch`.
     * @dev Only the epoch that just closed is accepted. Its records are final, and once the next epoch begins nobody can
     *      write a head for it any more — so a record can be bound at most ~2 epochs after it was issued and never
     *      back-dated. (Accepting the *current* epoch would leave out records issued after the commit within it.)
     */
    function commitChainHead(address subject, uint256 epoch, bytes32 head) external {
        if (msg.sender != subject && (committerOf[subject] == address(0) || msg.sender != committerOf[subject])) {
            revert NotAuthorized();
        }
        if (head == bytes32(0)) revert EmptyHead();
        uint256 closed = currentEpoch() - 1;
        if (epoch != closed) revert WrongEpoch(epoch, closed);
        if (_heads[subject][epoch] != bytes32(0)) revert AlreadyCommitted(epoch);

        _heads[subject][epoch] = head;
        if (firstEpoch[subject] == 0) firstEpoch[subject] = epoch;
        latestEpoch[subject] = epoch;
        emit ChainHeadCommitted(subject, epoch, head, msg.sender);
    }

    function getChainHead(address subject, uint256 epoch) external view returns (bytes32) {
        return _heads[subject][epoch];
    }

    // ─────────────────── EIP-712 hashing (single source of truth for the SDK) ───────────────────

    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(QUOTE_TYPEHASH, q.quoteId, q.desk, q.agent, q.ticker, q.side, q.size, q.price, q.notional, q.expiry))
        );
    }

    function hashFillReceipt(FillReceipt calldata f) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(FILL_RECEIPT_TYPEHASH, f.quoteId, f.desk, f.agent, f.ticker, f.side, f.size, f.price, f.filledAt))
        );
    }

    function hashPositionStatement(PositionStatement calldata s) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(POSITION_STATEMENT_TYPEHASH, s.desk, s.agent, s.ticker, s.position, s.avgCost, s.seq, s.issuedAt))
        );
    }

    function hashSignalRecord(SignalRecord calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(SIGNAL_RECORD_TYPEHASH, r.provider, r.ticker, r.direction, r.confidenceBps, r.price, r.issuedAt, r.horizonSec)
            )
        );
    }

    /// @notice Quotes, fills and statements are only binding when signed by the desk they name (EOA or ERC-1271).
    function isValidQuoteSignature(Quote calldata q, bytes calldata signature) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(q.desk, hashQuote(q), signature);
    }

    function isValidFillReceiptSignature(FillReceipt calldata f, bytes calldata signature) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(f.desk, hashFillReceipt(f), signature);
    }

    function isValidPositionStatementSignature(PositionStatement calldata s, bytes calldata signature) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(s.desk, hashPositionStatement(s), signature);
    }

    function isValidSignalRecordSignature(SignalRecord calldata r, bytes calldata signature) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(r.provider, hashSignalRecord(r), signature);
    }
}
