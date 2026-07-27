// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ArcInherit
 * @notice Decentralized inheritance vault for ERC-20 tokens on Arc Network.
 *         Owners deposit tokens and designate heirs with percentage splits.
 *         If the owner stops checking in (proof of life), heirs can claim
 *         their share after the timelock + grace period expires.
 *
 * @dev Immutable — no owner, no upgrades, no admin functions.
 *      The contract enforces rules only. No entity (including the deployer,
 *      Arc, or Circle) has any privileged access to any vault.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ArcInherit {

    // ─── Errors ───────────────────────────────────────────────────────────────

    error VaultAlreadyExists();
    error VaultDoesNotExist();
    error VaultNotActive();
    error NotVaultOwner();
    error NotAnHeir();
    error TimelockNotExpired();
    error GracePeriodNotExpired();
    error AlreadyClaimed();
    error InvalidPercentages();   // heir percentages must sum to 100
    error NoHeirs();
    error InvalidTimelock();      // must be at least 30 days
    error InvalidGracePeriod();   // must be at least 7 days
    error ZeroAmount();
    error TransferFailed();

    // ─── Types ────────────────────────────────────────────────────────────────

    struct Heir {
        address wallet;
        uint8 percentage;         // 1–100, all heirs must sum to exactly 100
    }

    struct TokenBalance {
        address token;
        uint256 amount;
    }

    struct Vault {
        address owner;
        uint256 timelockDuration; // seconds — chosen by owner (min 30 days)
        uint256 gracePeriod;      // seconds — extra window after timelock (min 7 days)
        uint256 lastCheckIn;      // timestamp of last proof-of-life tx
        bool    active;           // false if owner cancelled the vault
        Heir[]  heirs;
        address[] tokens;         // list of deposited token addresses
    }

    // ─── Storage ──────────────────────────────────────────────────────────────

    // owner address → Vault
    mapping(address => Vault) private _vaults;

    // owner → token → amount deposited
    mapping(address => mapping(address => uint256)) private _balances;

    // owner → heir → token → claimed
    mapping(address => mapping(address => mapping(address => bool))) private _claimed;

    // ─── Events ───────────────────────────────────────────────────────────────

    event VaultCreated(address indexed owner, uint256 timelockDuration, uint256 gracePeriod);
    event Deposited(address indexed owner, address indexed token, uint256 amount);
    event Withdrawn(address indexed owner, address indexed token, uint256 amount);
    event CheckIn(address indexed owner, uint256 timestamp);
    event HeirsUpdated(address indexed owner);
    event VaultCancelled(address indexed owner);
    event InheritanceClaimed(address indexed owner, address indexed heir, address indexed token, uint256 amount);

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant MIN_TIMELOCK    = 30 days;
    uint256 public constant MIN_GRACE       = 7 days;

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier vaultExists(address owner) {
        if (_vaults[owner].owner == address(0)) revert VaultDoesNotExist();
        _;
    }

    modifier onlyOwner(address owner) {
        if (msg.sender != owner) revert NotVaultOwner();
        if (_vaults[owner].owner == address(0)) revert VaultDoesNotExist();
        _;
    }

    modifier vaultActive(address owner) {
        if (!_vaults[owner].active) revert VaultNotActive();
        _;
    }

    // ─── Owner functions ──────────────────────────────────────────────────────

    /**
     * @notice Create a new inheritance vault.
     * @param timelockDuration  Seconds of inactivity before heirs can claim (min 30 days).
     * @param gracePeriod       Extra seconds after timelock before heirs can claim (min 7 days).
     * @param heirs             Array of {wallet, percentage} — must sum to 100.
     */
    function createVault(
        uint256 timelockDuration,
        uint256 gracePeriod,
        Heir[] calldata heirs
    ) external {
        if (_vaults[msg.sender].owner != address(0)) revert VaultAlreadyExists();
        if (timelockDuration < MIN_TIMELOCK) revert InvalidTimelock();
        if (gracePeriod < MIN_GRACE) revert InvalidGracePeriod();
        if (heirs.length == 0) revert NoHeirs();

        uint256 total = 0;
        for (uint256 i = 0; i < heirs.length; i++) {
            total += heirs[i].percentage;
        }
        if (total != 100) revert InvalidPercentages();

        Vault storage v = _vaults[msg.sender];
        v.owner             = msg.sender;
        v.timelockDuration  = timelockDuration;
        v.gracePeriod       = gracePeriod;
        v.lastCheckIn       = block.timestamp;
        v.active            = true;

        for (uint256 i = 0; i < heirs.length; i++) {
            v.heirs.push(heirs[i]);
        }

        emit VaultCreated(msg.sender, timelockDuration, gracePeriod);
    }

    /**
     * @notice Deposit ERC-20 tokens into your vault.
     * @param token   Token contract address.
     * @param amount  Amount to deposit (must be approved first).
     */
    function deposit(address token, uint256 amount)
        external
        onlyOwner(msg.sender)
        vaultActive(msg.sender)
    {
        if (amount == 0) revert ZeroAmount();

        Vault storage v = _vaults[msg.sender];

        // Track token list (avoid duplicates)
        if (_balances[msg.sender][token] == 0) {
            v.tokens.push(token);
        }

        _balances[msg.sender][token] += amount;

        bool ok = IERC20(token).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        emit Deposited(msg.sender, token, amount);
    }

    /**
     * @notice Withdraw tokens from your vault (only while alive and vault active).
     * @param token   Token contract address.
     * @param amount  Amount to withdraw.
     */
    function withdraw(address token, uint256 amount)
        external
        onlyOwner(msg.sender)
        vaultActive(msg.sender)
    {
        if (amount == 0) revert ZeroAmount();
        if (_balances[msg.sender][token] < amount) revert ZeroAmount();

        _balances[msg.sender][token] -= amount;

        bool ok = IERC20(token).transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit Withdrawn(msg.sender, token, amount);
    }

    /**
     * @notice Proof-of-life transaction. Resets the timelock countdown.
     *         Owner must call this at least once every timelockDuration seconds.
     */
    function checkIn()
        external
        onlyOwner(msg.sender)
        vaultActive(msg.sender)
    {
        _vaults[msg.sender].lastCheckIn = block.timestamp;
        emit CheckIn(msg.sender, block.timestamp);
    }

    /**
     * @notice Update the list of heirs and their percentages.
     * @param heirs  New array of {wallet, percentage} — must sum to 100.
     */
    function updateHeirs(Heir[] calldata heirs)
        external
        onlyOwner(msg.sender)
        vaultActive(msg.sender)
    {
        if (heirs.length == 0) revert NoHeirs();

        uint256 total = 0;
        for (uint256 i = 0; i < heirs.length; i++) {
            total += heirs[i].percentage;
        }
        if (total != 100) revert InvalidPercentages();

        Vault storage v = _vaults[msg.sender];
        delete v.heirs;
        for (uint256 i = 0; i < heirs.length; i++) {
            v.heirs.push(heirs[i]);
        }

        emit HeirsUpdated(msg.sender);
    }

    /**
     * @notice Cancel the vault and withdraw all deposited tokens back to owner.
     *         Irreversible — vault cannot be reactivated (owner can create a new one).
     */
    function cancelVault() external onlyOwner(msg.sender) vaultActive(msg.sender) {
        Vault storage v = _vaults[msg.sender];
        v.active = false;

        // Return all tokens to owner
        for (uint256 i = 0; i < v.tokens.length; i++) {
            address token = v.tokens[i];
            uint256 bal   = _balances[msg.sender][token];
            if (bal > 0) {
                _balances[msg.sender][token] = 0;
                bool ok = IERC20(token).transfer(msg.sender, bal);
                if (!ok) revert TransferFailed();
                emit Withdrawn(msg.sender, token, bal);
            }
        }

        emit VaultCancelled(msg.sender);
    }

    // ─── Heir functions ───────────────────────────────────────────────────────

    /**
     * @notice Claim inheritance for a specific token from a vault.
     * @param owner  The vault owner's address.
     * @param token  The token to claim.
     *
     * Requirements:
     *   - Caller must be a registered heir of this vault
     *   - Timelock must have expired (lastCheckIn + timelockDuration < now)
     *   - Grace period must have passed (lastCheckIn + timelockDuration + gracePeriod < now)
     *   - Not already claimed this token
     */
    function claimInheritance(address owner, address token)
        external
        vaultExists(owner)
        vaultActive(owner)
    {
        Vault storage v = _vaults[owner];

        // Check timelock + grace period
        uint256 unlockTime = v.lastCheckIn + v.timelockDuration + v.gracePeriod;
        if (block.timestamp < v.lastCheckIn + v.timelockDuration) revert TimelockNotExpired();
        if (block.timestamp < unlockTime) revert GracePeriodNotExpired();

        // Find heir and percentage
        uint8 pct = 0;
        for (uint256 i = 0; i < v.heirs.length; i++) {
            if (v.heirs[i].wallet == msg.sender) {
                pct = v.heirs[i].percentage;
                break;
            }
        }
        if (pct == 0) revert NotAnHeir();

        // Check not already claimed
        if (_claimed[owner][msg.sender][token]) revert AlreadyClaimed();
        _claimed[owner][msg.sender][token] = true;

        // Calculate and transfer share
        uint256 total  = _balances[owner][token];
        uint256 share  = (total * pct) / 100;
        if (share == 0) revert ZeroAmount();

        _balances[owner][token] -= share;

        bool ok = IERC20(token).transfer(msg.sender, share);
        if (!ok) revert TransferFailed();

        emit InheritanceClaimed(owner, msg.sender, token, share);
    }

    // ─── View functions ───────────────────────────────────────────────────────

    /**
     * @notice Returns vault metadata (no balances).
     */
    function getVault(address owner) external view returns (
        uint256 timelockDuration,
        uint256 gracePeriod,
        uint256 lastCheckIn,
        bool    active,
        Heir[]  memory heirs
    ) {
        Vault storage v = _vaults[owner];
        return (v.timelockDuration, v.gracePeriod, v.lastCheckIn, v.active, v.heirs);
    }

    /**
     * @notice Returns all token balances in a vault.
     */
    function getBalances(address owner) external view returns (TokenBalance[] memory) {
        Vault storage v = _vaults[owner];
        TokenBalance[] memory balances = new TokenBalance[](v.tokens.length);
        for (uint256 i = 0; i < v.tokens.length; i++) {
            balances[i] = TokenBalance({
                token:  v.tokens[i],
                amount: _balances[owner][v.tokens[i]]
            });
        }
        return balances;
    }

    /**
     * @notice Returns true if the timelock has expired for a vault.
     */
    function isTimelockExpired(address owner) external view returns (bool) {
        Vault storage v = _vaults[owner];
        return block.timestamp >= v.lastCheckIn + v.timelockDuration;
    }

    /**
     * @notice Returns true if heirs can claim (timelock + grace period both expired).
     */
    function canClaim(address owner) external view returns (bool) {
        Vault storage v = _vaults[owner];
        return block.timestamp >= v.lastCheckIn + v.timelockDuration + v.gracePeriod;
    }

    /**
     * @notice Returns seconds remaining until heirs can claim.
     *         Returns 0 if already claimable.
     */
    function timeUntilClaim(address owner) external view returns (uint256) {
        Vault storage v = _vaults[owner];
        uint256 unlockTime = v.lastCheckIn + v.timelockDuration + v.gracePeriod;
        if (block.timestamp >= unlockTime) return 0;
        return unlockTime - block.timestamp;
    }

    /**
     * @notice Returns whether a specific heir has claimed a specific token.
     */
    function hasClaimed(address owner, address heir, address token) external view returns (bool) {
        return _claimed[owner][heir][token];
    }
}
