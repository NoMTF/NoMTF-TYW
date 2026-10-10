// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPermanentOracle} from "./PermanentOracle.sol";
interface IPermanentCallback { function pancakeV3SwapCallback(int256,int256,bytes calldata) external; }
contract PermanentMockPool {
    address public immutable token0;
    address public immutable token1;
    address public immutable stable;
    address public immutable asset;
    uint24 public immutable fee;
    uint256 public price;
    uint8 public mode;
    uint128 public liquidity=1e24;
    int24 public tick;
    bool public missingHistory;
    constructor(address s,address a,uint256 p,uint24 f) { stable=s; asset=a; price=p; fee=f; (token0,token1)=s<a ? (s,a) : (a,s); }
    function setPrice(uint256 p) external { price=p; }
    function setMode(uint8 m) external { mode=m; }
    function setOracle(int24 t,uint128 l,bool missing) external { tick=t; liquidity=l; missingHistory=missing; }
    function observe(uint32[] calldata windows) external view returns(int56[] memory ticks,uint160[] memory secondsPerLiquidity) {
        require(!missingHistory,"history"); ticks=new int56[](windows.length); secondsPerLiquidity=new uint160[](windows.length);
        for(uint256 i; i<windows.length; ++i) { ticks[i]=int56(tick)*int56(uint56(block.timestamp-windows[i])); secondsPerLiquidity[i]=uint160((uint256(block.timestamp-windows[i])<<128)/liquidity); }
    }
    function swap(address to,bool zero,int256 specified,uint160,bytes calldata data) external returns(int256 d0,int256 d1) {
        address input=zero ? token0 : token1; address output=zero ? token1 : token0;
        bool buy=input==stable; uint256 paid; uint256 received;
        if(specified>0) { paid=uint256(specified); uint256 net=paid*(1e6-fee)/1e6; received=buy ? Math.mulDiv(net,1e18,price) : Math.mulDiv(net,price,1e18); }
        else { received=uint256(-specified); uint256 net=buy ? Math.mulDiv(received,price,1e18,Math.Rounding.Ceil) : Math.mulDiv(received,1e18,price,Math.Rounding.Ceil); paid=Math.mulDiv(net,1e6,1e6-fee,Math.Rounding.Ceil); }
        if(mode==1) { paid/=2; received/=2; }
        if(mode==2) paid*=2;
        if(mode==3) received=0;
        if(mode==4) revert("pool unavailable");
        d0=zero ? int256(paid) : -int256(received); d1=zero ? -int256(received) : int256(paid);
        uint256 beforeInput=IERC20(input).balanceOf(address(this));
        if(received>0) require(IERC20(output).transfer(to,received));
        IPermanentCallback(msg.sender).pancakeV3SwapCallback(d0,d1,data);
        if(mode==5) IPermanentCallback(msg.sender).pancakeV3SwapCallback(d0,d1,data);
        require(IERC20(input).balanceOf(address(this))>=beforeInput+paid,"unpaid");
    }
}
contract PermanentMockOracle is IPermanentOracle {
    address public immutable stable;
    address[4] public assets;
    address[4] public pools;
    uint256[4] private marks;
    bool public broken;
    constructor(address s,address[4] memory a,address[4] memory p,uint256[4] memory q) { stable=s; assets=a; pools=p; marks=q; }
    function setPrices(uint256[4] calldata p) external { marks=p; }
    function setBroken(bool b) external { broken=b; }
    function prices() external view returns(uint256[4] memory) { require(!broken,"oracle unavailable"); return marks; }
}
contract PermanentMockFactory {
    mapping(bytes32=>address) private entries;
    function setPool(address a,address b,uint24 fee,address pool) external { entries[keccak256(abi.encode(a<b?a:b,a<b?b:a,fee))]=pool; }
    function getPool(address a,address b,uint24 fee) external view returns(address) { return entries[keccak256(abi.encode(a<b?a:b,a<b?b:a,fee))]; }
}
contract PermanentMockWallet {
    address public immutable signer;
    bool public revoked;
    constructor(address s) { signer=s; }
    function setRevoked(bool b) external { require(msg.sender==signer); revoked=b; }
    function isValidSignature(bytes32 digest,bytes calldata signature) external view returns(bytes4) {
        (address recovered,ECDSA.RecoverError error,)=ECDSA.tryRecover(digest,signature);
        return !revoked && error==ECDSA.RecoverError.NoError && recovered==signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
    function execute(address target,bytes calldata data) external {
        require(msg.sender==signer); (bool success,)=target.call(data); require(success);
    }
}
