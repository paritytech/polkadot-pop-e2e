// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

/// @notice IPersonhood precompile interface (subset).
/// Full source: paritytech/individuality/precompiles/personhood/sol/IPersonhood.sol
interface IPersonhood {
    struct PersonhoodInfo {
        uint8 status;     // 0 = None, 1 = Lite, 2 = Full
        bytes32 contextAlias;
    }

    /// @notice Inputs to `personhoodInfoByProof`.
    /// @dev SECURITY: the precompile does NOT bind the proof to `msg.sender`.
    ///      The calling contract MUST embed the caller into `message` at
    ///      proof-generation time, else anyone holding the proof + calldata
    ///      can replay it. We bind `keccak256(msg.sender, nonce)` below.
    struct ProofVerificationRequest {
        uint8 expectedStatus; // 1 = Lite, 2 = Full
        bytes proof;          // SCALE-encoded ring-VRF proof
        bytes32 expectedAlias;
        uint32 ringIndex;
        bytes32 context;
        uint32 revision;
        bytes message;
    }

    function personhoodStatus(address account, bytes32 context)
        external view returns (PersonhoodInfo memory);

    function personhoodInfoByProof(ProofVerificationRequest calldata request)
        external view returns (bool ok);
}

/// @title PopCounter
/// @notice Per-person counter gated on proof of personhood for this contract's
/// fixed `CTX`. Demonstrates BOTH ways to consume the IPersonhood precompile:
///
///   - `bump()` — the *stateful* path. Reads the stored alias mapping the
///     person registered once via `AliasAccounts.set_paid_alias_account`.
///     Cheap per call (a storage read); amortises a one-time registration.
///
///   - `bumpByProof(...)` — the *stateless* path. The caller supplies a fresh
///     ring-VRF proof inline; the precompile verifies it on the fly. No prior
///     registration, but the ring verification is paid on every call.
///
/// Both keep the caller pseudonymous via the contextual alias and remain
/// Sybil-resistant: the alias is deterministic in (person, context), so the
/// same human collapses to one alias regardless of which account calls.
contract PopCounter {
    IPersonhood constant POP = IPersonhood(0x000000000000000000000000000000000a010000);
    bytes32 constant CTX = bytes32("triangle-e2e:pop-counter");
    uint8 constant LITE = 1;

    uint256 public totalBumps;
    /// @notice Per-person bump count via the stored-alias path, keyed by alias.
    mapping(bytes32 => uint256) public byAlias;

    uint256 public totalBumpsByProof;
    /// @notice Per-person bump count via the by-proof path, keyed by alias.
    mapping(bytes32 => uint256) public byAliasByProof;
    /// @notice Per-caller nonce — bound into each proof's message so a proof
    /// can't be replayed by the same caller, and advances on every accepted
    /// bump. Read this to know which nonce the next proof must bind.
    mapping(address => uint256) public proofNonce;

    error NotPerson();
    error BadProof();

    /// @notice Stateful gate — requires a registered alias for CTX.
    function bump() external {
        IPersonhood.PersonhoodInfo memory info = POP.personhoodStatus(msg.sender, CTX);
        if (info.status < LITE) revert NotPerson();
        totalBumps += 1;
        byAlias[info.contextAlias] += 1;
    }

    /// @notice The message a proof for the CALLER's next bump must bind.
    /// Off-chain proof generation reads this (via an `eth_call` from the same
    /// origin) and uses exactly these 32 bytes as the ring-VRF `message` — so
    /// no client-side address-mapping math is needed.
    function expectedMessage() public view returns (bytes32) {
        return keccak256(abi.encodePacked(msg.sender, proofNonce[msg.sender]));
    }

    /// @notice Stateless gate — verifies a fresh ring-VRF proof inline, no
    /// registration required. The proof must derive `expectedAlias` in CTX
    /// over `expectedMessage(msg.sender)` against ring `(ringIndex, revision)`.
    function bumpByProof(
        bytes calldata proof,
        bytes32 expectedAlias,
        uint32 ringIndex,
        uint32 revision
    ) external {
        bytes memory message = abi.encodePacked(expectedMessage());
        IPersonhood.ProofVerificationRequest memory req = IPersonhood.ProofVerificationRequest({
            expectedStatus: LITE,
            proof: proof,
            expectedAlias: expectedAlias,
            ringIndex: ringIndex,
            context: CTX,
            revision: revision,
            message: message
        });
        if (!POP.personhoodInfoByProof(req)) revert BadProof();
        proofNonce[msg.sender] += 1;
        totalBumpsByProof += 1;
        byAliasByProof[expectedAlias] += 1;
    }
}
