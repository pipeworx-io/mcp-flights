/**
 * Flights MCP — wraps OpenSky Network API (free, no auth required)
 *
 * Tools:
 * - get_flights_in_area: Get all aircraft in a bounding box
 * - get_aircraft: Track a specific aircraft by ICAO24 address
 * - get_arrivals: Get arrivals at an airport
 * - get_departures: Get departures from an airport
 */

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

const BASE_URL = 'https://opensky-network.org/api';

// OpenSky state vector tuple indices
// [icao24, callsign, origin_country, time_position, last_contact,
//  longitude, latitude, baro_altitude, on_ground, velocity,
//  true_track, vertical_rate, sensors, geo_altitude, squawk,
//  spi, position_source]
type StateVector = [
  string,       // 0 icao24
  string | null, // 1 callsign
  string,       // 2 origin_country
  number | null, // 3 time_position
  number,       // 4 last_contact
  number | null, // 5 longitude
  number | null, // 6 latitude
  number | null, // 7 baro_altitude
  boolean,      // 8 on_ground
  number | null, // 9 velocity
  number | null, // 10 true_track
  number | null, // 11 vertical_rate
  number[] | null, // 12 sensors
  number | null, // 13 geo_altitude
  string | null, // 14 squawk
  boolean,      // 15 spi
  number,       // 16 position_source
];

interface StatesResponse {
  time: number;
  states: StateVector[] | null;
}

interface FlightRecord {
  icao24: string;
  firstSeen: number;
  estDepartureAirport: string | null;
  lastSeen: number;
  estArrivalAirport: string | null;
  callsign: string | null;
  estDepartureAirportHorizDistance: number | null;
  estDepartureAirportVertDistance: number | null;
  estArrivalAirportHorizDistance: number | null;
  estArrivalAirportVertDistance: number | null;
  departureAirportCandidatesCount: number;
  arrivalAirportCandidatesCount: number;
}

function shapeStateVector(sv: StateVector) {
  return {
    icao24: sv[0],
    callsign: sv[1]?.trim() ?? null,
    origin_country: sv[2],
    longitude: sv[5],
    latitude: sv[6],
    altitude: sv[7],
    velocity: sv[9],
    heading: sv[10],
    on_ground: sv[8],
  };
}

function shapeFlightRecord(f: FlightRecord) {
  return {
    icao24: f.icao24,
    callsign: f.callsign?.trim() ?? null,
    first_seen: f.firstSeen,
    last_seen: f.lastSeen,
    departure_airport: f.estDepartureAirport,
    arrival_airport: f.estArrivalAirport,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'get_flights_in_area',
    description:
      'Get all aircraft currently in a geographic bounding box. Returns icao24, callsign, origin country, position, altitude, velocity, and heading for each aircraft.',
    inputSchema: {
      type: 'object',
      properties: {
        lamin: {
          type: 'number',
          description: 'Minimum latitude of the bounding box (degrees)',
        },
        lomin: {
          type: 'number',
          description: 'Minimum longitude of the bounding box (degrees)',
        },
        lamax: {
          type: 'number',
          description: 'Maximum latitude of the bounding box (degrees)',
        },
        lomax: {
          type: 'number',
          description: 'Maximum longitude of the bounding box (degrees)',
        },
      },
      required: ['lamin', 'lomin', 'lamax', 'lomax'],
    },
  },
  {
    name: 'get_aircraft',
    description:
      'Track a specific aircraft by its ICAO24 transponder address (e.g. "a0b1c2"). Returns current position, velocity, altitude, and heading.',
    inputSchema: {
      type: 'object',
      properties: {
        icao24: {
          type: 'string',
          description: 'ICAO24 transponder address (6 hex characters, e.g. "a0b1c2")',
        },
      },
      required: ['icao24'],
    },
  },
  {
    name: 'get_arrivals',
    description:
      'Get flights that arrived at an airport within a time range. Requires an ICAO airport code and Unix timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        airport: {
          type: 'string',
          description: 'ICAO airport code (e.g. "KLAX", "EGLL")',
        },
        begin: {
          type: 'number',
          description: 'Start of time range as Unix timestamp (seconds)',
        },
        end: {
          type: 'number',
          description: 'End of time range as Unix timestamp (seconds, max 7 days after begin)',
        },
      },
      required: ['airport', 'begin', 'end'],
    },
  },
  {
    name: 'get_departures',
    description:
      'Get flights that departed from an airport within a time range. Requires an ICAO airport code and Unix timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        airport: {
          type: 'string',
          description: 'ICAO airport code (e.g. "KLAX", "EGLL")',
        },
        begin: {
          type: 'number',
          description: 'Start of time range as Unix timestamp (seconds)',
        },
        end: {
          type: 'number',
          description: 'End of time range as Unix timestamp (seconds, max 7 days after begin)',
        },
      },
      required: ['airport', 'begin', 'end'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_flights_in_area':
      return getFlightsInArea(
        args.lamin as number,
        args.lomin as number,
        args.lamax as number,
        args.lomax as number,
      );
    case 'get_aircraft':
      return getAircraft(args.icao24 as string);
    case 'get_arrivals':
      return getArrivals(args.airport as string, args.begin as number, args.end as number);
    case 'get_departures':
      return getDepartures(args.airport as string, args.begin as number, args.end as number);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function getFlightsInArea(lamin: number, lomin: number, lamax: number, lomax: number) {
  const params = new URLSearchParams({
    lamin: String(lamin),
    lomin: String(lomin),
    lamax: String(lamax),
    lomax: String(lomax),
  });
  const res = await fetch(`${BASE_URL}/states/all?${params}`);
  if (!res.ok) throw new Error(`OpenSky error: ${res.status}`);

  const data = (await res.json()) as StatesResponse;
  const aircraft = (data.states ?? []).map(shapeStateVector);
  return { count: aircraft.length, aircraft };
}

async function getAircraft(icao24: string) {
  const params = new URLSearchParams({ icao24: icao24.toLowerCase() });
  const res = await fetch(`${BASE_URL}/states/all?${params}`);
  if (!res.ok) throw new Error(`OpenSky error: ${res.status}`);

  const data = (await res.json()) as StatesResponse;
  if (!data.states || data.states.length === 0) {
    throw new Error(`Aircraft not found or not currently tracked: ${icao24}`);
  }
  return shapeStateVector(data.states[0]);
}

async function getArrivals(airport: string, begin: number, end: number) {
  const params = new URLSearchParams({
    airport: airport.toUpperCase(),
    begin: String(begin),
    end: String(end),
  });
  const res = await fetch(`${BASE_URL}/flights/arrival?${params}`);
  if (!res.ok) throw new Error(`OpenSky error: ${res.status}`);

  const data = (await res.json()) as FlightRecord[];
  return { count: data.length, flights: data.map(shapeFlightRecord) };
}

async function getDepartures(airport: string, begin: number, end: number) {
  const params = new URLSearchParams({
    airport: airport.toUpperCase(),
    begin: String(begin),
    end: String(end),
  });
  const res = await fetch(`${BASE_URL}/flights/departure?${params}`);
  if (!res.ok) throw new Error(`OpenSky error: ${res.status}`);

  const data = (await res.json()) as FlightRecord[];
  return { count: data.length, flights: data.map(shapeFlightRecord) };
}

export default { tools, callTool } satisfies McpToolExport;
