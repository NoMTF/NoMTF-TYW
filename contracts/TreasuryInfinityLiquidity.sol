// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSpreadHook,InfinityPoolKey} from "./PoolSpreadHook.sol";
interface ITreasuryVault is IERC20 {function stable() external view returns(address);function valuation() external view returns(uint256,uint256,uint256[4] memory,uint256[4] memory);function paused() external view returns(bool);}
interface IInfinityManager {function getSlot0(bytes32) external view returns(uint160,int24,uint24,uint24);function initialize(InfinityPoolKey calldata,uint160) external returns(int24);}
interface IInfinityPositionManager {
    function clPoolManager() external view returns(address);function permit2() external view returns(address);
    function nextTokenId() external view returns(uint256);function ownerOf(uint256) external view returns(address);
    function modifyLiquidities(bytes calldata,uint256) external payable;
}
interface ILiquidityPermit2 {function approve(address,address,uint160,uint48) external;}
/// @notice Permissionless matching of future treasury inventory into a single immutable pool.
/// New position NFTs go directly to treasury; no withdrawal/custody/arbitrary-call authority.
contract TreasuryInfinityLiquidity is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant Q96=1<<96;
    ITreasuryVault public immutable tyw;IERC20 public immutable stable;
    IInfinityManager public immutable manager;IInfinityPositionManager public immutable positions;
    ILiquidityPermit2 public immutable permit2;address public immutable treasury;address public immutable hook;
    bytes32 public immutable poolId;bool public enabled=true;
    uint256 public constant MIN_STABLE=5e17;uint256 public constant MAX_STABLE=1000e18;
    uint256 public constant PRICE_TOLERANCE_BPS=500;
    event Added(address indexed trigger,uint256 indexed tokenId,uint256 usdt,uint256 tyw,uint128 liquidity);
    event Enabled(bool enabled);
    constructor(address t,address s,address p,address h,address owner){
        require(t.code.length>0&&s.code.length>0&&p.code.length>0&&h.code.length>0&&owner!=address(0)&&s<t,"configuration");
        tyw=ITreasuryVault(t);stable=IERC20(s);positions=IInfinityPositionManager(p);treasury=owner;hook=h;
        manager=IInfinityManager(positions.clPoolManager());permit2=ILiquidityPermit2(positions.permit2());
        require(tyw.stable()==s&&address(manager).code.length>0&&address(permit2).code.length>0,"configuration");
        require(PoolSpreadHook(h).manager()==address(manager)&&PoolSpreadHook(h).stable()==s&&PoolSpreadHook(h).tyw()==t&&PoolSpreadHook(h).treasury()==owner,"hook");
        poolId=keccak256(abi.encode(poolKey()));
    }
    function poolKey() public view returns(InfinityPoolKey memory){return InfinityPoolKey(address(stable),address(tyw),hook,address(manager),0x800000,bytes32(uint256((10<<16)|(1<<6)|1)));}
    function setEnabled(bool value) external {require(msg.sender==treasury,"treasury");enabled=value;emit Enabled(value);}
    function _available(IERC20 token) internal view returns(uint256){return Math.min(token.balanceOf(treasury),token.allowance(treasury,address(this)));}
    function preview() public view returns(uint128 liquidity,uint128 usdt,uint128 tokens,int24 lower,int24 upper){
        require(enabled&&!tyw.paused(),"disabled");
        (uint160 sqrt,int24 tick,,)=manager.getSlot0(poolId);require(sqrt>0,"uninitialized");
        (,uint256 nav,,)=tyw.valuation();require(nav>0&&nav<=1000e18,"nav");
        uint256 price=Math.mulDiv(Q96,1e18,Math.mulDiv(sqrt,sqrt,Q96));
        require(price*10000>=nav*9500&&price*10000<=nav*10500,"pool price differs from NAV");
        int24 center=tick/10*10;if(tick<0&&tick%10!=0)center-=10;lower=center-500;upper=center+500;
        uint160 a=TickMath.getSqrtPriceAtTick(lower);uint160 b=TickMath.getSqrtPriceAtTick(upper);
        uint256 bal0=Math.min(_available(stable),MAX_STABLE);uint256 bal1=_available(IERC20(address(tyw)));
        // Amounts and liquidity use round-down math; explicit one-unit margin makes max-in robust.
        uint256 l0=Math.mulDiv(bal0,Math.mulDiv(sqrt,b,Q96),b-sqrt);
        uint256 l1=Math.mulDiv(bal1,Q96,sqrt-a);
        uint256 l=Math.min(l0,l1);require(l>1&&l<=type(uint128).max,"inventory");l-=1;
        liquidity=uint128(l);
        uint256 amt0=Math.ceilDiv(Math.mulDiv(l<<96,b-sqrt,b,Math.Rounding.Ceil),sqrt);
        uint256 amt1=Math.mulDiv(l,sqrt-a,Q96,Math.Rounding.Ceil);
        require(amt0>=MIN_STABLE&&amt0<=bal0&&amt1<=bal1&&amt1<=type(uint128).max,"insufficient matched inventory");
        usdt=uint128(amt0);tokens=uint128(amt1);
    }
    function add() external nonReentrant returns(uint256 id){
        (uint128 liquidity,uint128 usdt,uint128 tokens,int24 lower,int24 upper)=preview();
        uint256 old0=stable.balanceOf(address(this));uint256 old1=tyw.balanceOf(address(this));
        stable.safeTransferFrom(treasury,address(this),usdt);IERC20(address(tyw)).safeTransferFrom(treasury,address(this),tokens);
        require(stable.balanceOf(address(this))==old0+usdt&&tyw.balanceOf(address(this))==old1+tokens,"transfer");
        stable.forceApprove(address(permit2),usdt);IERC20(address(tyw)).forceApprove(address(permit2),tokens);
        permit2.approve(address(stable),address(positions),usdt,uint48(block.timestamp+120));
        permit2.approve(address(tyw),address(positions),tokens,uint48(block.timestamp+120));
        id=positions.nextTokenId();bytes[] memory args=new bytes[](3);
        args[0]=abi.encode(poolKey(),lower,upper,uint256(liquidity),usdt,tokens,treasury,bytes(""));
        args[1]=abi.encode(address(stable));args[2]=abi.encode(address(tyw));
        positions.modifyLiquidities(abi.encode(hex"021212",args),block.timestamp+120);
        require(positions.ownerOf(id)==treasury,"LP owner");
        permit2.approve(address(stable),address(positions),0,0);permit2.approve(address(tyw),address(positions),0,0);
        stable.forceApprove(address(permit2),0);IERC20(address(tyw)).forceApprove(address(permit2),0);
        uint256 refund0=stable.balanceOf(address(this))-old0;uint256 refund1=tyw.balanceOf(address(this))-old1;
        if(refund0>0)stable.safeTransfer(treasury,refund0);if(refund1>0)IERC20(address(tyw)).safeTransfer(treasury,refund1);
        emit Added(msg.sender,id,usdt-refund0,tokens-refund1,liquidity);
    }
}
