#!/usr/bin/env node
// Sherwood Cash MCP server — lets an LLM agent deposit, read its private balance, swap and
// withdraw on the Sherwood ZK privacy pool over stdio.
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

// Unlock the shielded account once, lazily, on the first tool call.
let unlocked = null
const ready = () => (unlocked ??= sherwood.signIn())

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e?.message ?? String(e)}` }], isError: true })

const server = new McpServer({ name: 'sherwood-cash', version: '0.1.0' })

server.tool(
  'get_status',
  'Protocol status: connected agent address, registered assets, tree geometry and relayer fees.',
  {},
  async () => {
    try {
      const [address, params, relay] = await Promise.all([sherwood.address(), sherwood.params(), sherwood.relayInfo()])
      return ok({ address, assets: sherwood.listAssets().map((a) => ({ key: a.key, symbol: a.symbol, decimals: a.decimals })), params, relay })
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

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('Sherwood MCP server ready (stdio).')
