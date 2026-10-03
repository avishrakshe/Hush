// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockStock
 * @notice Testnet stand-in for a tokenized US equity (mNVDA, mTSLA, mSPY). 18 decimals like issuer stock tokens.
 *         Not affiliated with, backed by, or redeemable for anything — real tokenized stocks are mainnet + KYC-gated.
 * @dev The public faucet is capped per address for life (not per call, unlike MockUSDC) so "how much stock an agent
 *      holds" stays a meaningful secret in the demo; the owner mints the desk's inventory. eERC wraps it with 2
 *      decimals, so the smallest private unit is 0.01 share (deposits are scaled by 1e16, dust returned).
 */
contract MockStock is ERC20, Ownable {
    /// @notice Ticker the oracle quotes this token under, e.g. bytes32("NVDA").
    bytes32 public immutable ticker;
    /// @notice Lifetime faucet allowance per address (18-decimal share units).
    uint256 public immutable faucetCap;

    mapping(address account => uint256 minted) public faucetMinted;

    error FaucetCapExceeded(uint256 requested, uint256 remaining);

    constructor(string memory name_, string memory symbol_, bytes32 ticker_, uint256 faucetCap_)
        ERC20(name_, symbol_)
        Ownable(msg.sender)
    {
        ticker = ticker_;
        faucetCap = faucetCap_;
    }

    /// @notice Mint demo shares to the caller, up to `faucetCap` per address in total.
    function faucet(uint256 amount) external {
        uint256 minted = faucetMinted[msg.sender];
        if (minted + amount > faucetCap) revert FaucetCapExceeded(amount, faucetCap - minted);
        faucetMinted[msg.sender] = minted + amount;
        _mint(msg.sender, amount);
    }

    /// @notice Inventory for the desk (market maker). Owner only; not counted against any faucet cap.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
