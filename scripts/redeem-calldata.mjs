// Node built-ins only; never reads a key, sends a transaction, or uses xyn.lgbt.
const vault='0xaE7eA21fBf3613fFc17fe962EE66bfe03015fBa7';
const [account,amount]=process.argv.slice(2);if(!/^0x[0-9a-f]{40}$/i.test(account||'')||!/^\d{1,12}(\.\d{1,18})?$/.test(amount||''))throw Error('Usage: node scripts/redeem-calldata.mjs 0xYOUR_ADDRESS TYW_SHARES');
const page=await import('node:fs').then(fs=>fs.readFileSync(new URL('../public/exit.html',import.meta.url),'utf8'));
const selectors=JSON.parse(page.match(/const SELECTORS=(\{[^;]+\});/)[1]);
const word=n=>BigInt(n).toString(16).padStart(64,'0'),[a,b='']=amount.split('.'),shares=BigInt(a)*10n**18n+BigInt(b.padEnd(18,'0'));
if(shares<=0n)throw Error('Shares must be positive');
async function call(data){const r=await fetch(process.env.RPC_URL||'https://bsc-dataseed.bnbchain.org',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:vault,data},'latest']}),signal:AbortSignal.timeout(15000)});const v=await r.json();if(v.error||!/^0x[0-9a-f]+$/i.test(v.result||''))throw Error('Chain read failed');return v.result;}
if(shares>BigInt(await call(selectors.balance+account.slice(2).padStart(64,'0'))))throw Error('Insufficient TYW');
const result=await call(selectors.preview+word(shares));if(result.length!==322)throw Error('Invalid preview');
console.log(JSON.stringify({chainId:56,from:account,to:vault,value:'0x0',data:selectors.redeem+word(shares)+result.slice(2),method:'redeemInKind',shares:String(shares),minimumAmounts:Array.from({length:5},(_,i)=>String(BigInt('0x'+result.slice(2+64*i,66+64*i)))),transactionSent:false},null,2));
