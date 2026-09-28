#!/usr/bin/env node
// Sherwood Cash MCP server — lets an LLM agent deposit, read its private balance, swap and
// withdraw on the Sherwood ZK privacy pool, and bridge ZEC/SOL/BTC in and out, over stdio.
//
// Custody is AGENT-SIDE: the agent's EVM private key lives in this process (SHERWOOD_PRIVATE_KEY)
// and never reaches the backend, which only serves note data and relays signed proofs. This
// runs on Node (not Bun) because the ZK prover uses snarkjs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { SherwoodClient } from '@sherwood-cash/sdk'

const PRIVATE_KEY = process.env.SHERWOOD_PRIVATE_KEY
if (!PRIVATE_KEY) {
  console.error('SHERWOOD_PRIVATE_KEY is required (the agent wallet; custody stays agent-side).')
  process.exit(1)
}

const sherwood = new SherwoodClient({
  privateKey: PRIVATE_KEY,
  apiUrl: process.env.SHERWOOD_API_URL,
  rpcUrl: process.env.SHERWOOD_RPC_URL,
})

// Unlock the shielded account once, lazily, on the first tool call. Also learn the assets
// the Private Bridge publishes (wZEC, cbBTC) so every tool accepts them — best-effort, the
// pool works without the bridge.
let unlocked = null
const ready = () =>
  (unlocked ??= sherwood.signIn().then(() => sherwood.bridgeStatus().catch(() => null)))

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e?.message ?? String(e)}` }], isError: true })

const server = new McpServer({ name: 'sherwood-cash', version: '0.2.0' })

server.tool(
  'get_status',
  'Protocol status: connected agent address, registered assets, tree geometry and relayer fees.',
  {},
  async () => {
    try {
      await ready()
      const [address, params, relay] = await Promise.all([sherwood.address(), sherwood.params(), sherwood.relayInfo()])
      const assets = sherwood.listAssets().map((a) => ({ key: a.key, symbol: a.symbol, decimals: a.decimals }))
      for (const key of ['wzec', 'cbbtc']) {
        try {
          const a = sherwood.asset(key)
          assets.push({ key: a.key, symbol: a.symbol, decimals: a.decimals })
        } catch {
          /* not offered by this server */
        }
      }
      return ok({ address, assets, params, relay })
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'get_balances',
  'The agent\'s PRIVATE (shielded) balances. Pass `asset` for one, omit for all. `spendable` is what can move in a single transaction; consolidate to raise it.',
  { asset: z.string().optional().describe('asset key/symbol (e.g. "eth", "usdg"); omit for all') },
  async ({ asset }) => {
    try {
      await ready()
      return ok(asset ? await sherwood.getBalance(asset) : await sherwood.getBalances())
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'quote_swap',
  'Estimate the output amount for a swap, without executing it.',
  {
    from: z.string().describe('input asset key/symbol'),
    to: z.string().describe('output asset key/symbol'),
    amountIn: z.string().describe('input amount, human-readable (e.g. "0.02")'),
  },
  async ({ from, to, amountIn }) => {
    try {
      const q = await sherwood.quote(from, to, amountIn)
      return q ? ok(q) : fail(new Error(`could not price ${from} -> ${to}`))
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'deposit',
  'Deposit an asset from the agent wallet into the private pool. Self-signed; the wallet must hold native gas.',
  { asset: z.string(), amount: z.string().describe('human-readable amount, e.g. "0.05"') },
  async ({ asset, amount }) => {
    try {
      await ready()
      const txHash = await sherwood.deposit(asset, amount)
      return ok({ txHash })
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'swap',
  'Privately swap one asset for another (relayed). Auto-consolidates fragmented notes first. Memecoins are swap-only.',
  {
    from: z.string(),
    to: z.string(),
    amountIn: z.string(),
    slippagePct: z.number().optional().describe('slippage tolerance %, default 1'),
    minOut: z.string().optional().describe('explicit minimum output; overrides slippage'),
  },
  async ({ from, to, amountIn, slippagePct, minOut }) => {
    try {
      await ready()
      const res = await sherwood.swap({ from, to, amountIn, slippagePct, minOut })
      return ok(res)
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'withdraw',
  'Withdraw an asset to any address (relayed; the recipient receives the full amount). ETH/USDG only — sell memecoins first.',
  { asset: z.string(), amount: z.string(), recipient: z.string().describe('0x… destination address') },
  async ({ asset, amount, recipient }) => {
    try {
      await ready()
      const txHash = await sherwood.withdraw(asset, amount, recipient)
      return ok({ txHash })
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'consolidate',
  'Merge fragmented notes so more can be spent in one transaction (quote assets only). Optionally target an amount.',
  { asset: z.string(), amount: z.string().optional() },
  async ({ asset, amount }) => {
    try {
      await ready()
      const txHashes = await sherwood.consolidate(asset, amount)
      return ok({ txHashes, steps: txHashes.length })
    } catch (e) {
      return fail(e)
    }
  },
)

// ---------------------------------------------------------------- Private Bridge
//
// ZEC / SOL / BTC in, a shielded note out; and back. A deposit takes minutes (the foreign
// chain confirms, then NEAR Intents and Relay deliver), far longer than a tool call should
// block, so bridge_deposit starts a background watcher that shields the funds the moment
// they land. It lives as long as this process; if the process stops, bridge_complete picks
// the order up again — the funds wait on the order's own address, nothing is lost.

/** token -> { state, shieldTx, error, order } for orders this process is following. */
const watchers = new Map()

function watch(token) {
  const known = watchers.get(token)
  if (known && known.state === 'running') return known
  const w = { state: 'running', shieldTx: null, error: null, order: null }
  watchers.set(token, w)
  sherwood
    .bridgeComplete(token, { timeoutMs: 3 * 60 * 60_000, pollMs: 15_000, onUpdate: (o) => (w.order = o) })
    .then(({ order, shieldTx }) => {
      w.order = order
      w.shieldTx = shieldTx
      w.state = ['done', 'refunded', 'failed', 'expired'].includes(order.status) ? 'finished' : 'timed_out'
    })
    .catch((e) => {
      w.state = 'error'
      w.error = e?.message ?? String(e)
    })
  return w
}

const watcherView = (token) => {
  const w = watchers.get(token)
  return w ? { watcher: w.state, shieldTx: w.shieldTx, error: w.error } : { watcher: 'none' }
}

const ORIGIN = z.enum(['zec', 'sol', 'btc'])
const RECEIVE = z.enum(['eth', 'wzec', 'cbbtc'])

server.tool(
  'bridge_status',
  'Private Bridge status: which chains it accepts (zec/sol/btc), what each deposit can become (eth, wzec, cbbtc = wBTC), confidentiality, and the 24h volume.',
  {},
  async () => {
    try {
      await ready()
      const status = await sherwood.bridgeStatus(true)
      const receive = {}
      for (const o of status.origins ?? ['zec', 'sol']) receive[o] = await sherwood.bridgeReceiveOptions(o)
      const volume24hUsd = await sherwood.bridgeApi.volume24h().catch(() => null)
      return ok({ ...status, receive, volume24hUsd })
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'bridge_quote',
  'Quote a bridge deposit: what `amount` of ZEC/SOL/BTC becomes once shielded here (ETH, wZEC or wBTC), and roughly how long it takes.',
  {
    amount: z.string().describe('amount of the ORIGIN coin, human-readable (e.g. "1.5")'),
    from: ORIGIN.default('zec').describe('the chain the coin comes from'),
    receive: RECEIVE.optional().describe('what it becomes; defaults to the first option for that origin'),
  },
  async ({ amount, from, receive }) => {
    try {
      await ready()
      const r = receive ?? (await sherwood.bridgeReceiveOptions(from))[0]
      return ok(await sherwood.bridgeQuote({ amount, from, receive: r }))
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'bridge_deposit',
  'Open a PRIVATE bridge deposit into the shielded pool. Returns a deposit address on the origin chain: send exactly `amount` there (with the memo if one is given). The funds land on a one-time address, and this server shields them into the agent\'s notes automatically when they arrive (watch with bridge_order). The agent wallet never appears on chain.',
  {
    amount: z.string().describe('amount of the ORIGIN coin to send, human-readable'),
    from: ORIGIN.default('zec').describe('the chain the coin is sent from'),
    refundTo: z.string().describe('refund address ON THE ORIGIN CHAIN (ZEC: a transparent t1/t3 address; SOL: a pubkey; BTC: an address). The only place a failed bridge can pay back.'),
    receive: RECEIVE.optional().describe('what it becomes: eth (default), wzec (from zec/sol), cbbtc = wBTC (from btc)'),
    autoShield: z.boolean().default(true).describe('shield automatically when the funds land (default true)'),
  },
  async ({ amount, from, refundTo, receive, autoShield }) => {
    try {
      await ready()
      const order = await sherwood.bridgeDeposit({ amount, from, refundTo, receive })
      if (autoShield) watch(order.token)
      return ok({
        token: order.token,
        status: order.status,
        send: { chain: from, amount: order.amountInFormatted, to: order.depositAddress, memo: order.depositMemo },
        receive: { asset: order.receive ?? receive ?? 'eth', estimate: order.amountOutFormatted },
        deadline: order.deadline,
        timeEstimateSec: order.timeEstimate ?? null,
        autoShield,
      })
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'bridge_order',
  'The current state of a bridge order (deposit or withdrawal), plus this server\'s auto-shield watcher for it.',
  { token: z.string() },
  async ({ token }) => {
    try {
      const order = await sherwood.bridgeOrder(token)
      return ok({ ...order, ...watcherView(token) })
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'bridge_complete',
  'Finish a bridge deposit: shield it now if its funds have landed (status waiting_signature), otherwise (re)start the background watcher. Use after a restart, or for an order made elsewhere with the same wallet. Optionally wait up to `waitSeconds` for the outcome.',
  {
    token: z.string(),
    waitSeconds: z.number().int().min(0).max(600).default(0).describe('how long to wait for a final state before returning (max 600)'),
  },
  async ({ token, waitSeconds }) => {
    try {
      await ready()
      const order = await sherwood.bridgeOrder(token)
      if (order.status === 'waiting_signature') {
        const res = await sherwood.bridgeShield(token)
        return ok({ shielded: res, order: await sherwood.bridgeOrder(token) })
      }
      watch(token)
      if (waitSeconds > 0) {
        const res = await sherwood.bridgeComplete(token, { timeoutMs: waitSeconds * 1000, pollMs: 10_000 })
        return ok({ ...res, ...watcherView(token) })
      }
      return ok({ order, ...watcherView(token) })
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'bridge_withdraw',
  'Bridge OUT of the shielded pool to ZEC, SOL or BTC: one relayed vault withdrawal pays the bridge directly, and the coin is paid out on the destination chain. The agent\'s public balance is never touched. Track with bridge_order.',
  {
    amount: z.string().describe('amount the vault pays, human-readable, in `asset` units'),
    to: ORIGIN.default('zec').describe('destination chain'),
    destination: z.string().describe('payout address on the destination chain'),
    asset: z.enum(['eth', 'wzec']).default('eth').describe('what the vault pays out: eth, or wzec (redeemed by the keeper; ZEC destination)'),
    refundAddress: z.string().optional().describe('EVM address on this chain for a failed exit; defaults to the agent wallet'),
  },
  async ({ amount, to, destination, asset, refundAddress }) => {
    try {
      await ready()
      const { order, txHash } = await sherwood.bridgeWithdraw({ amount, to, destination, asset, refundAddress })
      return ok({ token: order.token, status: order.status, withdrawTx: txHash, payTo: order.payTo, payout: { chain: to, to: destination, estimate: order.amountOutFormatted } })
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'bridge_history',
  'This agent\'s bridge orders, newest first. Filed under a pseudonym derived from the note keys, never the wallet address — shared with the web app for the same wallet.',
  {},
  async () => {
    try {
      await ready()
      const orders = await sherwood.bridgeHistory()
      return ok(orders.map((o) => ({ token: o.token, direction: o.direction, status: o.status, amountIn: o.amountInFormatted, amountOut: o.amountOutFormatted, receive: o.receive ?? 'eth', createdAt: o.createdAt, ...watcherView(o.token) })))
    } catch (e) {
      return fail(e)
    }
  },
)

server.tool(
  'bridge_resume',
  'Unstick a bridge order: reads where its money actually is and moves it on (rebridge from the hop chain, or arm it for signing). If the answer is action "sign", call bridge_complete.',
  { token: z.string() },
  async ({ token }) => {
    try {
      return ok(await sherwood.bridgeResume(token))
    } catch (e) {
      return fail(e)
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('Sherwood MCP server ready (stdio).')
