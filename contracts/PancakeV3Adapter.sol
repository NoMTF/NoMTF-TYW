// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPancakeRouter {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    struct ExactOutputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountOut; uint256 amountInMaximum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256);
}
interface IFactory { function getPool(address a, address b, uint24 fee) external view returns (address); }

/// @notice Atomic route only. An absent IEFon pool is a hard launch blocker, not silently substituted.
contract PancakeV3Adapter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable vault;
    IERC20 public immutable stable;
    IPancakeRouter public immutable router;
    address[3] public assets;
    uint24[3] public fees;
    bool public immutable complete;
    error InvalidRoute();
    constructor(address v, address s, address r, address f, address[3] memory a, uint24[3] memory fee) {
        vault = v; stable = IERC20(s); router = IPancakeRouter(r); assets = a; fees = fee;
        bool all = true;
        for (uint256 i; i < 3; ++i) if (IFactory(f).getPool(s, a[i], fee[i]) == address(0)) all = false;
        complete = all;
    }
    modifier onlyVault(uint8 i) { if (msg.sender != vault || i >= 3 || !complete) revert InvalidRoute(); _; }
    function buyExact(uint8 i, uint256 out, uint256 maxIn) external onlyVault(i) nonReentrant returns (uint256 used) {
        stable.safeTransferFrom(vault, address(this), maxIn); stable.forceApprove(address(router), maxIn);
        used = router.exactOutputSingle(IPancakeRouter.ExactOutputSingleParams(address(stable), assets[i], fees[i], vault, out, maxIn, 0));
        stable.forceApprove(address(router), 0); if (used < maxIn) stable.safeTransfer(vault, maxIn - used);
    }
    function sellExact(uint8 i, uint256 amount, uint256 minOut) external onlyVault(i) nonReentrant returns (uint256 received) {
        IERC20 token = IERC20(assets[i]); token.safeTransferFrom(vault, address(this), amount); token.forceApprove(address(router), amount);
        received = router.exactInputSingle(IPancakeRouter.ExactInputSingleParams(assets[i], address(stable), fees[i], vault, amount, minOut, 0));
        token.forceApprove(address(router), 0);
    }
}
