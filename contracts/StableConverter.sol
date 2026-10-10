// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPancakeRouter,IFactory} from "./PancakeV3Adapter.sol";
/// @notice Fixed USDC/USDT route. No arbitrary token, recipient or calldata.
contract StableConverter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable vault; IERC20 public immutable stable; IERC20 public immutable usdc;
    IPancakeRouter public immutable router; uint24 public immutable fee;
    constructor(address v,address s,address u,address r,address f,uint24 selectedFee){
        require(v!=address(0)&&s!=u&&IFactory(f).getPool(s,u,selectedFee)!=address(0));
        vault=v;stable=IERC20(s);usdc=IERC20(u);router=IPancakeRouter(r);fee=selectedFee;
    }
    function convert(bool toUsdc,uint256 amount,uint256 minimum) external nonReentrant returns(uint256 out){
        require(msg.sender==vault);IERC20 input=toUsdc?stable:usdc;IERC20 output=toUsdc?usdc:stable;
        input.safeTransferFrom(vault,address(this),amount);input.forceApprove(address(router),amount);
        out=router.exactInputSingle(IPancakeRouter.ExactInputSingleParams(address(input),address(output),fee,vault,amount,minimum,0));
        input.forceApprove(address(router),0);
    }
}
