// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IRegistrar} from "../eerc/interfaces/IRegistrar.sol";

/**
 * @title HushRegistry
 * @notice Public directory for Hush: paid-API providers, AI agents and their owners, the owner kill switch, and a
 *         public provider-flagging signal. Nothing here reveals payment amounts or call frequency.
 */
contract HushRegistry is EIP712 {
    struct Provider {
        string name;
        string endpoint;
        /// @dev Price per call in USDC atomic units (6 decimals). Public list price, not a record of payments.
        uint256 pricePerCall;
        /// @dev abi.encode(uint256 x, uint256 y): the BabyJubJub key that receives encrypted top-ups.
        bytes eercPublicKey;
        /// @dev Optional operator allowed to commit voucher batches on the provider's behalf.
        address facilitator;
        uint64 registeredAt;
        uint32 flagCount;
    }

    struct Agent {
        address owner;
        string metadataURI;
        bool frozen;
        uint64 registeredAt;
    }

    /// @dev The agent signs this to accept `owner`. Without it anyone could claim an agent address and use the kill
    ///      switch to freeze it (a griefing DoS), because facilitators refuse calls from frozen agents.
    bytes32 public constant AGENT_CONSENT_TYPEHASH =
        keccak256("AgentConsent(address agent,address owner,uint256 deadline)");

    /// @notice eERC Registrar used to cross-check provider keys. address(0) disables the check (e.g. a mainnet
    ///         deployment of the registry without eERC).
    IRegistrar public immutable eercRegistrar;

    mapping(address provider => Provider) private _providers;
    mapping(address agent => Agent) private _agents;
    mapping(address owner => address[]) private _agentsByOwner;
    mapping(bytes32 flagKey => bool) private _flagged;
    address[] private _providerList;

    event ProviderRegistered(
        address indexed provider, string name, string endpoint, uint256 pricePerCall, bytes eercPublicKey
    );
    event ProviderUpdated(address indexed provider, string endpoint, uint256 pricePerCall);
    event FacilitatorSet(address indexed provider, address indexed facilitator);
    event AgentRegistered(address indexed agent, address indexed owner, string metadataURI);
    event AgentFrozen(address indexed agent, address indexed owner);
    event AgentUnfrozen(address indexed agent, address indexed owner);
    event ProviderFlagged(address indexed provider, address indexed flagger, bytes32 indexed evidenceHash, uint32 flagCount);

    error AlreadyRegistered();
    error NotRegistered();
    error NotAgentOwner();
    error InvalidPublicKey();
    error EercKeyMismatch();
    error ConsentExpired();
    error InvalidConsent();
    error AlreadyFlagged();
    error EmptyEvidence();
    error EmptyName();

    constructor(address eercRegistrar_) EIP712("HushRegistry", "1") {
        eercRegistrar = IRegistrar(eercRegistrar_);
    }

    // ───────────────────────────── Providers ─────────────────────────────

    function registerProvider(
        string calldata name,
        string calldata endpoint,
        uint256 pricePerCall,
        bytes calldata eercPublicKey
    ) external {
        if (_providers[msg.sender].registeredAt != 0) revert AlreadyRegistered();
        if (bytes(name).length == 0) revert EmptyName();
        if (eercPublicKey.length != 64) revert InvalidPublicKey();

        // Top-ups can only reach a provider that is registered in eERC, and the advertised key must be the one eERC
        // encrypts to — otherwise agents would be told to trust a key nobody can decrypt with.
        if (address(eercRegistrar) != address(0)) {
            if (!eercRegistrar.isUserRegistered(msg.sender)) revert NotRegistered();
            (uint256 x, uint256 y) = abi.decode(eercPublicKey, (uint256, uint256));
            uint256[2] memory registered = eercRegistrar.getUserPublicKey(msg.sender);
            if (registered[0] != x || registered[1] != y) revert EercKeyMismatch();
        }

        Provider storage p = _providers[msg.sender];
        p.name = name;
        p.endpoint = endpoint;
        p.pricePerCall = pricePerCall;
        p.eercPublicKey = eercPublicKey;
        p.registeredAt = uint64(block.timestamp);
        _providerList.push(msg.sender);

        emit ProviderRegistered(msg.sender, name, endpoint, pricePerCall, eercPublicKey);
    }

    function updateProvider(string calldata endpoint, uint256 pricePerCall) external {
        Provider storage p = _requireProvider(msg.sender);
        p.endpoint = endpoint;
        p.pricePerCall = pricePerCall;
        emit ProviderUpdated(msg.sender, endpoint, pricePerCall);
    }

    /// @notice Authorize an operator (e.g. the provider's facilitator service) to commit batches. address(0) revokes.
    function setFacilitator(address facilitator) external {
        _requireProvider(msg.sender).facilitator = facilitator;
        emit FacilitatorSet(msg.sender, facilitator);
    }

    /// @notice Public reputation signal. One flag per (flagger, provider, evidenceHash); the evidence itself (e.g. a
    ///         signed CreditReceipt the provider failed to honour) lives off-chain and is referenced by hash.
    function flagProvider(address provider, bytes32 evidenceHash) external {
        Provider storage p = _requireProvider(provider);
        if (evidenceHash == bytes32(0)) revert EmptyEvidence();
        bytes32 key = keccak256(abi.encode(msg.sender, provider, evidenceHash));
        if (_flagged[key]) revert AlreadyFlagged();
        _flagged[key] = true;
        uint32 count = ++p.flagCount;
        emit ProviderFlagged(provider, msg.sender, evidenceHash, count);
    }

    // ───────────────────────────── Agents ─────────────────────────────

    /**
     * @notice Register `agent` with msg.sender as its owner.
     * @param agentSignature EIP-712 AgentConsent signed by `agent` (EOA or ERC-1271). Not needed when the agent
     *        registers itself (msg.sender == agent).
     */
    function registerAgent(
        address agent,
        string calldata metadataURI,
        uint256 deadline,
        bytes calldata agentSignature
    ) external {
        if (_agents[agent].registeredAt != 0) revert AlreadyRegistered();
        if (agent != msg.sender) {
            if (block.timestamp > deadline) revert ConsentExpired();
            bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(AGENT_CONSENT_TYPEHASH, agent, msg.sender, deadline)));
            if (!SignatureChecker.isValidSignatureNow(agent, digest, agentSignature)) revert InvalidConsent();
        }

        _agents[agent] = Agent({
            owner: msg.sender,
            metadataURI: metadataURI,
            frozen: false,
            registeredAt: uint64(block.timestamp)
        });
        _agentsByOwner[msg.sender].push(agent);
        emit AgentRegistered(agent, msg.sender, metadataURI);
    }

    /// @notice Kill switch: facilitators reject every payment from a frozen agent.
    function freezeAgent(address agent) external {
        _requireAgentOwner(agent).frozen = true;
        emit AgentFrozen(agent, msg.sender);
    }

    function unfreezeAgent(address agent) external {
        _requireAgentOwner(agent).frozen = false;
        emit AgentUnfrozen(agent, msg.sender);
    }

    // ───────────────────────────── Views ─────────────────────────────

    function isFrozen(address agent) external view returns (bool) {
        return _agents[agent].frozen;
    }

    function isProvider(address provider) public view returns (bool) {
        return _providers[provider].registeredAt != 0;
    }

    function isAgent(address agent) external view returns (bool) {
        return _agents[agent].registeredAt != 0;
    }

    /// @notice True if `account` may commit voucher batches for `provider` (the provider or its facilitator).
    function isAuthorizedCommitter(address provider, address account) external view returns (bool) {
        Provider storage p = _providers[provider];
        if (p.registeredAt == 0) return false;
        return account == provider || (p.facilitator != address(0) && account == p.facilitator);
    }

    function getProvider(address provider) external view returns (Provider memory) {
        return _providers[provider];
    }

    function getAgent(address agent) external view returns (Agent memory) {
        return _agents[agent];
    }

    function getProviders() external view returns (address[] memory) {
        return _providerList;
    }

    function getAgentsByOwner(address owner) external view returns (address[] memory) {
        return _agentsByOwner[owner];
    }

    function hasFlagged(address flagger, address provider, bytes32 evidenceHash) external view returns (bool) {
        return _flagged[keccak256(abi.encode(flagger, provider, evidenceHash))];
    }

    /// @notice EIP-712 digest an agent signs to consent to `owner` (exposed for clients and tests).
    function agentConsentDigest(address agent, address owner, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(AGENT_CONSENT_TYPEHASH, agent, owner, deadline)));
    }

    // ───────────────────────────── Internal ─────────────────────────────

    function _requireProvider(address provider) internal view returns (Provider storage p) {
        p = _providers[provider];
        if (p.registeredAt == 0) revert NotRegistered();
    }

    function _requireAgentOwner(address agent) internal view returns (Agent storage a) {
        a = _agents[agent];
        if (a.registeredAt == 0) revert NotRegistered();
        if (a.owner != msg.sender) revert NotAgentOwner();
    }
}
