// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
interface IRelayVault is IERC20 {
 function stable() external view returns(IERC20);
 function buy(uint256,uint256,uint256[4] calldata,uint256) external returns(uint256);
 function sell(uint256,uint256,uint256[4] calldata,uint256) external returns(uint256);
}
/// @notice Candidate only: a BNB-funded executor settles a user's explicitly signed trade and fee.
/// Existing ERC20 allowances are required; this cannot bootstrap approval from a zero-BNB EOA.
/// No owner withdrawals, arbitrary routers, token enumeration or unsigned deductions.
contract GasRelayCandidate is EIP712,ReentrancyGuard {
 using SafeERC20 for IERC20;
 IRelayVault public immutable vault;IERC20 public immutable stable;
 mapping(address=>uint256) public nonces;
 bytes32 public constant TYPEHASH=keccak256("TradeRequest(address owner,address executor,uint8 mode,uint8 feeAsset,uint256 budget,uint256 shares,bytes32 limitsHash,uint256 minNetStable,uint256 fee,uint256 nonce,uint256 deadline)");
 struct TradeRequest {address owner;address executor;uint8 mode;uint8 feeAsset;uint256 budget;uint256 shares;uint256[4] limits;uint256 minNetStable;uint256 fee;uint256 nonce;uint256 deadline;}
 event Settled(address indexed owner,address indexed executor,uint256 nonce,uint8 mode,uint8 feeAsset,uint256 fee,uint256 stablePaid,uint256 sharesPaid);
 constructor(address v) EIP712("NoMTF Gas Relay","1") {require(v.code.length>0,"vault");vault=IRelayVault(v);stable=vault.stable();require(address(stable).code.length>0,"stable");}
 function digest(TradeRequest calldata r) public view returns(bytes32){return _hashTypedDataV4(keccak256(abi.encode(TYPEHASH,r.owner,r.executor,r.mode,r.feeAsset,r.budget,r.shares,keccak256(abi.encode(r.limits)),r.minNetStable,r.fee,r.nonce,r.deadline)));}
 function cancel(uint256 nextNonce) external {require(nextNonce>nonces[msg.sender],"nonce");nonces[msg.sender]=nextNonce;}
 // Address-only ERC-1271 verification avoids ERC-7913's Cancun-only Bytes dependency.
 function validSignature(address signer,bytes32 hash,bytes calldata signature) private view returns(bool){
  if(signer.code.length==0){(address recovered,ECDSA.RecoverError err,)=ECDSA.tryRecover(hash,signature);return err==ECDSA.RecoverError.NoError&&recovered==signer;}
  (bool success,bytes memory result)=signer.staticcall(abi.encodeCall(IERC1271.isValidSignature,(hash,signature)));
  return success&&result.length>=32&&abi.decode(result,(bytes32))==bytes32(IERC1271.isValidSignature.selector);
 }
 function execute(TradeRequest calldata r,bytes calldata signature) external nonReentrant {
  require(r.owner!=address(0)&&r.executor==msg.sender&&r.owner!=address(this)&&r.mode<=1&&r.feeAsset<=1,"request");
  require(r.nonce==nonces[r.owner]&&block.timestamp<=r.deadline&&r.deadline<=block.timestamp+1800,"nonce/deadline");
  require(r.shares>0&&validSignature(r.owner,digest(r),signature),"signature");
  nonces[r.owner]=r.nonce+1;uint256 oldStable=stable.balanceOf(address(this));uint256 oldShares=vault.balanceOf(address(this));
  uint256 stablePaid;uint256 sharesPaid;
  if(r.mode==0){
   require(r.budget>0&&r.minNetStable==0&&(r.feeAsset==0||r.fee<r.shares),"buy");
   uint256 funding=r.budget+(r.feeAsset==0?r.fee:0);stable.safeTransferFrom(r.owner,address(this),funding);require(stable.balanceOf(address(this))==oldStable+funding,"funding");
   stable.forceApprove(address(vault),r.budget);vault.buy(r.budget,r.shares,r.limits,r.deadline);stable.forceApprove(address(vault),0);
   require(vault.balanceOf(address(this))==oldShares+r.shares,"shares");
   if(r.fee>0)(r.feeAsset==0?stable:IERC20(address(vault))).safeTransfer(r.executor,r.fee);
   sharesPaid=r.shares-(r.feeAsset==1?r.fee:0);IERC20(address(vault)).safeTransfer(r.owner,sharesPaid);
   stablePaid=stable.balanceOf(address(this))-oldStable;if(stablePaid>0)stable.safeTransfer(r.owner,stablePaid);
  }else{
   require(r.budget==0&&(r.feeAsset==0||r.fee<r.shares),"sell");IERC20(address(vault)).safeTransferFrom(r.owner,address(this),r.shares);require(vault.balanceOf(address(this))==oldShares+r.shares,"funding");
   uint256 redeem=r.shares-(r.feeAsset==1?r.fee:0);if(r.feeAsset==1&&r.fee>0)IERC20(address(vault)).safeTransfer(r.executor,r.fee);
   vault.sell(redeem,r.minNetStable+(r.feeAsset==0?r.fee:0),r.limits,r.deadline);
   uint256 proceeds=stable.balanceOf(address(this))-oldStable;stablePaid=proceeds-(r.feeAsset==0?r.fee:0);require(stablePaid>=r.minNetStable,"minimum net");
   if(r.feeAsset==0&&r.fee>0)stable.safeTransfer(r.executor,r.fee);if(stablePaid>0)stable.safeTransfer(r.owner,stablePaid);
  }
  require(stable.balanceOf(address(this))==oldStable&&vault.balanceOf(address(this))==oldShares,"existing funds");emit Settled(r.owner,r.executor,r.nonce,r.mode,r.feeAsset,r.fee,stablePaid,sharesPaid);
 }
}
