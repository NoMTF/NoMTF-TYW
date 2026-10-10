// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPermanentPool,IPermanentOracle} from "./PermanentOracle.sol";

/// @notice Four actual assets, initially bought using the first buyer's USDT.
/// No owner seed, pre-mint, maker inventory, arbitrary-call router or custody withdrawal.
/// Later minting delivers a proportional basket, preserving existing holders' ownership.
contract PermanentVault is ERC20,Ownable2Step,Pausable,ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant CAP=10_000_000_000e18;
    IERC20 public immutable stable;
    IPermanentOracle public immutable oracle;
    IERC20[4] public assets;
    address[4] public pools;
    uint256 public rebalanceNonce;
    uint256 public lastRebalance;
    uint256 public cumulativeRebalanceCost;
    address private activePool;
    IERC20 private callbackToken;
    uint256 private callbackBudget;
    event Bought(address indexed user,uint256 shares,uint256 spent,uint256 refund);
    event Redeemed(address indexed user,uint256 shares,uint256 stableOut,bool inKind);
    event Rebalanced(uint256 indexed nonce,uint256 beforeValue,uint256 afterValue);
    constructor(address s,address[4] memory a,address[4] memory p,address o,address administrator) ERC20("NoMTF","TYW") Ownable(administrator) {
        require(s.code.length>0 && IERC20Metadata(s).decimals()==18, "stable");
        oracle=IPermanentOracle(o); require(oracle.stable()==s,"oracle stable"); stable=IERC20(s);
        for(uint256 i; i<4; ++i) {
            require(IERC20Metadata(a[i]).decimals()==18 && oracle.assets(i)==a[i] && oracle.pools(i)==p[i],"oracle pair");
            assets[i]=IERC20(a[i]); pools[i]=p[i];
        }
        _pause();
    }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function balances() public view returns(uint256[4] memory b) { for(uint256 i; i<4; ++i) b[i]=assets[i].balanceOf(address(this)); }
    function previewMint(uint256 shares) public view returns(uint256[4] memory required,uint256 requiredStable) {
        uint256 supply=totalSupply(); require(supply>0 && shares>0,"supply");
        for(uint256 i; i<4; ++i) required[i]=Math.mulDiv(assets[i].balanceOf(address(this)),shares,supply,Math.Rounding.Ceil);
        requiredStable=Math.mulDiv(stable.balanceOf(address(this)),shares,supply,Math.Rounding.Ceil);
    }
    function previewRedeem(uint256 shares) public view returns(uint256[4] memory amounts,uint256 stableOut) {
        uint256 supply=totalSupply(); require(supply>0 && shares>0 && shares<=supply,"shares");
        for(uint256 i; i<4; ++i) amounts[i]=Math.mulDiv(assets[i].balanceOf(address(this)),shares,supply);
        stableOut=Math.mulDiv(stable.balanceOf(address(this)),shares,supply);
    }
    function _value(uint256[4] memory b,uint256[4] memory prices,uint256 cash) internal pure returns(uint256 v,uint256[4] memory weights) {
        uint256[4] memory values;
        v=cash;
        for(uint256 i; i<4; ++i) { values[i]=Math.mulDiv(b[i],prices[i],1e18); v+=values[i]; }
        if(v>0) for(uint256 i; i<4; ++i) weights[i]=Math.mulDiv(values[i],10000,v);
    }
    function valuation() external view returns(uint256 value,uint256 perShare,uint256[4] memory weights,uint256[4] memory prices) {
        prices=oracle.prices(); (value,weights)=_value(balances(),prices,stable.balanceOf(address(this)));
        uint256 supply=totalSupply(); perShare=supply==0 ? 0 : Math.mulDiv(value,1e18,supply);
    }
    function _deadline(uint256 deadline) internal view { require(block.timestamp<=deadline && deadline<=block.timestamp+1800,"deadline"); }
    /// @dev For the first mint shares must equal the USDT budget; this is nominal shares, not a $1 NAV promise.
    /// For later mints shares is quoted off-chain via previewMint + exact-output pool quotes.
    /// Limits mean minimum token output on first buy, maximum USDT input per leg thereafter.
    function buy(uint256 budget,uint256 shares,uint256[4] calldata limits,uint256 deadline) external nonReentrant whenNotPaused returns(uint256 spent) {
        _deadline(deadline); require(budget>0 && shares>0 && totalSupply()+shares<=CAP,"amount");
        uint256 beforeStable=stable.balanceOf(address(this));
        uint256[4] memory required; uint256 cashRequired;
        bool first=totalSupply()==0;
        if(first) require(shares==budget,"first shares"); else (required,cashRequired)=previewMint(shares);
        stable.safeTransferFrom(msg.sender,address(this),budget);
        require(stable.balanceOf(address(this))==beforeStable+budget,"transfer");
        spent=_invest(budget,limits,required,cashRequired,first);
        require(stable.balanceOf(address(this))>=beforeStable+cashRequired,"existing cash");
        _mint(msg.sender,shares);
        uint256 refund=budget-spent; if(refund>0) stable.safeTransfer(msg.sender,refund);
        emit Bought(msg.sender,shares,spent,refund);
    }
    /// @dev Snapshot proportional requirements BEFORE collecting any new funds.
    function _invest(uint256 budget,uint256[4] memory limits,uint256[4] memory required,uint256 cashRequired,bool first) internal returns(uint256 spent) {
        if(first) {
            uint256[4] memory bought;
            for(uint256 i; i<4; ++i) { uint256 input=i==3 ? budget-3*(budget/4) : budget/4; require(limits[i]>0,"minimum"); (,bought[i])=_swap(i,true,int256(input),input,limits[i]); }
            uint256[4] memory prices=oracle.prices();
            (uint256 value,uint256[4] memory weights)=_value(bought,prices,0);
            require(value>=budget*9900/10000,"entry cost");
            for(uint256 i; i<4; ++i) require(weights[i]>=2300 && weights[i]<=2700,"entry weights");
            spent=budget;
        } else {
            require(cashRequired<=budget,"cash"); spent=cashRequired;
            for(uint256 i; i<4; ++i) {
                require(required[i]>0 && required[i]<=uint256(type(int256).max) && limits[i]>0 && limits[i]<=budget-spent,"limits");
                (uint256 input,)=_swap(i,true,-int256(required[i]),limits[i],required[i]); spent+=input;
            }
        }
    }
    /// @notice Available during pause and even when the oracle or a DEX is unavailable.
    function redeemInKind(uint256 shares,uint256[4] calldata minimum,uint256 minimumStable) external nonReentrant {
        (uint256[4] memory amounts,uint256 cash)=previewRedeem(shares);
        require(cash>=minimumStable,"cash minimum"); _burn(msg.sender,shares);
        for(uint256 i; i<4; ++i) { require(amounts[i]>=minimum[i],"minimum"); if(amounts[i]>0) assets[i].safeTransfer(msg.sender,amounts[i]); }
        if(cash>0) stable.safeTransfer(msg.sender,cash);
        emit Redeemed(msg.sender,shares,cash,true);
    }
    function sell(uint256 shares,uint256 minimumStable,uint256[4] calldata minimumLegs,uint256 deadline) external nonReentrant whenNotPaused returns(uint256 out) {
        _deadline(deadline); (uint256[4] memory amounts,uint256 cash)=previewRedeem(shares);
        _burn(msg.sender,shares); out=_liquidate(amounts,cash,minimumLegs);
        require(out>=minimumStable && out>0,"exit minimum"); stable.safeTransfer(msg.sender,out);
        emit Redeemed(msg.sender,shares,out,false);
    }
    function _liquidate(uint256[4] memory amounts,uint256 cash,uint256[4] memory minimumLegs) internal returns(uint256 out) {
        out=cash;
        for(uint256 i; i<4; ++i) if(amounts[i]>0) { (,uint256 received)=_swap(i,false,int256(amounts[i]),amounts[i],minimumLegs[i]); out+=received; }
    }
    /// @notice Anyone may submit a bounded restoration. No caller-chosen recipients or gas reimbursements.
    /// User signs actual trades; the monitor only creates proposals.
    function rebalance(uint256 expectedNonce,uint256[4] calldata sellAmounts,uint256[4] calldata minimumSales,uint256[4] calldata buyBudgets,uint256[4] calldata minimumBuys,uint256 deadline) external nonReentrant whenNotPaused {
        _deadline(deadline); require(totalSupply()>0 && expectedNonce==rebalanceNonce && block.timestamp>=lastRebalance+3600,"nonce/cooldown");
        uint256[4] memory prices=oracle.prices();
        (uint256 beforeValue,uint256[4] memory weights)=_value(balances(),prices,stable.balanceOf(address(this)));
        bool triggered; for(uint256 i; i<4; ++i) if(weights[i]<=1500 || weights[i]>=3500) triggered=true;
        require(triggered,"in band");
        for(uint256 i; i<4; ++i) if(sellAmounts[i]>0) { require(sellAmounts[i]<=assets[i].balanceOf(address(this)) && buyBudgets[i]==0,"sale"); _swap(i,false,int256(sellAmounts[i]),sellAmounts[i],minimumSales[i]); }
        for(uint256 i; i<4; ++i) if(buyBudgets[i]>0) { require(buyBudgets[i]<=stable.balanceOf(address(this)) && minimumBuys[i]>0,"buy"); _swap(i,true,int256(buyBudgets[i]),buyBudgets[i],minimumBuys[i]); }
        (uint256 afterValue,uint256[4] memory finalWeights)=_value(balances(),prices,stable.balanceOf(address(this)));
        require(afterValue>=beforeValue*9975/10000,"rebalance loss");
        for(uint256 i; i<4; ++i) require(finalWeights[i]>=2485 && finalWeights[i]<=2515,"restore");
        if(beforeValue>afterValue) cumulativeRebalanceCost+=beforeValue-afterValue;
        ++rebalanceNonce; lastRebalance=block.timestamp;
        emit Rebalanced(expectedNonce,beforeValue,afterValue);
    }
    function _swap(uint256 i,bool buy_,int256 specified,uint256 maximum,uint256 minimum) internal returns(uint256 paid,uint256 received) {
        require(specified!=0 && maximum<=uint256(type(int256).max),"swap amount");
        IERC20 input=buy_ ? stable : assets[i]; IERC20 output=buy_ ? assets[i] : stable;
        uint256 beforeIn=input.balanceOf(address(this)); uint256 beforeOut=output.balanceOf(address(this));
        require(maximum<=beforeIn,"balance");
        activePool=pools[i]; callbackToken=input; callbackBudget=maximum;
        bool zeroForOne=address(input)<address(output);
        IPermanentPool(activePool).swap(address(this),zeroForOne,specified,zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341,"");
        activePool=address(0); callbackToken=IERC20(address(0)); callbackBudget=0;
        paid=beforeIn-input.balanceOf(address(this)); received=output.balanceOf(address(this))-beforeOut;
        require(paid<=maximum && received>=minimum,"slippage");
        if(specified>0) require(paid==uint256(specified),"partial input"); else require(received==uint256(-specified),"partial output");
    }
    function pancakeV3SwapCallback(int256 amount0,int256 amount1,bytes calldata) external {
        require(msg.sender==activePool && activePool!=address(0),"pool callback");
        bool firstToken=address(callbackToken)==IPermanentPool(msg.sender).token0();
        int256 owed=firstToken ? amount0 : amount1; int256 other=firstToken ? amount1 : amount0;
        require(owed>0 && other<=0 && uint256(owed)<=callbackBudget,"callback budget");
        callbackBudget-=uint256(owed); callbackToken.safeTransfer(msg.sender,uint256(owed));
    }
}
