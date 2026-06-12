// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

/// @notice IPersonhood precompile interface (subset).
/// Full source: paritytech/individuality/precompiles/personhood/sol/IPersonhood.sol
interface IPersonhood {
    struct PersonhoodInfo {
        uint8 status;     // 0 = None, 1 = Lite, 2 = Full
        bytes32 contextAlias;
    }
    function personhoodStatus(address account, bytes32 context)
        external view returns (PersonhoodInfo memory);
}

/// @title PopCounter
/// @notice Per-person counter that only accepts calls from accounts with
/// a registered ring-VRF alias for this contract's fixed `CTX`.
///
/// Use case demonstration for triangle-e2e: the same on-chain function
/// can be made unstoppable for verified humans (no Sybil), while keeping
/// the actual caller pseudonymous via the contextual alias.
///
/// Per-context: a person who registered their alias for some OTHER
/// context cannot bump this counter — they must register specifically
/// for this contract's CTX via `AliasAccounts.set_alias_account` on
/// Asset Hub.
contract PopCounter {
    IPersonhood constant POP = IPersonhood(0x000000000000000000000000000000000a010000);
    bytes32 constant CTX = bytes32("triangle-e2e:pop-counter");

    uint256 public totalBumps;
    /// @notice Per-person bump count, keyed by their contextual alias.
    mapping(bytes32 => uint256) public byAlias;

    error NotPerson();

    function bump() external {
        IPersonhood.PersonhoodInfo memory info = POP.personhoodStatus(msg.sender, CTX);
        if (info.status < 1) revert NotPerson();
        totalBumps += 1;
        byAlias[info.contextAlias] += 1;
    }
}
