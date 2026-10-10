// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {PermanentVault} from "./PermanentVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice Candidate for lower-cost settlement. Orders stay unfunded until execution.
/// Each user approves only USDT; a signed sell burns their own shares without a second approval.
/// Executor fees are explicit USDT amounts authorized by the user, not a claim of free gas.
/// This candidate is distinct from the already deployed four-asset vault.
contract PermanentBatchVault is PermanentVault,EIP712 {
    using SafeERC20 for IERC20;
    struct Order {
        address user;
        bool redeem;
        uint256 amount;
        uint256 minimum;
        uint256 maxFee;
        uint256 nonce;
        uint256 deadline;
        address executor;
    }
    struct BuyState {
        uint256 beforeStable;
        uint256 cashRequired;
        uint256 gross;
        uint256 totalFee;
        uint256 budget;
        uint256 shares;
        uint256 refund;
        uint256 prefix;
        uint256 allocated;
        uint256 refunded;
        bool first;
    }
    bytes32 public constant ORDER_TYPEHASH=keccak256("Order(address user,bool redeem,uint256 amount,uint256 minimum,uint256 maxFee,uint256 nonce,uint256 deadline,address executor)");
    uint256 public constant MAX_BATCH=64;
    mapping(address=>uint256) public orderNonces;
    event OrderSettled(address indexed user,uint256 indexed nonce,bool redeem,uint256 input,uint256 output,uint256 fee,uint256 refund);
    event NonceInvalidated(address indexed user,uint256 nonce);
    constructor(address s,address[4] memory a,address[4] memory p,address o,address administrator)
        PermanentVault(s,a,p,o,administrator) EIP712("NoMTF Batch","1") {}
    function orderDigest(Order calldata order) public view returns(bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH,order.user,order.redeem,order.amount,order.minimum,order.maxFee,order.nonce,order.deadline,order.executor)));
    }
    /// @notice Cancels every previously signed order below newNonce, including during pause.
    function invalidateNonce(uint256 newNonce) external nonReentrant {
        require(newNonce>orderNonces[msg.sender],"nonce");
        orderNonces[msg.sender]=newNonce; emit NonceInvalidated(msg.sender,newNonce);
    }
    function _authorize(Order calldata order,bytes calldata signature,uint256 fee,bool redeem) private {
        require(order.user!=address(0) && order.redeem==redeem && order.amount>0 && order.minimum>0,"order");
        require(order.executor==address(0) || order.executor==msg.sender,"executor");
        require(order.deadline>=block.timestamp && order.deadline<=block.timestamp+2 days,"order deadline");
        require(order.nonce==orderNonces[order.user] && fee<=order.maxFee,"nonce/fee");
        bytes32 digest=orderDigest(order);
        if(order.user.code.length==0) {
            (address recovered,ECDSA.RecoverError error,)=ECDSA.tryRecover(digest,signature);
            require(error==ECDSA.RecoverError.NoError && recovered==order.user,"signature");
        } else {
            (bool success,bytes memory result)=order.user.staticcall(abi.encodeCall(IERC1271.isValidSignature,(digest,signature)));
            require(success && result.length>=32 && abi.decode(result,(bytes32))==bytes32(IERC1271.isValidSignature.selector),"signature");
        }
        orderNonces[order.user]=order.nonce+1;
    }
    function _batchLength(uint256 n,uint256 signatures,uint256 fees) private pure {
        require(n>0 && n<=MAX_BATCH && n==signatures && n==fees,"batch");
    }
    /// @dev Limits follow buy(): first mint = min asset output; later = max stable input.
    function settleBuys(Order[] calldata orders,bytes[] calldata signatures,uint256[] calldata fees,uint256 shares,uint256[4] calldata limits,uint256 deadline) external nonReentrant whenNotPaused {
        _deadline(deadline); _batchLength(orders.length,signatures.length,fees.length);
        require(shares>0 && totalSupply()+shares<=CAP,"shares");
        BuyState memory s; s.first=totalSupply()==0; s.shares=shares;
        s.beforeStable=stable.balanceOf(address(this));
        uint256[4] memory required;
        if(!s.first) (required,s.cashRequired)=previewMint(shares);
        for(uint256 i;i<orders.length;++i) {
            Order calldata order=orders[i]; _authorize(order,signatures[i],fees[i],false);
            require(order.amount>fees[i],"budget"); s.gross+=order.amount; s.totalFee+=fees[i];
            stable.safeTransferFrom(order.user,address(this),order.amount);
        }
        require(stable.balanceOf(address(this))==s.beforeStable+s.gross,"transfer");
        s.budget=s.gross-s.totalFee;
        if(s.first) require(shares==s.budget,"first shares");
        s.refund=s.budget-_invest(s.budget,limits,required,s.cashRequired,s.first);
        _allocateBuys(orders,fees,s);
        if(s.totalFee>0) stable.safeTransfer(msg.sender,s.totalFee);
        require(stable.balanceOf(address(this))==s.beforeStable+s.cashRequired,"existing cash");
    }
    function _allocateBuys(Order[] calldata orders,uint256[] calldata fees,BuyState memory s) private {
        for(uint256 i;i<orders.length;++i) {
            Order calldata order=orders[i]; s.prefix+=order.amount-fees[i];
            uint256 next= Math.mulDiv(s.shares,s.prefix,s.budget); uint256 output=next-s.allocated; s.allocated=next;
            uint256 nextRefund=Math.mulDiv(s.refund,s.prefix,s.budget); uint256 userRefund=nextRefund-s.refunded; s.refunded=nextRefund;
            require(output>=order.minimum,"user minimum"); _mint(order.user,output);
            if(userRefund>0) stable.safeTransfer(order.user,userRefund);
            emit OrderSettled(order.user,order.nonce,false,order.amount,output,fees[i],userRefund);
        }
    }
    /// @notice The signature authorizes burning only the signer's amount and paying their address.
    function settleSells(Order[] calldata orders,bytes[] calldata signatures,uint256[] calldata fees,uint256[4] calldata minimumLegs,uint256 deadline) external nonReentrant whenNotPaused {
        _deadline(deadline); _batchLength(orders.length,signatures.length,fees.length);
        uint256 totalShares; uint256 totalFee;
        for(uint256 i;i<orders.length;++i) {
            _authorize(orders[i],signatures[i],fees[i],true);
            totalShares+=orders[i].amount; totalFee+=fees[i];
        }
        (uint256[4] memory amounts,uint256 cash)=previewRedeem(totalShares);
        uint256 beforeStable=stable.balanceOf(address(this));
        for(uint256 i;i<orders.length;++i) _burn(orders[i].user,orders[i].amount);
        uint256 proceeds=_liquidate(amounts,cash,minimumLegs);
        uint256 prefix; uint256 allocated;
        for(uint256 i;i<orders.length;++i) {
            Order calldata order=orders[i]; prefix+=order.amount;
            uint256 next=Math.mulDiv(proceeds,prefix,totalShares); uint256 gross=next-allocated; allocated=next;
            require(gross>=fees[i] && gross-fees[i]>=order.minimum,"user minimum");
            stable.safeTransfer(order.user,gross-fees[i]);
            emit OrderSettled(order.user,order.nonce,true,order.amount,gross-fees[i],fees[i],0);
        }
        if(totalFee>0) stable.safeTransfer(msg.sender,totalFee);
        require(stable.balanceOf(address(this))==beforeStable-cash,"existing cash");
    }
}
