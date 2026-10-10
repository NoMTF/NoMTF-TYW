# NoMTF / 唐毓文币 · TYW

Website: https://xyn.lgbt/ · BNB Chain (56)

TYW represents proportional ownership of a real four-asset basket: SPYB, TLTon, XAUm,
SGOVon, initially 25% each. These are tokenized representations and retain their issuer,
market and transfer risks. It is also the creator's personal meme token. It is not a
fixed-dollar stablecoin, principal guarantee, investment endorsement or exchange listing.

Direct vault trading on the website has **0% platform fee**. Underlying execution and
network gas are paid by traders. Shares are minted only after actual assets arrive;
redemptions burn shares. NAV changes with the assets; token balances do not rebase.
Hourly monitoring proposes a rebalance only after a 15%/35% threshold is reached. Execution
still requires a transaction; monitoring alone does not trade or pay gas.

## Live contracts and source

| Component | BSC address |
| --- | --- |
| Immutable vault / TYW | 0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7 |
| Fixed on-chain TWAP oracle | 0x178436E1750Be2Bb1fff667245DF80c77D89Bb97 |
| Immutable external pool fee hook | 0xC146249412d9eB47a5e6719b29fE37e443fB4870 |
| Matched LP provisioner | 0x9722A21a3df964A4Dce56E23AfCaDc4A1080aCb0 |
| Automatic single-sided provisioner | 0x913591050C1f9047f4B825697D3A2302D7F82D8b |

The automatic single-sided provisioner address and its transaction hashes are in
[deployments/bsc-auto-liquidity.json](deployments/bsc-auto-liquidity.json).
The pool ID is 0xda9f38117db4572febb150af16c262e6f1b5f8f4502b0c3281a8215edfdb188b.
External Infinity swaps use directional fees approximately +5% buy / -5% sell, in addition
to applicable protocol fees and gas. These fees do not apply to website direct vault trades.

**Actual deployed vault source** is under [deployments/source](deployments/source).
The development vault under contracts/ was refactored for a batch candidate after deployment;
it is not deployed at the live address. Other legacy prototypes are retained for reproducible
tests, not enabled features. Solidity verification is published through Sourcify, with
runtime/source comparison evidence in reports/. No third-party audit is claimed.

## Automatic LP funding

Every five minutes, a separate gas-only keeper checks treasury inventory. Excess USDT mints
backed TYW through the original vault; excess TYW redeems through the same vault; balanced
funds need no conversion. Both sides then enter the existing pool in one atomic transaction.
The real pool price, NAV and concentrated-position ratio determine the split, not an
assumption that one TYW always equals one dollar. A 5 + 3 inventory is approximately 4 + 4
after actual costs; the exact token quantities vary with NAV and the pool position.

Per-tranche value is bounded at 1,900 USDT; inventory below 1.1 USDT waits in treasury.
Conversions may lose at most 0.5% of tranche NAV and must finish within 0.5% balance tolerance.
Gas and execution price limits can postpone additions. No money is discarded. Treasury owns
every LP NFT and may withdraw its own LP. Existing positions have finite ranges: adding
inventory does not promise unlimited swaps or automatic external wallet routing.

## Exit after the operator or website disappears

Open [the standalone exit page](https://xyn.lgbt/exit.html), download its entire HTML,
or use the independent [GitHub Pages mirror](https://nomtf.github.io/NoMTF-TYW/).
Alternatively call redeemInKind(uint256,uint256[4],uint256) on the fixed live vault using
a compatible chain explorer or your own interface. The holder signs; no administrator,
website API, price oracle, swap pool, approval or keeper is required. The function remains
available when ordinary vault trading is paused.

The owner has no reserve withdrawal, unbacked mint, arbitrary-call, proxy upgrade, asset
replacement or oracle replacement permission. Rebalance can only use fixed pools within
on-chain threshold, loss and restoration constraints. Users receive their proportional
four underlying tokens and any vault cash, not guaranteed USDT proceeds. If the chain
fails, an underlying issuer defaults/freezes transfers, or a token transfer reverts, a
contract cannot guarantee recovery or value. See [SECURITY.md](SECURITY.md).

To generate unsigned exit data with Node 20+ (no third-party dependency, no key):

```sh
node scripts/redeem-calldata.mjs 0xYOUR_WALLET_ADDRESS 1
```

The script prints transaction data and never broadcasts. The standalone page uses injected
EVM wallets (including EIP-6963). Most wallets do not inject into file://: serve the downloaded
HTML on your own static site or a local HTTP server. Never enter a seed or private key.

The main trading page also provides a “强制交易 · 报价故障备用” option. This reads prices
and execution limits directly from public chain RPC instead of the website API; all wallet,
maximum-payment, minimum-output and contract simulation checks remain in place. It cannot
override a paused contract, a frozen asset or a broken underlying exchange. The independent
in-kind exit is the alternative when USDT swaps are unavailable.
When the website stops a buy or sell because the latest fee exceeds the reviewed estimate,
a confirmation dialog shows the current estimated total fee and percentage. Explicitly
choosing “仍然强制买入/卖出” bypasses the frontend fee-change advisory only. It preserves
maximum input, minimum output, wallet/network validation and on-chain simulation. Cancel
does not send a transaction; an uncertain already-submitted transaction does not invite a
second forced submission.

## Build and checks

```sh
npm ci
npm test
npm run typecheck
npm run build
node --import tsx scripts/fork-auto-liquidity.mjs
```

Fork tests only mutate a local Anvil chain. Public RPC historical access and rate limits may
require FORK_RPC_URL. Tests cover both single sides, unequal/balanced inventory, unsafe
quotes, pause/disable, gas-only keeper, LP ownership and shutdown redemption on the actual
deployed vault. Original development prototype tests are separate from claims about mainnet.
Windows uses the optional pinned Anvil binary; on Linux/macOS install Anvil on PATH or set
ANVIL_BIN to your own executable.

WalletConnect code is configured but cross-device scanning requires a Project ID that is
not yet supplied. External wallet swap routing and logo approvals are independent platform
decisions; a pool, public source or trading volume does not guarantee approval or removal
of risk labels. Runtime logs, private credentials and user mail are excluded from this repo.

Project code: MIT. Third-party dependencies retain their licenses. The user-supplied artwork
is not licensed for unrelated reuse by the software license.
