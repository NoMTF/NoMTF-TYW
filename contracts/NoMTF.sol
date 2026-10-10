// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IBasketAdapter {
    function buyExact(uint8 assetIndex, uint256 amountOut, uint256 maxStableIn) external returns (uint256);
    function sellExact(uint8 assetIndex, uint256 amountIn, uint256 minStableOut) external returns (uint256);
}
interface IStableConverter {
    function convert(bool toUsdc, uint256 amount, uint256 minimum) external returns(uint256);
}

/// @notice Three-asset, fully collateralized basket shares. Not a fixed dollar peg.
/// Price reports cannot mint shares: ongoing mints must deliver the proportional basket.
contract NoMTF is ERC20, Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    uint256 public constant CAP = 10_000_000_000 * 1e18;
    uint256 public constant LOCKED_SEED = 1e16;
    uint256 public constant MAX_BATCH = 64;
    bytes32 private constant PRICE_TYPEHASH = keccak256("Prices(uint256 p0,uint256 p1,uint256 p2,uint256 validUntil,uint256 nonce)");
    IERC20[3] public assets;
    uint256[3] public units;
    IERC20 public immutable stable;
    uint256 public immutable stableUnit;
    address public executor;
    address public priceSigner;
    IBasketAdapter public adapter;
    IERC20 public usdc;
    IStableConverter public stableConverter;
    uint256 public priceNonce;
    uint256 public nextRequestId = 1;
    uint256 public pendingStable;
    uint256 public escrowedShares;
    uint256 public cumulativeRebalanceCostUsd;
    uint256 public cumulativeRebalanceGasUsd;
    uint256 public rebalanceNonce;
    bool public initialized;
    uint16 public maxRebalanceLossBps = 25;
    uint16 public maxGasBps = 10;

    enum Status { None, Open, Settled, Cancelled }
    struct Request { address user; uint256 amount; uint256 minimum; uint64 deadline; bool redeem; Status status; }
    struct Prices { uint256 p0; uint256 p1; uint256 p2; uint256 validUntil; uint256 nonce; }
    mapping(uint256 => Request) public requests;
    mapping(uint256 => bool) public paysUsdc;
    mapping(bytes32 => bool) public completedRebalances;

    error Invalid();
    error Unauthorized();
    error Limit();
    error Stale();
    error IncompleteBasket();
    error NotTriggered();
    event Configured(address executor, address signer, address adapter);
    event Seeded(address indexed user, uint256 shares, uint256[3] amounts);
    event BasketMinted(address indexed user, uint256 shares, uint256[3] amounts);
    event BasketRedeemed(address indexed user, uint256 shares, uint256[3] amounts);
    event Requested(uint256 indexed id, address indexed user, bool redeem, uint256 amount, uint256 minimum, uint64 deadline);
    event Cancelled(uint256 indexed id);
    event Settled(uint256 indexed id, uint256 received, uint256 refund);
    event Rebalanced(bytes32 indexed taskId, uint256 nonce, uint256[3] values, uint256 lossUsd, uint256 gasUsd);

    constructor(address[3] memory tokens, address settlement, address administrator)
        ERC20("NoMTF", "TYW") Ownable(administrator) EIP712("NoMTF", "1") {
        if (settlement == address(0)) revert Invalid();
        for (uint256 i; i < 3; ++i) {
            if (tokens[i] == address(0) || tokens[i] == settlement) revert Invalid();
            for (uint256 j; j < i; ++j) if (tokens[i] == tokens[j]) revert Invalid();
            uint8 d = IERC20Metadata(tokens[i]).decimals();
            if (d > 18) revert Invalid();
            assets[i] = IERC20(tokens[i]); units[i] = 10 ** d;
        }
        stable = IERC20(settlement);
        uint8 sd = IERC20Metadata(settlement).decimals();
        if (sd > 18) revert Invalid();
        stableUnit = 10 ** sd;
        _pause();
    }

    modifier onlyExecutor() { if (msg.sender != executor) revert Unauthorized(); _; }

    function configure(address keeper, address signer, address route) external onlyOwner {
        if (initialized || !paused() || keeper == address(0) || signer == address(0) || route.code.length == 0) revert Invalid();
        executor = keeper; priceSigner = signer; adapter = IBasketAdapter(route);
        emit Configured(keeper, signer, route);
    }
    /// @notice Roles can be rotated while paused; backing and adapter remain immutable after seed.
    function rotateRoles(address keeper, address signer) external onlyOwner {
        if (!paused() || keeper == address(0) || signer == address(0)) revert Invalid();
        executor = keeper; priceSigner = signer;
        emit Configured(keeper, signer, address(adapter));
    }
    function configureUsdc(address token, address converter) external onlyOwner {
        if (initialized || !paused() || token == address(stable) || token.code.length == 0 || converter.code.length == 0 || IERC20Metadata(token).decimals() != 18 || stableUnit != 1e18) revert Invalid();
        for(uint256 i;i<3;++i) if(token==address(assets[i])) revert Invalid();
        usdc=IERC20(token); stableConverter=IStableConverter(converter);
    }
    function setLimits(uint16 lossBps, uint16 gasBps) external onlyOwner {
        if (!paused() || lossBps > 100 || gasBps > 50) revert Limit();
        maxRebalanceLossBps = lossBps; maxGasBps = gasBps;
    }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner {
        if (!initialized || executor == address(0) || address(adapter) == address(0)) revert IncompleteBasket();
        _unpause();
    }

    function _prices(Prices calldata p, bytes calldata sig) private view returns (uint256[3] memory values) {
        if (p.p0 == 0 || p.p1 == 0 || p.p2 == 0 || p.validUntil < block.timestamp || p.validUntil > block.timestamp + 300 || p.nonce < priceNonce) revert Stale();
        bytes32 h = _hashTypedDataV4(keccak256(abi.encode(PRICE_TYPEHASH, p.p0, p.p1, p.p2, p.validUntil, p.nonce)));
        if (ECDSA.recover(h, sig) != priceSigner) revert Unauthorized();
        values = [p.p0, p.p1, p.p2];
    }
    function _values(uint256[3] memory prices_) private view returns (uint256[3] memory values) {
        for (uint256 i; i < 3; ++i) values[i] = Math.mulDiv(assets[i].balanceOf(address(this)), prices_[i], units[i]);
    }
    function _sum(uint256[3] memory v) private pure returns (uint256) { return v[0] + v[1] + v[2]; }
    function _target(uint256 i) private pure returns (uint256) { return i == 1 ? 5000 : 2500; }
    function _triggered(uint256[3] memory v) private pure returns (bool) {
        uint256 total = _sum(v);
        if (total == 0) return false;
        for (uint256 i; i < 3; ++i) {
            uint256 lower = i == 1 ? 3000 : 1500;
            uint256 upper = i == 1 ? 7000 : 3500;
            if (v[i] * 10000 <= total * lower || v[i] * 10000 >= total * upper) return true;
        }
        return false;
    }
    function netAssetValue(Prices calldata p, bytes calldata sig) external view returns (uint256 totalUsd, uint256 perShareUsd, uint256[3] memory weightsBps) {
        uint256[3] memory v = _values(_prices(p, sig)); totalUsd = _sum(v) + Math.mulDiv(_freeStable(), 1e18, stableUnit);
        uint256 s = totalSupply(); perShareUsd = s == 0 ? 1e18 : Math.mulDiv(totalUsd, 1e18, s);
        if (totalUsd != 0) for (uint256 i; i < 3; ++i) weightsBps[i] = Math.mulDiv(v[i], 10000, totalUsd);
    }

    function seed(uint256[3] calldata amounts, Prices calldata p, bytes calldata sig) external onlyOwner nonReentrant {
        if (initialized || priceSigner == address(0)) revert Invalid();
        uint256[3] memory prices_ = _prices(p, sig);
        for (uint256 i; i < 3; ++i) {
            if (amounts[i] == 0) revert Invalid();
            _pullExact(assets[i], msg.sender, amounts[i]);
        }
        uint256[3] memory v = _values(prices_); uint256 value = _sum(v);
        if (value < 1e18 || value > CAP) revert Limit();
        _requireTarget(v);
        initialized = true; priceNonce = p.nonce;
        _mint(address(0xdead), LOCKED_SEED); _mint(msg.sender, value - LOCKED_SEED);
        emit Seeded(msg.sender, value - LOCKED_SEED, amounts);
    }
    function _pullExact(IERC20 token, address from, uint256 amount) private {
        uint256 before_ = token.balanceOf(address(this)); token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - before_ != amount) revert Invalid();
    }
    function previewMint(uint256 shares) public view returns (uint256[3] memory amounts) {
        uint256 s = totalSupply(); if (!initialized || shares == 0 || s + shares > CAP) revert Limit();
        for (uint256 i; i < 3; ++i) {
            amounts[i] = Math.mulDiv(shares, assets[i].balanceOf(address(this)), s, Math.Rounding.Ceil);
            if (amounts[i] == 0) revert IncompleteBasket();
        }
    }
    function _freeStable() private view returns (uint256) { return stable.balanceOf(address(this)) - pendingStable; }
    function previewStableMint(uint256 shares) public view returns (uint256) {
        if (!initialized) revert Invalid(); return Math.mulDiv(shares, _freeStable(), totalSupply(), Math.Rounding.Ceil);
    }
    function previewStableRedeem(uint256 shares) public view returns (uint256) {
        if (!initialized) revert Invalid(); return Math.mulDiv(shares, _freeStable(), totalSupply());
    }
    function mintBasket(uint256 shares, uint256[3] calldata maxima, uint256 maximumStableDust, address receiver) external nonReentrant whenNotPaused {
        if (receiver == address(0) || receiver == address(this)) revert Invalid();
        uint256[3] memory amounts = previewMint(shares);
        uint256 stableDust = previewStableMint(shares);
        if (stableDust > maximumStableDust) revert Limit();
        for (uint256 i; i < 3; ++i) {
            if (amounts[i] > maxima[i]) revert Limit();
            _pullExact(assets[i], msg.sender, amounts[i]);
        }
        if (stableDust != 0) _pullExact(stable, msg.sender, stableDust);
        _mint(receiver, shares); emit BasketMinted(receiver, shares, amounts);
    }
    function previewRedeem(uint256 shares) public view returns (uint256[3] memory amounts) {
        uint256 s = totalSupply(); if (shares == 0 || shares >= s) revert Limit();
        for (uint256 i; i < 3; ++i) amounts[i] = Math.mulDiv(shares, assets[i].balanceOf(address(this)), s);
    }
    /// @notice In-kind escape route remains available while new trading is paused.
    function redeemBasket(uint256 shares, uint256[3] calldata minima, address receiver) external nonReentrant {
        if (receiver == address(0) || receiver == address(this)) revert Invalid();
        uint256[3] memory amounts = previewRedeem(shares); uint256 stableDust = previewStableRedeem(shares); _burn(msg.sender, shares);
        for (uint256 i; i < 3; ++i) {
            if (amounts[i] < minima[i]) revert Limit(); assets[i].safeTransfer(receiver, amounts[i]);
        }
        if (stableDust != 0) stable.safeTransfer(receiver, stableDust);
        emit BasketRedeemed(receiver, shares, amounts);
    }

    function requestDeposit(uint256 amount, uint256 minimumShares, uint64 deadline) external nonReentrant whenNotPaused returns (uint256 id) {
        _deadline(deadline); if (amount == 0 || minimumShares == 0) revert Invalid();
        _pullExact(stable, msg.sender, amount); pendingStable += amount;
        id = nextRequestId++; requests[id] = Request(msg.sender, amount, minimumShares, deadline, false, Status.Open);
        emit Requested(id, msg.sender, false, amount, minimumShares, deadline);
    }
    /// @notice Converts USDC once before queuing; cancellation returns the resulting USDT.
    function requestDepositUsdc(uint256 amount, uint256 minimumStable, uint256 minimumShares, uint64 deadline) external nonReentrant whenNotPaused returns(uint256 id) {
        _deadline(deadline); if(amount==0 || minimumStable==0 || minimumShares==0 || address(usdc)==address(0)) revert Invalid();
        _pullExact(usdc,msg.sender,amount); usdc.forceApprove(address(stableConverter),amount);
        uint256 beforeStable=stable.balanceOf(address(this)); uint256 beforeUsdc=usdc.balanceOf(address(this));
        uint256 received=stableConverter.convert(false,amount,minimumStable); usdc.forceApprove(address(stableConverter),0);
        if(stable.balanceOf(address(this))-beforeStable!=received || beforeUsdc-usdc.balanceOf(address(this))!=amount || received<minimumStable) revert Limit();
        pendingStable+=received; id=nextRequestId++; requests[id]=Request(msg.sender,received,minimumShares,deadline,false,Status.Open);
        emit Requested(id,msg.sender,false,received,minimumShares,deadline);
    }
    function requestRedeem(uint256 shares, uint256 minimumStable, uint64 deadline) external nonReentrant whenNotPaused returns (uint256 id) {
        _deadline(deadline); if (shares == 0 || minimumStable == 0) revert Invalid();
        _transfer(msg.sender, address(this), shares); escrowedShares += shares;
        id = nextRequestId++; requests[id] = Request(msg.sender, shares, minimumStable, deadline, true, Status.Open);
        emit Requested(id, msg.sender, true, shares, minimumStable, deadline);
    }
    function requestRedeemUsdc(uint256 shares,uint256 minimumUsdc,uint64 deadline) external nonReentrant whenNotPaused returns(uint256 id) {
        _deadline(deadline);if(shares==0||minimumUsdc==0||address(usdc)==address(0))revert Invalid();
        _transfer(msg.sender,address(this),shares);escrowedShares+=shares;
        id=nextRequestId++;requests[id]=Request(msg.sender,shares,minimumUsdc,deadline,true,Status.Open);paysUsdc[id]=true;
        emit Requested(id,msg.sender,true,shares,minimumUsdc,deadline);
    }
    function _deadline(uint64 d) private view { if (d <= block.timestamp || d > block.timestamp + 30 days) revert Stale(); }
    function cancelRequest(uint256 id) external nonReentrant {
        Request storage r = requests[id];
        if (r.status != Status.Open || (msg.sender != r.user && block.timestamp <= r.deadline)) revert Unauthorized();
        r.status = Status.Cancelled;
        if (r.redeem) { escrowedShares -= r.amount; _transfer(address(this), r.user, r.amount); }
        else { pendingStable -= r.amount; stable.safeTransfer(r.user, r.amount); }
        emit Cancelled(id);
    }
    function _batch(uint256[] calldata ids, bool redeem) private returns (uint256 total) {
        if (ids.length == 0 || ids.length > MAX_BATCH) revert Limit();
        for (uint256 i; i < ids.length; ++i) {
            Request storage r = requests[ids[i]];
            if (r.status != Status.Open || r.redeem != redeem || r.deadline < block.timestamp) revert Invalid();
            r.status = Status.Settled; total += r.amount;
        }
    }
    function settleDeposits(uint256[] calldata ids, uint256 totalShares, uint256[3] calldata maxInputs) external onlyExecutor nonReentrant whenNotPaused {
        uint256 input = _batch(ids, false);
        uint256[3] memory need = previewMint(totalShares);
        uint256 stableCredit = previewStableMint(totalShares);
        uint256 spent;
        for (uint256 i; i < 3; ++i) {
            if (maxInputs[i] > input - spent) revert Limit();
            stable.forceApprove(address(adapter), maxInputs[i]);
            uint256 stableBefore = stable.balanceOf(address(this)); uint256 assetBefore = assets[i].balanceOf(address(this));
            uint256 used = adapter.buyExact(uint8(i), need[i], maxInputs[i]); stable.forceApprove(address(adapter), 0);
            if (assets[i].balanceOf(address(this)) - assetBefore != need[i] || stableBefore - stable.balanceOf(address(this)) != used || used > maxInputs[i]) revert IncompleteBasket();
            spent += used;
        }
        if (spent + stableCredit > input) revert Limit(); pendingStable -= input;
        uint256 refund = input - spent - stableCredit; uint256 remainingShares = totalShares; uint256 remainingRefund = refund;
        for (uint256 i; i < ids.length; ++i) {
            Request storage r = requests[ids[i]];
            uint256 minted = Math.mulDiv(totalShares, r.amount, input);
            uint256 back = Math.mulDiv(refund, r.amount, input);
            if (i + 1 == ids.length) { minted = remainingShares; back = remainingRefund; }
            if (minted < r.minimum) revert Limit();
            remainingShares -= minted; remainingRefund -= back; _mint(r.user, minted);
            if (back != 0) stable.safeTransfer(r.user, back); emit Settled(ids[i], minted, back);
        }
    }
    function settleRedemptions(uint256[] calldata ids, uint256[3] calldata minOutputs) external onlyExecutor nonReentrant whenNotPaused {
        uint256 shares = _batch(ids, true); uint256[3] memory amounts = previewRedeem(shares); uint256 output = previewStableRedeem(shares);
        for (uint256 i; i < 3; ++i) {
            assets[i].forceApprove(address(adapter), amounts[i]);
            uint256 stableBefore = stable.balanceOf(address(this)); uint256 assetBefore = assets[i].balanceOf(address(this));
            uint256 got = adapter.sellExact(uint8(i), amounts[i], minOutputs[i]); assets[i].forceApprove(address(adapter), 0);
            if (assetBefore - assets[i].balanceOf(address(this)) != amounts[i] || stable.balanceOf(address(this)) - stableBefore != got || got < minOutputs[i]) revert IncompleteBasket();
            output += got;
        }
        bool toUsdc=paysUsdc[ids[0]]; IERC20 payout=toUsdc?usdc:stable;
        for(uint256 i;i<ids.length;++i) if(paysUsdc[ids[i]]!=toUsdc) revert Invalid();
        if(toUsdc){
            stable.forceApprove(address(stableConverter),output);uint256 beforeUsdc=usdc.balanceOf(address(this));uint256 beforeStable=stable.balanceOf(address(this));
            uint256 converted=stableConverter.convert(true,output,0);stable.forceApprove(address(stableConverter),0);
            if(usdc.balanceOf(address(this))-beforeUsdc!=converted || beforeStable-stable.balanceOf(address(this))!=output)revert Limit();output=converted;
        }
        _burn(address(this), shares); escrowedShares -= shares; uint256 remaining = output;
        for (uint256 i; i < ids.length; ++i) {
            Request storage r = requests[ids[i]]; uint256 got = Math.mulDiv(output, r.amount, shares);
            if (i + 1 == ids.length) got = remaining;
            if (got < r.minimum) revert Limit(); remaining -= got; payout.safeTransfer(r.user, got);
            emit Settled(ids[i], got, 0);
        }
    }

    function rebalance(bytes32 taskId, uint256 expectedNonce, Prices calldata p, bytes calldata sig,
        uint256[3] calldata sells, uint256[3] calldata minOutputs,
        uint256[3] calldata buys, uint256[3] calldata maxInputs, uint256 gasUsd)
        external onlyExecutor nonReentrant whenNotPaused {
        if (completedRebalances[taskId] || expectedNonce != rebalanceNonce) revert Invalid();
        uint256[3] memory prices_ = _prices(p, sig); uint256[3] memory beforeV = _values(prices_);
        uint256 beforeUsd = _sum(beforeV);
        if (!_triggered(beforeV)) revert NotTriggered();
        if (gasUsd > Math.mulDiv(beforeUsd, maxGasBps, 10000)) revert Limit();
        completedRebalances[taskId] = true; ++rebalanceNonce; priceNonce = p.nonce;
        uint256 stableBefore = stable.balanceOf(address(this)); uint256 available;
        for (uint256 i; i < 3; ++i) if (sells[i] != 0) {
            if (sells[i] > assets[i].balanceOf(address(this))) revert Limit();
            assets[i].forceApprove(address(adapter), sells[i]); uint256 old = stable.balanceOf(address(this)); uint256 assetOld = assets[i].balanceOf(address(this));
            uint256 got = adapter.sellExact(uint8(i), sells[i], minOutputs[i]); assets[i].forceApprove(address(adapter), 0);
            if (stable.balanceOf(address(this)) - old != got || assetOld - assets[i].balanceOf(address(this)) != sells[i] || got < minOutputs[i]) revert Limit(); available += got;
        }
        for (uint256 i; i < 3; ++i) if (buys[i] != 0) {
            if (maxInputs[i] > available) revert Limit();
            stable.forceApprove(address(adapter), maxInputs[i]); uint256 old = stable.balanceOf(address(this)); uint256 assetOld = assets[i].balanceOf(address(this));
            uint256 used = adapter.buyExact(uint8(i), buys[i], maxInputs[i]); stable.forceApprove(address(adapter), 0);
            if (old - stable.balanceOf(address(this)) != used || assets[i].balanceOf(address(this)) - assetOld != buys[i] || used > maxInputs[i]) revert Limit(); available -= used;
        }
        // Rebalancing must not spend pending deposits. Unspent trade dust is included in NAV.
        uint256 dustLimit = Math.mulDiv(beforeUsd, stableUnit, 1e18) / 1000;
        if (dustLimit < stableUnit / 1000) dustLimit = stableUnit / 1000;
        if (stable.balanceOf(address(this)) < stableBefore || available > dustLimit) revert Limit();
        uint256[3] memory afterV = _values(prices_); _requireTarget(afterV);
        uint256 afterUsd = _sum(afterV) + Math.mulDiv(available, 1e18, stableUnit);
        uint256 loss = beforeUsd > afterUsd ? beforeUsd - afterUsd : 0;
        if (loss + gasUsd > Math.mulDiv(beforeUsd, maxRebalanceLossBps, 10000)) revert Limit();
        cumulativeRebalanceCostUsd += loss; cumulativeRebalanceGasUsd += gasUsd;
        emit Rebalanced(taskId, expectedNonce, afterV, loss, gasUsd);
    }
    function _requireTarget(uint256[3] memory v) private pure {
        uint256 total = _sum(v); if (total == 0) revert Invalid();
        for (uint256 i; i < 3; ++i) {
            uint256 weighted = Math.mulDiv(v[i], 10000, total); uint256 target = _target(i);
            if (weighted + 10 < target || weighted > target + 10) revert Limit();
        }
    }
}
