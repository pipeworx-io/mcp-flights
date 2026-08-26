# mcp-flights

Flights MCP — live aircraft tracking + aircraft/route registry

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `get_flights_in_area` | Find aircraft currently airborne in a geographic area, by bounding box. LIVE ADS-B data, no key required. Returns per aircraft: ICAO24 hex, callsign, registration (tail number), aircraft type, position, altitude, ground speed, heading, vertical rate, squawk, and any emergency code. Use for "what planes are over <place> right now", "aircraft near <airport>", "is anything squawking 7700 near X". For one known aircraft use get_aircraft; for what route a callsign flies use get_flight_route. |
| `get_aircraft` | Look up ONE aircraft by ICAO24 transponder hex (e.g. "a4d97e"). Returns registry details — registration/tail number, manufacturer, type, and registered owner/operator — plus its LIVE position if it is currently transmitting. No key required. Use for "what is aircraft <hex>", "who operates <hex>", "where is <hex> now". If you only have a flight number/callsign, use get_flight_route instead. |
| `get_flight_route` | Resolve a flight callsign / flight number (e.g. "UAL1", "BAW117") to its airline and scheduled ROUTE — origin and destination airports with names, IATA/ICAO codes, and coordinates. No key required. Use for "where does flight X fly from/to", "what route is <callsign>", "which airline is <callsign>". Complements get_flights_in_area, which gives you callsigns of aircraft currently overhead. |
| `get_arrivals` | Aircraft currently ARRIVING at an airport — live ADS-B, no key required. Pass an ICAO code (e.g. "KSFO", "EGLL") and get inbound traffic descending toward the field, nearest first, with callsign, registration, aircraft type, altitude, descent rate and distance out. Use for "what is landing at <airport> right now", "inbound traffic to <airport>". This is a live picture, not a scheduled timetable. (Historical windows via begin/end require OpenSky credentials and only work when self-hosting — OpenSky is unreachable from cloud egress.) |
| `get_departures` | Aircraft currently DEPARTING an airport — live ADS-B, no key required. Pass an ICAO code (e.g. "KSFO", "EGLL") and get outbound traffic climbing out of the field, nearest first, with callsign, registration, aircraft type, altitude, climb rate and distance out. Use for "what just took off from <airport>", "outbound traffic from <airport>". This is a live picture, not a scheduled timetable. (Historical windows via begin/end require OpenSky credentials and only work when self-hosting — OpenSky is unreachable from cloud egress.) |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "flights": {
      "url": "https://gateway.pipeworx.io/flights/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/flights/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Flights data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
