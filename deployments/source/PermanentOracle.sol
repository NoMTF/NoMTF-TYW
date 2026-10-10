// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IPermanentPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function observe(uint32[] calldata) external view returns (int56[] memory, uint160[] memory);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
}
interface IPermanentFactory {
    function getPool(address,address,uint24) external view returns (address);
}
interface IPermanentOracle {
    function stable() external view returns(address);
    function assets(uint256) external view returns(address);
    function pools(uint256) external view returns(address);
    function prices() external view returns(uint256[4] memory);
}

/// @notice Immutable pool-specific 30-minute / 60-minute TWAP. No manual price signer.
/// Missing history, low harmonic liquidity or >2% window disagreement fails closed.
/// This is a DEX oracle, not an independent issuer NAV or a USDT/USD peg oracle.
contract PermanentOracle is IPermanentOracle {
    address public immutable stable;
    address[4] public assets;
    address[4] public pools;
    uint128[4] public minimumLiquidity;
    constructor(address s, address[4] memory a, address[4] memory p, address factory, uint128[4] memory floors) {
        require(s.code.length>0 && factory.code.length>0, "config");
        stable=s;
        for(uint256 i; i<4; ++i) {
            IPermanentPool pool=IPermanentPool(p[i]);
            require(a[i]!=s && a[i].code.length>0 && floors[i]>0, "asset");
            require(IPermanentFactory(factory).getPool(s,a[i],pool.fee())==p[i], "factory");
            require((pool.token0()==s && pool.token1()==a[i]) || (pool.token1()==s && pool.token0()==a[i]), "pair");
            for(uint256 j; j<i; ++j) require(a[i]!=a[j], "duplicate");
            assets[i]=a[i]; pools[i]=p[i]; minimumLiquidity[i]=floors[i];
        }
    }
    function quoteAtTick(int24 tick,address base,address quote,uint128 amount) public pure returns(uint256) {
        uint160 sqrt=TickMath.getSqrtPriceAtTick(tick);
        if(sqrt<=type(uint128).max) {
            uint256 ratio=uint256(sqrt)*sqrt;
            return base<quote ? Math.mulDiv(ratio,amount,1<<192) : Math.mulDiv(1<<192,amount,ratio);
        }
        uint256 ratio128=Math.mulDiv(sqrt,sqrt,1<<64);
        return base<quote ? Math.mulDiv(ratio128,amount,1<<128) : Math.mulDiv(1<<128,amount,ratio128);
    }
    function _tick(int56 end,int56 start,int56 seconds_) private pure returns(int24) {
        int56 difference=end-start;
        int56 mean=difference/seconds_;
        if(difference<0 && difference%seconds_!=0) --mean;
        require(mean>=TickMath.MIN_TICK && mean<=TickMath.MAX_TICK, "tick");
        return int24(mean);
    }
    function prices() external view returns(uint256[4] memory result) {
        uint32[] memory windows=new uint32[](3); windows[0]=3600; windows[1]=1800;
        for(uint256 i; i<4; ++i) {
            (int56[] memory ticks,uint160[] memory secondsPerLiquidity)=IPermanentPool(pools[i]).observe(windows);
            uint160 difference;
            unchecked { difference=secondsPerLiquidity[2]-secondsPerLiquidity[0]; }
            require(difference>0, "liquidity history");
            uint256 harmonic=(uint256(3600)<<128)/difference;
            require(harmonic>=minimumLiquidity[i] && IPermanentPool(pools[i]).liquidity()>=minimumLiquidity[i], "thin pool");
            uint256 hour=quoteAtTick(_tick(ticks[2],ticks[0],3600),assets[i],stable,1e18);
            uint256 half=quoteAtTick(_tick(ticks[2],ticks[1],1800),assets[i],stable,1e18);
            require(hour>0 && half>0 && (half>hour ? half-hour : hour-half)<=hour/50, "unstable oracle");
            result[i]=half;
        }
    }
}
