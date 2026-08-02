# sherwood-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an LLM agent trade privately on
**[Sherwood Cash](https://sherwood.cash)** — deposit, read its shielded balance, swap and
withdraw on the ZK privacy pool over stdio. It's a thin layer over
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

The first proof downloads the circuit artifacts (~19 MB) to `~/.sherwood-sdk`. A freshly
created note is only spendable once indexed, so a tool call can take a few seconds.

## License

MIT
