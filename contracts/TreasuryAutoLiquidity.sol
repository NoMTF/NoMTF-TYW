// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TreasuryInfinityLiquidity, IInfinityManager} from "./TreasuryInfinityLiquidity.sol";
interface IAutoVault is IERC20 {
    function valuation() external view returns(uint256,uint256,uint256[4] memory,uint256[4] memory);
    function paused() external view returns(bool);
    function buy(uint256,uint256,uint256[4] calldata,uint256) external returns(uint256);
    function sell(uint256,uint256,uint256[4] calldata,uint256) external returns(uint256);
}
/// @notice Converts only excess treasury inventory through the original backed vault, then adds LP.
/// Quotes are untrusted: value, direction, balance, price and deadline are enforced on chain.
/// No arbitrary calls or reserve withdrawals; all LP and change belong to the immutable treasury.
contract TreasuryAutoLiquidity is ReentrancyGuard {
    using SafeERC20 for IERC20;
    TreasuryInfinityLiquidity public immutable matched;
    IAutoVault public immutable tyw;
    IERC20 public immutable stable;
    address public immutable treasury;
    address public immutable manager;
    bytes32 public immutable poolId;
    bool public enabled=true;
    uint256 public constant MAX_VALUE=1900e18;
    uint256 public constant MIN_VALUE=11e17;
    uint256 public constant MAX_LOSS_BPS=50;
    uint256 public constant BALANCE_TOLERANCE_BPS=50;
    event Provided(address indexed trigger,uint256 indexed tokenId,uint256 cash,uint256 tokens,bool bought,uint256 shares);
    event Enabled(bool enabled);
    constructor(address controller){
        require(controller.code.length>0,"configuration");
        matched=TreasuryInfinityLiquidity(controller);
        tyw=IAutoVault(address(matched.tyw()));stable=matched.stable();treasury=matched.treasury();
        manager=address(matched.manager());poolId=matched.poolId();
    }
    function setEnabled(bool value) external {require(msg.sender==treasury,"treasury");enabled=value;emit Enabled(value);}
    function _available(IERC20 token) private view returns(uint256){return Math.min(token.balanceOf(treasury),token.allowance(treasury,address(this)));}
    function inventory() public view returns(uint256 cash,uint256 tokens,uint256 nav,uint256 ratio){
        require(enabled&&matched.enabled()&&!tyw.paused(),"disabled");
        (uint160 sqrt,int24 tick,,)=IInfinityManager(manager).getSlot0(poolId);require(sqrt>0,"pool");
        (,nav,,)=tyw.valuation();require(nav>0&&nav<=1000e18,"nav");
        uint256 price=Math.mulDiv(1<<96,1e18,Math.mulDiv(sqrt,sqrt,1<<96));
        require(price*10000>=nav*9500&&price*10000<=nav*10500,"price");
        int24 center=tick/10*10;if(tick<0&&tick%10!=0)center-=10;
        uint160 a=TickMath.getSqrtPriceAtTick(center-500);uint160 b=TickMath.getSqrtPriceAtTick(center+500);
        uint256 unit0=Math.ceilDiv(Math.mulDiv(uint256(1e18)<<96,b-sqrt,b,Math.Rounding.Ceil),sqrt);
        uint256 unit1=Math.mulDiv(1e18,sqrt-a,1<<96,Math.Rounding.Ceil);
        ratio=Math.mulDiv(unit0,1e18,unit1);
        cash=_available(stable);tokens=_available(IERC20(address(tyw)));
        uint256 value=cash+Math.mulDiv(tokens,nav,1e18);
        require(value>=MIN_VALUE,"inventory");
        if(value>MAX_VALUE){cash=Math.mulDiv(cash,MAX_VALUE,value);tokens=Math.mulDiv(tokens,MAX_VALUE,value);}
    }
    function _imbalance(uint256 cash,uint256 tokens,uint256 ratio) private pure returns(uint256){
        uint256 other=Math.mulDiv(tokens,ratio,1e18);uint256 sum=cash+other;
        return sum==0?0:Math.mulDiv(cash>other?cash-other:other-cash,10000,sum);
    }
    /// buyBudget=0 means redeem shares; shares=0 means add an already balanced tranche.
    function provide(uint256 buyBudget,uint256 shares,uint256[4] calldata limits,uint256 deadline) external nonReentrant returns(uint256 id){
        require(deadline>=block.timestamp&&deadline<=block.timestamp+120,"deadline");
        (uint256 cash,uint256 tokens,uint256 nav,uint256 ratio)=inventory();
        uint256 old0=stable.balanceOf(address(this));uint256 old1=tyw.balanceOf(address(this));
        if(cash>0)stable.safeTransferFrom(treasury,address(this),cash);
        if(tokens>0)IERC20(address(tyw)).safeTransferFrom(treasury,address(this),tokens);
        require(stable.balanceOf(address(this))==old0+cash&&tyw.balanceOf(address(this))==old1+tokens,"transfer");
        uint256 beforeValue=cash+Math.mulDiv(tokens,nav,1e18);
        if(shares>0){
            require(_imbalance(cash,tokens,ratio)>BALANCE_TOLERANCE_BPS,"already balanced");
            if(buyBudget>0){
                require(cash>Math.mulDiv(tokens,ratio,1e18)&&buyBudget<=cash,"buy direction");
                stable.forceApprove(address(tyw),buyBudget);
                tyw.buy(buyBudget,shares,limits,deadline);
                stable.forceApprove(address(tyw),0);
            }else{
                require(cash<Math.mulDiv(tokens,ratio,1e18)&&shares<=tokens,"sell direction");
                tyw.sell(shares,0,limits,deadline);
            }
        }else require(buyBudget==0,"shares");
        uint256 after0=stable.balanceOf(address(this))-old0;uint256 after1=tyw.balanceOf(address(this))-old1;
        require(after0+Math.mulDiv(after1,nav,1e18)>=Math.mulDiv(beforeValue,10000-MAX_LOSS_BPS,10000),"conversion loss");
        require(_imbalance(after0,after1,ratio)<=BALANCE_TOLERANCE_BPS,"unbalanced quote");
        if(after0>0)stable.safeTransfer(treasury,after0);if(after1>0)IERC20(address(tyw)).safeTransfer(treasury,after1);
        id=matched.add(); // Atomic with conversion; LP NFT goes directly to treasury.
        require(stable.balanceOf(address(this))==old0&&tyw.balanceOf(address(this))==old1,"residual");
        emit Provided(msg.sender,id,after0,after1,buyBudget>0,shares);
    }
}
