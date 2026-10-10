// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
struct InfinityPoolKey {address currency0;address currency1;address hooks;address poolManager;uint24 fee;bytes32 parameters;}
struct InfinitySwapParams {bool zeroForOne;int256 amountSpecified;uint160 sqrtPriceLimitX96;}
/// @notice Immutable, pool-only LP fees. Does not tax ERC20 transfers or vault issuance/redemption.
contract PoolSpreadHook {
    address public immutable manager;address public immutable stable;address public immutable tyw;address public immutable treasury;
    uint24 public constant BUY_FEE_PPM=47619;
    uint24 public constant SELL_FEE_PPM=50000;
    bytes32 public constant PARAMETERS=bytes32(uint256((10<<16)|(1<<6)|1));
    constructor(address m,address s,address t,address owner){require(m.code.length>0&&s.code.length>0&&t.code.length>0&&s<t&&owner!=address(0),"configuration");manager=m;stable=s;tyw=t;treasury=owner;}
    function getHooksRegistrationBitmap() external pure returns(uint16){return (1<<6)|1;}
    function beforeInitialize(address sender,InfinityPoolKey calldata key,uint160) external view returns(bytes4){
        require(msg.sender==manager&&sender==treasury,"initializer");_pool(key);return this.beforeInitialize.selector;
    }
    function _pool(InfinityPoolKey calldata key) internal view {require(key.currency0==stable&&key.currency1==tyw&&key.hooks==address(this)&&key.poolManager==manager&&key.fee==0x800000&&key.parameters==PARAMETERS,"pool");}
    function beforeSwap(address,InfinityPoolKey calldata key,InfinitySwapParams calldata params,bytes calldata) external view returns(bytes4,int256,uint24){
        require(msg.sender==manager,"manager");
        _pool(key);
        return(this.beforeSwap.selector,0,0x400000|(params.zeroForOne?BUY_FEE_PPM:SELL_FEE_PPM));
    }
}
