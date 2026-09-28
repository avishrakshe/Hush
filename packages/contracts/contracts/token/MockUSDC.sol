// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title MockUSDC
 * @notice Testnet stand-in for USDC: 6 decimals, an open faucet, EIP-2612 permits and EIP-3009 transfer
 *         authorizations.
 * @dev Why EIP-3009: x402's `exact` EVM scheme settles by having the facilitator submit the payer's signed
 *      `transferWithAuthorization`, so the public baseline (agent "Atlas") needs it. Circle's Fuji USDC supports it
 *      too; this mock exists so demos never depend on faucet limits. Both `transferWithAuthorization` overloads
 *      (v/r/s and bytes) are implemented because the x402 EVM facilitator picks one based on signature length.
 */
contract MockUSDC is ERC20, ERC20Permit {
    // Same typehashes as Circle's FiatTokenV2 so standard EIP-3009 tooling works unchanged.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    /// @notice Max amount a single faucet call can mint (10,000 USDC).
    uint256 public constant FAUCET_LIMIT = 10_000 * 1e6;

    mapping(address authorizer => mapping(bytes32 nonce => bool used)) private _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error FaucetLimitExceeded(uint256 requested, uint256 limit);
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationUsedOrCanceled();
    error InvalidSignature();
    error CallerMustBePayee();

    constructor() ERC20("Hush Test USDC", "USDC") ERC20Permit("Hush Test USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice EIP-712 domain version. x402 clients read it (with `name()`) to build the EIP-3009 domain.
    function version() external pure returns (string memory) {
        return "1"; // must match the version ERC20Permit passes to EIP712
    }

    /// @notice Open faucet — anyone can mint up to FAUCET_LIMIT per call. Testnet only.
    function mint(address to, uint256 amount) external {
        if (amount > FAUCET_LIMIT) revert FaucetLimitExceeded(amount, FAUCET_LIMIT);
        _mint(to, amount);
    }

    // ───────────────────────────── EIP-3009 ─────────────────────────────

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _authorizedTransfer(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, _packSig(v, r, s)
        );
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _authorizedTransfer(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
    }

    /// @dev receiveWithAuthorization binds the call to the payee, preventing front-running of the authorization.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _authorizedTransfer(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, _packSig(v, r, s)
        );
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _authorizedTransfer(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        _cancelAuthorization(authorizer, nonce, _packSig(v, r, s));
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external {
        _cancelAuthorization(authorizer, nonce, signature);
    }

    function _authorizedTransfer(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationUsedOrCanceled();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce)));
        // SignatureChecker covers EOAs and ERC-1271 smart accounts.
        if (!SignatureChecker.isValidSignatureNow(from, digest, signature)) revert InvalidSignature();

        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) internal {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationUsedOrCanceled();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        if (!SignatureChecker.isValidSignatureNow(authorizer, digest, signature)) revert InvalidSignature();
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /// @dev Some signers report yParity (0/1) instead of v (27/28); OZ ECDSA only accepts the latter.
    function _packSig(uint8 v, bytes32 r, bytes32 s) internal pure returns (bytes memory) {
        return abi.encodePacked(r, s, v < 27 ? v + 27 : v);
    }
}
