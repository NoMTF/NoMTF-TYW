// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InfinityPoolKey} from "./PoolSpreadHook.sol";
interface IFeePositions {
    function ownerOf(uint256) external view returns(address);
    function getPoolAndPositionInfo(uint256) external view returns(InfinityPoolKey memory,uint256);
    function modifyLiquidities(bytes calldata,uint256) external payable;
}
/// @notice Collects fees with ZERO liquidity change, exclusively to the fixed treasury.
/// NFT approval gives this contract no exposed path to withdraw principal or transfer NFTs.
contract TreasuryFeeCollector is ReentrancyGuard {
    address public immutable treasury;
    IFeePositions public immutable positions;
    IERC20 public immutable stable;
    IERC20 public immutable tyw;
    address public immutable manager;
    event Collected(uint256 usdt,uint256 tyw);
    constructor(address owner,address p,address s,address t,address m){
        require(owner!=address(0)&&p.code.length>0&&s.code.length>0&&t.code.length>0&&m.code.length>0,"configuration");
        treasury=owner;positions=IFeePositions(p);stable=IERC20(s);tyw=IERC20(t);manager=m;
    }
    function collect(uint256[] calldata ids) external nonReentrant returns(uint256 cash,uint256 tokens){
        require(ids.length>0&&ids.length<=32,"positions");
        uint256 before0=stable.balanceOf(treasury);uint256 before1=tyw.balanceOf(treasury);
        bytes memory actions=new bytes(ids.length+1);bytes[] memory args=new bytes[](ids.length+1);
        for(uint256 i;i<ids.length;i++){
            require(i==0||ids[i]>ids[i-1],"order");
            require(positions.ownerOf(ids[i])==treasury,"owner");
            (InfinityPoolKey memory key,)=positions.getPoolAndPositionInfo(ids[i]);
            require(key.currency0==address(stable)&&key.currency1==address(tyw)&&key.poolManager==manager,"pair");
            actions[i]=bytes1(uint8(0)); // CL_INCREASE_LIQUIDITY with 0: claim fees only.
            args[i]=abi.encode(ids[i],uint256(0),uint128(0),uint128(0),bytes(""));
        }
        actions[ids.length]=bytes1(uint8(0x11)); // TAKE_PAIR: recipient cannot be chosen by caller.
        args[ids.length]=abi.encode(address(stable),address(tyw),treasury);
        positions.modifyLiquidities(abi.encode(actions,args),block.timestamp+120);
        cash=stable.balanceOf(treasury)-before0;tokens=tyw.balanceOf(treasury)-before1;
        emit Collected(cash,tokens);
    }
}
