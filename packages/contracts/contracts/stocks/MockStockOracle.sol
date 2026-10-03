// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockStockOracle
 * @notice Public price history for the mock stocks. The desk quotes against it, signal providers read it, and Proof of
 *         Alpha grades every signal and trade against `getPriceAt` — so the full round history is kept on-chain.
 * @dev Prices are USDC atomic units (6 decimals) per whole share. Rounds are stamped with `block.timestamp`, never a
 *      caller-supplied time: a back-dated round would let whoever posts prices rewrite the history track records are
 *      graded against. Market prices are public data; nothing here concerns any agent.
 */
contract MockStockOracle is Ownable {
    struct Round {
        uint64 timestamp;
        uint192 price;
    }

    uint8 public constant DECIMALS = 6;

    mapping(bytes32 ticker => Round[]) private _rounds;
    mapping(address account => bool) public isUpdater;
    bytes32[] private _tickers;

    event UpdaterSet(address indexed updater, bool allowed);
    event PriceUpdated(bytes32 indexed ticker, uint256 indexed roundId, uint256 price, uint256 timestamp);

    error NotUpdater();
    error LengthMismatch();
    error ZeroPrice(bytes32 ticker);
    error PriceTooLarge(bytes32 ticker);
    error RoundNotNewer(bytes32 ticker);
    error NoPrice(bytes32 ticker, uint256 timestamp);
    error UnknownRound(bytes32 ticker, uint256 roundId);

    constructor() Ownable(msg.sender) {}

    /// @notice Allow or revoke a price updater (e.g. the price bot). The owner can always post.
    function setUpdater(address updater, bool allowed) external onlyOwner {
        isUpdater[updater] = allowed;
        emit UpdaterSet(updater, allowed);
    }

    /// @notice Post one new round per ticker, all stamped with the current block time. One tx per tick for every ticker.
    function postPrices(bytes32[] calldata tickers, uint256[] calldata prices) external {
        if (!isUpdater[msg.sender] && msg.sender != owner()) revert NotUpdater();
        if (tickers.length != prices.length) revert LengthMismatch();

        for (uint256 i = 0; i < tickers.length; i++) {
            bytes32 t = tickers[i];
            uint256 price = prices[i];
            if (price == 0) revert ZeroPrice(t);
            if (price > type(uint192).max) revert PriceTooLarge(t);

            Round[] storage rounds = _rounds[t];
            if (rounds.length == 0) {
                _tickers.push(t);
            } else if (rounds[rounds.length - 1].timestamp >= block.timestamp) {
                // Strictly increasing timestamps keep getPriceAt unambiguous (also rejects a ticker twice in one call).
                revert RoundNotNewer(t);
            }
            rounds.push(Round({timestamp: uint64(block.timestamp), price: uint192(price)}));
            emit PriceUpdated(t, rounds.length - 1, price, block.timestamp);
        }
    }

    /// @notice Price in force at `timestamp`: the latest round stamped at or before it. Reverts if there is none yet.
    function getPriceAt(bytes32 ticker, uint256 timestamp)
        external
        view
        returns (uint256 price, uint256 roundTimestamp, uint256 roundId)
    {
        Round[] storage rounds = _rounds[ticker];
        uint256 n = rounds.length;
        if (n == 0 || rounds[0].timestamp > timestamp) revert NoPrice(ticker, timestamp);

        // Binary search for the last round with timestamp <= `timestamp` (rounds are strictly increasing).
        uint256 lo = 0;
        uint256 hi = n - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (rounds[mid].timestamp <= timestamp) lo = mid;
            else hi = mid - 1;
        }
        Round storage r = rounds[lo];
        return (r.price, r.timestamp, lo);
    }

    function latestPrice(bytes32 ticker) external view returns (uint256 price, uint256 timestamp, uint256 roundId) {
        uint256 n = _rounds[ticker].length;
        if (n == 0) revert NoPrice(ticker, block.timestamp);
        Round storage r = _rounds[ticker][n - 1];
        return (r.price, r.timestamp, n - 1);
    }

    function getRound(bytes32 ticker, uint256 roundId) external view returns (uint256 price, uint256 timestamp) {
        if (roundId >= _rounds[ticker].length) revert UnknownRound(ticker, roundId);
        Round storage r = _rounds[ticker][roundId];
        return (r.price, r.timestamp);
    }

    function roundCount(bytes32 ticker) external view returns (uint256) {
        return _rounds[ticker].length;
    }

    function getTickers() external view returns (bytes32[] memory) {
        return _tickers;
    }
}
