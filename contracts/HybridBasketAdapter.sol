// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPancakeRouter, IFactory} from "./PancakeV3Adapter.sol";

/// @notice SPYB/XAUt use real V3 pools. IEFon uses separately funded inventory.
/// Inventory is NOT counted as vault backing and must be funded before accepting users.
/// PCSX can replenish maker inventory independently; an OPEN RFQ is never a mint receipt.
contract HybridBasketAdapter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable vault;
    IERC20 public immutable stable;
    IPancakeRouter public immutable router;
    address[3] public assets;
    uint24[3] public fees;
    bool public immutable complete;
    uint256 public bid;
    uint256 public ask;
    uint64 public quoteValidUntil;
    error InvalidRoute();
    error InventoryUnavailable();
    event QuoteUpdated(uint256 bidUsd, uint256 askUsd, uint64 validUntil);
    constructor(address v, address s, address r, address f, address[3] memory a, uint24[3] memory fee, address maker) Ownable(maker) {
        if (IERC20Metadata(s).decimals() != 18 || IERC20Metadata(a[1]).decimals() != 18) revert InvalidRoute();
        vault=v;stable=IERC20(s);router=IPancakeRouter(r);assets=a;fees=fee;
        complete = IFactory(f).getPool(s,a[0],fee[0]) != address(0) && IFactory(f).getPool(s,a[2],fee[2]) != address(0);
    }
    function setQuote(uint256 bidUsd,uint256 askUsd,uint64 until) external onlyOwner {
        if (bidUsd == 0 || askUsd < bidUsd || askUsd > Math.mulDiv(bidUsd,10100,10000) || until <= block.timestamp || until > block.timestamp+300) revert InvalidRoute();
        bid=bidUsd;ask=askUsd;quoteValidUntil=until;emit QuoteUpdated(bidUsd,askUsd,until);
    }
    function fundInventory(address token,uint256 amount) external onlyOwner {
        if(token!=assets[1] && token!=address(stable))revert InvalidRoute();
        IERC20(token).safeTransferFrom(msg.sender,address(this),amount);
    }
    function withdrawInventory(address token,uint256 amount) external onlyOwner {
        if(token!=assets[1] && token!=address(stable))revert InvalidRoute();
        IERC20(token).safeTransfer(msg.sender,amount);
    }
    modifier onlyVault(uint8 i){if(msg.sender!=vault||i>=3||!complete)revert InvalidRoute();_;}
    function buyExact(uint8 i,uint256 out,uint256 maxIn) external onlyVault(i) nonReentrant returns(uint256 used){
        if(i==1){
            if(quoteValidUntil<block.timestamp||ask==0||IERC20(assets[1]).balanceOf(address(this))<out)revert InventoryUnavailable();
            used=Math.mulDiv(out,ask,1e18,Math.Rounding.Ceil);if(used>maxIn)revert InvalidRoute();
            stable.safeTransferFrom(vault,address(this),used);IERC20(assets[1]).safeTransfer(vault,out);
        }else{
            stable.safeTransferFrom(vault,address(this),maxIn);stable.forceApprove(address(router),maxIn);
            used=router.exactOutputSingle(IPancakeRouter.ExactOutputSingleParams(address(stable),assets[i],fees[i],vault,out,maxIn,0));
            stable.forceApprove(address(router),0);if(used<maxIn)stable.safeTransfer(vault,maxIn-used);
        }
    }
    function sellExact(uint8 i,uint256 amount,uint256 minOut) external onlyVault(i) nonReentrant returns(uint256 received){
        if(i==1){
            if(quoteValidUntil<block.timestamp||bid==0)revert InventoryUnavailable();
            received=Math.mulDiv(amount,bid,1e18);
            if(received<minOut||stable.balanceOf(address(this))<received)revert InventoryUnavailable();
            IERC20(assets[1]).safeTransferFrom(vault,address(this),amount);stable.safeTransfer(vault,received);
        }else{
            IERC20 token=IERC20(assets[i]);token.safeTransferFrom(vault,address(this),amount);token.forceApprove(address(router),amount);
            received=router.exactInputSingle(IPancakeRouter.ExactInputSingleParams(assets[i],address(stable),fees[i],vault,amount,minOut,0));
            token.forceApprove(address(router),0);
        }
    }
}
