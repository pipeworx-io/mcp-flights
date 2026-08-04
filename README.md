# mcp-flights

Flights MCP — live aircraft tracking + aircraft/route registry

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Flights data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
