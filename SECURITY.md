# Security model

User reserves live exclusively in the non-upgradeable PermanentVault at
`0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7` on chain 56.

- There is no administrator reserve withdrawal, rescue, arbitrary-call, asset replacement,
  oracle replacement, proxy upgrade, or unbacked mint entry point.
- The owner can pause ordinary purchases, sales and rebalances. `redeemInKind` is outside
  that pause gate. Ownership transfer does not create additional powers.
- Ownership is retained for this pause/unpause role, not reserve custody. Renouncing it
  is irreversible: neither pause nor unpause remains callable afterward. Renouncing while
  paused would permanently disable normal trading; in-kind redemption remains available.
- Purchases require real proportional asset delivery before minting. Redemptions burn the
  caller's shares and deliver only their proportional assets to that same caller.
- Rebalance is permissionless but requires an actual threshold crossing, cooldown,
  nonce, fixed pools, at most 0.25% oracle-valued loss, and restoration near 25/25/25/25.
- User reserves and administrator-funded LP are separate. LP positions are treasury-owned
  NFTs; their owner may withdraw them. Provisioning cannot access user reserves except by
  an ordinary, fully backed mint or redemption of treasury-owned shares.

## Automatic liquidity

TreasuryAutoLiquidity uses the existing matched controller and pool. It transiently pulls
only approved treasury balances, converts the excess through the fixed original vault,
then atomically adds liquidity. It permits no arbitrary recipient or arbitrary call.
At most 1,900 USDT of NAV-valued inventory is handled per tranche; the minimum is 1.1 USDT.
Conversion loss cannot exceed 0.5% of tranche value, and resulting imbalance cannot exceed
0.5%. The quote expires within 120 seconds. Conversions of already balanced inventory
are rejected. Temporary vault and Permit2 approvals are cleared; change returns to treasury.

The Worker has a separate gas-only signer, pinned controller runtime hash, immutable
recipient checks, gas-price/unit/spending caps, and durable storage of the signed transaction
before broadcast. Uncertain broadcasts reuse the identical transaction and nonce. Public
HTTP requests cannot invoke the keeper or obtain signatures. The treasury key stays local.
Gas above budget, insufficient gas funds, unsafe prices, expensive conversions or small
inventory postpone additions; funds remain in treasury rather than being discarded.

The automatic minimum is 20 USDT of approved inventory valued at vault NAV, and the padded
gas budget must be at most 0.5% of the addition's value. Contract minima remain unchanged.
The shared gas-only signer caps each operation at 0.00015 BNB and total daily spend at
0.0002 BNB, preserving at least 0.00002 BNB for gas. Fee collection and additions share
these budgets and the same durable pending-transaction journal.

TreasuryFeeCollector accepts only sorted unique batches of up to 32 treasury-owned position
NFTs for the fixed USDT/TYW pair and CL manager. Its only state-changing entry point runs
zero-liquidity increases to collect accrued fees, then pays both tokens to the immutable
treasury. It exposes no NFT transfer, decrease-liquidity, principal withdrawal, arbitrary
recipient/call, upgrade, or owner powers. The treasury grants NFT operator approval and
may revoke it; this approval does not expose a principal-transfer path in this collector.
The Worker pins its runtime hash and recipient, tracks newly minted treasury positions,
and only claims when fees can pay their own bounded gas and combined inventory can qualify
for an addition. Fees do not include the full principal of a user's pool swap.

Claiming and reinvestment are separate transactions, on separate eligible rounds. Successful
collection pays the treasury even if a subsequent quote is unavailable; it never promises
immediate or perpetual liquidity. Idle funds and unclaimed fees wait without being spent.

## Independent exit

Use `public/exit.html` (fully self-contained), the GitHub Pages mirror, a compatible chain
explorer, or `scripts/redeem-calldata.mjs` to prepare `redeemInKind` directly. The page and
script never use xyn.lgbt APIs, price services, DEXes, token approvals or operator signatures.
The script only prints transaction data: the holder must sign in their own wallet.

This ensures an operator-independent proportional claim **while the chain and underlying
token transfers function**. It cannot guarantee issuer solvency, transferable frozen tokens,
USDT liquidity, a dollar floor, or chain availability. An underlying token that reverts its
transfer can make atomic in-kind redemption fail. The current immutable vault cannot be
patched to bypass third-party transfer freezes. Do not describe this as unconditional recovery.

## Source verification and disclosures

`deployments/source/PermanentVault.sol` and `PermanentOracle.sol` are the actual deployed
source archive. The development vault under `contracts/` was later refactored for a batch
candidate; it is not a claim that this development bytecode is deployed. Sourcify and the
read-only bytecode verification report distinguish exact metadata matches from executable
instruction matches. Public code and tests are not a third-party audit or a guarantee that
wallet risk labels disappear.

Report reproducible issues privately through the repository owner's GitHub profile contact
before posting an active exploit. Never send private keys, seeds, full user transactions or
personal information. Tests run on local chains or forks; do not attack users or mainnet pools.
