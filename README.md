# sherwood-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an LLM agent trade privately on
**[Sherwood Cash](https://sherwood.cash)** — deposit, read its shielded balance, swap,
withdraw and bridge ZEC/SOL/BTC in and out of the ZK privacy pool over stdio. It's a thin layer over
[`@sherwood-cash/sdk`](https://github.com/sherwood-cash/sherwood-sdk).

**Custody is agent-side.** The agent's EVM private key lives in this process and is never
sent to a server; the SDK builds every proof locally and only relays the signed result.

> Node ≥ 20 (the ZK prover uses snarkjs, which does not run on Bun).

## Run

```bash
npm install
SHERWOOD_PRIVATE_KEY=0x… node server.mjs
```

Environment:

| var                    | required | description                                            |
|------------------------|----------|--------------------------------------------------------|
| `SHERWOOD_PRIVATE_KEY` | yes      | the agent wallet (custody stays agent-side)            |
| `SHERWOOD_API_URL`     | no       | backend base URL (default `https://api.sherwood.cash`) |
| `SHERWOOD_RPC_URL`     | no       | JSON-RPC for chain reads                                |

## Use it from an MCP client

Point any MCP client (Claude Desktop, Cline, a custom agent runtime…) at the server. The
client launches it locally and injects the wallet key:

```json
{
  "mcpServers": {
    "sherwood": {
      "command": "node",
      "args": ["/absolute/path/to/sherwood-mcp/server.mjs"],
      "env": { "SHERWOOD_PRIVATE_KEY": "0x…" }
    }
  }
}
```

## Tools

| tool           | description                                                     |
|----------------|-----------------------------------------------------------------|
| `get_status`   | agent address, registered assets, tree geometry, relayer fees   |
| `get_balances` | shielded balances (+ `spendable` per asset)                     |
| `quote_swap`   | estimate a swap output without executing                        |
| `deposit`      | deposit into the pool (self-signed; needs native gas)          |
| `swap`         | private swap (relayed; auto-consolidates first)                |
| `withdraw`     | withdraw to any address (relayed)                               |
| `consolidate`  | merge fragmented notes to raise the single-tx spendable amount  |

### Private Bridge (ZEC / SOL / BTC)

| tool              | description                                                                 |
|-------------------|-----------------------------------------------------------------------------|
| `bridge_status`   | accepted chains, what each deposit can become (eth / wzec / cbbtc = wBTC)   |
| `bridge_quote`    | what an amount of ZEC/SOL/BTC becomes once shielded, and how long it takes  |
| `bridge_deposit`  | open a private deposit → a deposit address to send the coin to              |
| `bridge_order`    | an order's state + this server's auto-shield watcher                        |
| `bridge_complete` | shield now if the funds landed, else (re)start the watcher; can wait        |
| `bridge_withdraw` | bridge out of the pool to ZEC/SOL/BTC (one relayed withdrawal)             |
| `bridge_history`  | the agent's orders (pseudonymous, shared with the web app)                  |
| `bridge_resume`   | unstick an order from wherever its money stopped                            |

A bridge deposit takes minutes, so `bridge_deposit` returns at once and a background
watcher in this process shields the funds when they land — into the agent's own notes, from
a proof built here; the server only pays the gas out of the order's one-time address. If
the process restarts, `bridge_complete` picks the order up again: nothing is lost, the
funds wait on that address.

The first proof downloads the circuit artifacts (~19 MB) to `~/.sherwood-sdk`. A freshly
created note is only spendable once indexed, so a tool call can take a few seconds.

### P2P cash-out (fiat via Peer)

| Tool          | What it does                                                                     |
| ------------- | -------------------------------------------------------------------------------- |
| `p2p_quote`   | Base USDC an amount becomes (min 20) + Peer fill speed per rail                  |
| `p2p_cashout` | vault → Base cash-out address → listed on Peer for a Venmo/Revolut/Wise… handle  |
| `p2p_list`    | list a delivered order on Peer (or retry)                                        |
| `p2p_order`   | an order's state + its live Peer listing                                         |
| `p2p_history` | the agent's cash-outs (pseudonymous, shared with the web app)                    |
| `p2p_unlist`  | close the Peer listing, unsold USDC back to the cash-out address                 |
| `p2p_refund`  | pull a cash-out stuck over an hour back to `refundTo`                            |

## License

MIT
