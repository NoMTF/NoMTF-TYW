// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPancakeRouter} from "./PancakeV3Adapter.sol";
contract MockToken is ERC20 {
    uint8 private immutable d;
    constructor(string memory n, uint8 precision) ERC20(n,n) { d=precision; }
    function decimals() public view override returns (uint8) { return d; }
    function mint(address to,uint256 n) external { _mint(to,n); }
}
contract MockFactory {
    function getPool(address,address,uint24) external pure returns(address) { return address(0x1234); }
}
contract MockRouter is IPancakeRouter {
    mapping(address=>uint256) public prices;
    address public stable;
    constructor(address s,address[3] memory a,uint256[3] memory p) { stable=s; prices[s]=1e18; for(uint256 i;i<3;++i) prices[a[i]]=p[i]; }
    function setPrice(address token,uint256 price) external { prices[token]=price; }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns(uint256 out) {
        IERC20(p.tokenIn).transferFrom(msg.sender,address(this),p.amountIn);
        uint256 usd=Math.mulDiv(p.amountIn,prices[p.tokenIn],10**IERC20Metadata(p.tokenIn).decimals());
        out=Math.mulDiv(usd,10**IERC20Metadata(p.tokenOut).decimals(),prices[p.tokenOut]);
        require(out>=p.amountOutMinimum);MockToken(p.tokenOut).mint(p.recipient,out);
    }
    function exactOutputSingle(ExactOutputSingleParams calldata p) external payable returns(uint256 used) {
        uint256 usd=Math.mulDiv(p.amountOut,prices[p.tokenOut],10**IERC20Metadata(p.tokenOut).decimals(),Math.Rounding.Ceil);
        used=Math.mulDiv(usd,10**IERC20Metadata(p.tokenIn).decimals(),prices[p.tokenIn],Math.Rounding.Ceil);
        require(used<=p.amountInMaximum);IERC20(p.tokenIn).transferFrom(msg.sender,address(this),used);
        MockToken(p.tokenOut).mint(p.recipient,p.amountOut);
    }
}
contract MockAdapter {
    address public vault; IERC20 public stable; address[3] public assets; uint256[3] public prices;
    uint16 public feeBps; bool public broken; bool public stealPending;
    constructor(address v,address s,address[3] memory a,uint256[3] memory p) { vault=v;stable=IERC20(s);assets=a;prices=p; }
    function setFee(uint16 n) external { feeBps=n; }
    function setBroken(bool n) external { broken=n; }
    function setStealPending(bool n) external { stealPending=n; }
    function setPrices(uint256[3] calldata p) external { prices=p; }
    function buyExact(uint8 i,uint256 out,uint256 maxIn) external returns(uint256 used) {
        require(msg.sender==vault); uint256 unit=10**IERC20Metadata(assets[i]).decimals();
        used=Math.mulDiv(out,prices[i],unit,Math.Rounding.Ceil);
        used=Math.mulDiv(used,10000+feeBps,10000,Math.Rounding.Ceil);
        require(used<=maxIn); stable.transferFrom(vault,address(this),used);
        MockToken(assets[i]).mint(vault,broken?out/2:out);
    }
    function sellExact(uint8 i,uint256 amount,uint256 minOut) external returns(uint256 got) {
        require(msg.sender==vault); IERC20(assets[i]).transferFrom(vault,address(this),amount);
        got=Math.mulDiv(amount,prices[i],10**IERC20Metadata(assets[i]).decimals());
        got=Math.mulDiv(got,10000-feeBps,10000); require(got>=minOut);
        MockToken(address(stable)).mint(vault,got);
    }
}
