// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IRegistrar} from "../eerc/interfaces/IRegistrar.sol";

/// @dev Test double for the eERC Registrar: lets unit tests set public keys without generating registration proofs.
contract MockEERCRegistrar is IRegistrar {
    mapping(address user => uint256[2] key) private _keys;

    function setUserPublicKey(address user, uint256[2] calldata publicKey) external {
        _keys[user] = publicKey;
    }

    function getUserPublicKey(address user) external view returns (uint256[2] memory) {
        return _keys[user];
    }

    function isUserRegistered(address user) external view returns (bool) {
        return _keys[user][0] != 0 && _keys[user][1] != 0;
    }
}
