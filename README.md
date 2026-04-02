# mcp-flights

MCP server for tracking flights via the [OpenSky Network API](https://opensky-network.org/). No authentication required.

## Tools

| Tool | Description |
|------|-------------|
| `get_flights_in_area` | Get all aircraft currently in a geographic bounding box |
| `get_aircraft` | Track a specific aircraft by its ICAO24 transponder address |
| `get_arrivals` | Get flights that arrived at an airport within a time range |
| `get_departures` | Get flights that departed from an airport within a time range |

## Quickstart (Pipeworx Gateway)

```bash
curl -X POST https://gateway.pipeworx.io/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "flights_get_flights_in_area",
      "arguments": { "lamin": 45.8, "lomin": 5.9, "lamax": 47.8, "lomax": 10.5 }
    },
    "id": 1
  }'
```

## License

MIT
