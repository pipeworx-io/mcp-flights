interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Flights MCP — live aircraft tracking + aircraft/route registry
 *
 * Sources (2026-07-25 rebuild — see below for why OpenSky is no longer primary):
 * - adsb.lol / airplanes.live / adsb.fi: KEYLESS live ADS-B positions. All three
 *   serve the same readsb JSON shape, so they form a fallback chain — community
 *   feeds go down individually (db-rest died the same week), a chain does not.
 * - adsbdb.com: KEYLESS aircraft registry (type/registration/owner) and
 *   callsign -> route (origin/destination airports).
 * - airport-data.com: airport coordinates (with the busiest fields inlined).
 * - OpenSky: OPT-IN historical airport movements only, and unreachable from
 *   cloud egress — see below.
 *
 * Why the rebuild: every tool here used to call OpenSky, and every one failed in
 * production. Three separate causes, all confirmed 2026-07-25:
 *  1. OpenSky's anonymous tier is ~400 credits/day metered PER IP, which shared
 *     cloud egress exhausts on unrelated traffic.
 *  2. OpenSky is unreachable from datacenter egress entirely — it blackholes the
 *     connection (a bogus-credential auth request that should 401 in ~1s instead
 *     hangs indefinitely, from Cloudflare AND from a non-CF relay). Credentials
 *     do not help; no relay we control fixes it. Every OpenSky hop is therefore
 *     hard-bounded by AbortSignal.timeout so it can never pin a request.
 *  3. OpenSky retired /metadata/aircraft (HTTP 410 Gone).
 * So live ADS-B is now the primary source, and OpenSky is opt-in for callers
 * self-hosting this pack somewhere it is actually reachable.
 *
 * Tools:
 * - get_flights_in_area: live aircraft in a bounding box (keyless)
 * - get_aircraft: one aircraft by ICAO24 — registry details + live position (keyless)
 * - get_flight_route: callsign -> airline + origin/destination airports (keyless)
 * - get_arrivals: aircraft currently arriving at an airport (keyless, live)
 * - get_departures: aircraft currently departing an airport (keyless, live)
 */


// Bound the fetch() calls in this pack that pass no signal of their own — a
// file with one guarded call still reads as "guarded" to the file-level grep
// while its other call sites hang unbounded (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Flights');
}

const ADSBDB_BASE = 'https://api.adsbdb.com/v0';
const OPENSKY_BASE = 'https://opensky-network.org/api';
const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

/** Live-ADS-B providers, tried in order. Same readsb payload, different paths. */
const ADSB_PROVIDERS = [
  {
    name: 'adsb.lol',
    point: (lat: number, lon: number, nm: number) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
    hex: (hex: string) => `https://api.adsb.lol/v2/hex/${hex}`,
  },
  {
    name: 'airplanes.live',
    point: (lat: number, lon: number, nm: number) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
    hex: (hex: string) => `https://api.airplanes.live/v2/hex/${hex}`,
  },
  {
    name: 'adsb.fi',
    point: (lat: number, lon: number, nm: number) =>
      `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
    hex: (hex: string) => `https://opendata.adsb.fi/api/v2/icao/${hex}`,
  },
] as const;

const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

/** readsb aircraft record (subset we surface). */
interface AdsbRecord {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  desc?: string;
  ownOp?: string;
  year?: string;
  alt_baro?: number | string;
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  squawk?: string;
  emergency?: string;
  category?: string;
  lat?: number;
  lon?: number;
  seen_pos?: number;
}

function shapeAdsb(a: AdsbRecord) {
  // alt_baro is the string "ground" when the aircraft is on the surface.
  const onGround = a.alt_baro === 'ground';
  return {
    icao24: a.hex ?? null,
    callsign: typeof a.flight === 'string' ? a.flight.trim() || null : null,
    registration: a.r ?? null,
    aircraft_type: a.t ?? null,
    description: a.desc ?? null,
    operator: a.ownOp ?? null,
    latitude: a.lat ?? null,
    longitude: a.lon ?? null,
    altitude_ft: onGround ? 0 : typeof a.alt_baro === 'number' ? a.alt_baro : null,
    on_ground: onGround,
    ground_speed_kt: a.gs ?? null,
    track_deg: a.track ?? null,
    vertical_rate_fpm: a.baro_rate ?? null,
    squawk: a.squawk ?? null,
    emergency: a.emergency && a.emergency !== 'none' ? a.emergency : null,
    seconds_since_position: a.seen_pos ?? null,
  };
}

/** Fetch from the provider chain; first provider that answers wins. */
async function adsbFetch(
  pick: (p: (typeof ADSB_PROVIDERS)[number]) => string,
): Promise<{ records: AdsbRecord[]; source: string }> {
  const failures: string[] = [];
  for (const p of ADSB_PROVIDERS) {
    try {
      const res = await pwFetch(pick(p), { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) {
        failures.push(`${p.name}:HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { ac?: AdsbRecord[]; aircraft?: AdsbRecord[] };
      // adsb.lol/airplanes.live use `ac`; adsb.fi uses `aircraft`.
      return { records: json.ac ?? json.aircraft ?? [], source: p.name };
    } catch (e) {
      failures.push(`${p.name}:${dropClassPrefix(String(e)).slice(0, 60)}`);
    }
  }
  throw new Error(
    `All ADS-B providers failed (${failures.join('; ')}). These are free community feeds; retry shortly.`,
  );
}

const tools: McpToolExport['tools'] = [
  {
    name: 'get_flights_in_area',
    description:
      'Find aircraft currently airborne in a geographic area, by bounding box. LIVE ADS-B data, no key required. Returns per aircraft: ICAO24 hex, callsign, registration (tail number), aircraft type, position, altitude, ground speed, heading, vertical rate, squawk, and any emergency code. Use for "what planes are over <place> right now", "aircraft near <airport>", "is anything squawking 7700 near X". For one known aircraft use get_aircraft; for what route a callsign flies use get_flight_route.',
    inputSchema: {
      type: 'object',
      properties: {
        lamin: { type: 'number', description: 'Minimum (south) latitude of the bounding box, degrees' },
        lomin: { type: 'number', description: 'Minimum (west) longitude of the bounding box, degrees' },
        lamax: { type: 'number', description: 'Maximum (north) latitude of the bounding box, degrees' },
        lomax: { type: 'number', description: 'Maximum (east) longitude of the bounding box, degrees' },
        limit: { type: 'number', description: 'Max aircraft to return (1-500, default 200), nearest the box centre first.' },
      },
      required: ['lamin', 'lomin', 'lamax', 'lomax'],
    },
  },
  {
    name: 'get_aircraft',
    description:
      'Look up ONE aircraft by ICAO24 transponder hex (e.g. "a4d97e"). Returns registry details — registration/tail number, manufacturer, type, and registered owner/operator — plus its LIVE position if it is currently transmitting. No key required. Use for "what is aircraft <hex>", "who operates <hex>", "where is <hex> now". If you only have a flight number/callsign, use get_flight_route instead.',
    inputSchema: {
      type: 'object',
      properties: {
        icao24: {
          type: 'string',
          description: 'ICAO24 transponder address — 6 hex characters, e.g. "a4d97e" (case-insensitive)',
        },
      },
      required: ['icao24'],
    },
  },
  {
    name: 'get_flight_route',
    description:
      'Resolve a flight callsign / flight number (e.g. "UAL1", "BAW117") to its airline and scheduled ROUTE — origin and destination airports with names, IATA/ICAO codes, and coordinates. No key required. Use for "where does flight X fly from/to", "what route is <callsign>", "which airline is <callsign>". Complements get_flights_in_area, which gives you callsigns of aircraft currently overhead.',
    inputSchema: {
      type: 'object',
      properties: {
        callsign: {
          type: 'string',
          description: 'Flight callsign, ICAO or IATA form (e.g. "UAL1", "UA1", "BAW117")',
        },
      },
      required: ['callsign'],
    },
  },
  {
    name: 'get_arrivals',
    description:
      'Aircraft currently ARRIVING at an airport — live ADS-B, no key required. Pass an ICAO code (e.g. "KSFO", "EGLL") and get inbound traffic descending toward the field, nearest first, with callsign, registration, aircraft type, altitude, descent rate and distance out. Use for "what is landing at <airport> right now", "inbound traffic to <airport>". This is a live picture, not a scheduled timetable. (Historical windows via begin/end require OpenSky credentials and only work when self-hosting — OpenSky is unreachable from cloud egress.)',
    inputSchema: {
      type: 'object',
      properties: {
        airport: { type: 'string', description: 'ICAO airport code, e.g. "KJFK", "EGLL", "KSFO" (4 letters, not the 3-letter IATA code)' },
        radius_nm: { type: 'number', description: 'How far out to look, nautical miles (1-250, default 40).' },
        limit: { type: 'number', description: 'Max aircraft to return (1-200, default 50), nearest first.' },
        begin: { type: 'number', description: 'OPTIONAL historical window start (Unix seconds). Requires OpenSky credentials and only works when self-hosting; omit for live data.' },
        end: { type: 'number', description: 'OPTIONAL historical window end (Unix seconds, max 7 days after begin). Omit for live data.' },
      },
      required: ['airport'],
    },
  },
  {
    name: 'get_departures',
    description:
      'Aircraft currently DEPARTING an airport — live ADS-B, no key required. Pass an ICAO code (e.g. "KSFO", "EGLL") and get outbound traffic climbing out of the field, nearest first, with callsign, registration, aircraft type, altitude, climb rate and distance out. Use for "what just took off from <airport>", "outbound traffic from <airport>". This is a live picture, not a scheduled timetable. (Historical windows via begin/end require OpenSky credentials and only work when self-hosting — OpenSky is unreachable from cloud egress.)',
    inputSchema: {
      type: 'object',
      properties: {
        airport: { type: 'string', description: 'ICAO airport code, e.g. "KJFK", "EGLL", "KSFO" (4 letters, not the 3-letter IATA code)' },
        radius_nm: { type: 'number', description: 'How far out to look, nautical miles (1-250, default 40).' },
        limit: { type: 'number', description: 'Max aircraft to return (1-200, default 50), nearest first.' },
        begin: { type: 'number', description: 'OPTIONAL historical window start (Unix seconds). Requires OpenSky credentials and only works when self-hosting; omit for live data.' },
        end: { type: 'number', description: 'OPTIONAL historical window end (Unix seconds, max 7 days after begin). Omit for live data.' },
      },
      required: ['airport'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_flights_in_area':
      return getFlightsInArea(args);
    case 'get_aircraft':
      return getAircraft(args.icao24 as string);
    case 'get_flight_route':
      return getFlightRoute(args.callsign as string);
    case 'get_arrivals':
      return airportFlights('arrival', args);
    case 'get_departures':
      return airportFlights('departure', args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function num(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(
      `Required argument "${label}" must be a number. Example: get_flights_in_area({lamin: 37.0, lomin: -123.0, lamax: 38.5, lomax: -121.5}) for the San Francisco Bay Area.`,
    );
  }
  return n;
}

async function getFlightsInArea(args: Record<string, unknown>) {
  const lamin = num(args.lamin, 'lamin');
  const lomin = num(args.lomin, 'lomin');
  const lamax = num(args.lamax, 'lamax');
  const lomax = num(args.lomax, 'lomax');
  const limit = Math.min(500, Math.max(1, Math.floor(Number(args.limit) || 200)));

  const south = Math.min(lamin, lamax);
  const north = Math.max(lamin, lamax);
  const west = Math.min(lomin, lomax);
  const east = Math.max(lomin, lomax);
  const clat = (south + north) / 2;
  const clon = (west + east) / 2;

  // These feeds are radius-based, so cover the box with a circumscribing circle
  // (centre -> corner), then filter back to the exact box. 1 deg lat ~= 60 nm;
  // longitude degrees shrink by cos(lat). Providers cap radius at 250 nm.
  const latNm = ((north - south) / 2) * 60;
  const lonNm = ((east - west) / 2) * 60 * Math.cos((clat * Math.PI) / 180);
  const radiusNm = Math.min(250, Math.max(1, Math.ceil(Math.hypot(latNm, lonNm))));

  const { records, source } = await adsbFetch((p) =>
    p.point(Number(clat.toFixed(4)), Number(clon.toFixed(4)), radiusNm),
  );

  const inBox = records.filter(
    (a) =>
      typeof a.lat === 'number' &&
      typeof a.lon === 'number' &&
      a.lat >= south &&
      a.lat <= north &&
      a.lon >= west &&
      a.lon <= east,
  );
  // Nearest the centre first, so a truncating `limit` keeps the most relevant.
  inBox.sort(
    (x, y) =>
      Math.hypot((x.lat ?? 0) - clat, (x.lon ?? 0) - clon) -
      Math.hypot((y.lat ?? 0) - clat, (y.lon ?? 0) - clon),
  );

  return {
    bounding_box: { lamin: south, lomin: west, lamax: north, lomax: east },
    count: Math.min(inBox.length, limit),
    total_in_box: inBox.length,
    source,
    note:
      radiusNm >= 250
        ? 'Bounding box exceeds the 250nm provider radius; results cover a 250nm circle around the box centre. Narrow the box for full coverage.'
        : undefined,
    aircraft: inBox.slice(0, limit).map(shapeAdsb),
  };
}

interface AdsbdbAircraft {
  type?: string;
  icao_type?: string;
  manufacturer?: string;
  mode_s?: string;
  registration?: string;
  registered_owner?: string;
  registered_owner_country_name?: string;
  registered_owner_operator_flag_code?: string;
  url_photo?: string | null;
}

async function getAircraft(icao24: string) {
  if (typeof icao24 !== 'string' || !icao24.trim()) {
    throw new Error(
      'Required argument "icao24" is missing. Pass a 6-character hex transponder code, e.g. get_aircraft({icao24: "a4d97e"}). If you only have a flight number, use get_flight_route({callsign: "UAL1"}).',
    );
  }
  const hex = icao24.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) {
    throw new Error(
      `"${icao24}" is not a valid ICAO24 address. It must be exactly 6 hexadecimal characters, e.g. "a4d97e". Registrations ("N411SY") and callsigns ("UAL1") are different identifiers — use get_flight_route for a callsign.`,
    );
  }

  // Registry metadata (static) and live position (may be absent) are independent:
  // an aircraft parked in a hangar still has registry details.
  const [registry, live] = await Promise.all([
    (async () => {
      try {
        const r = await pwFetch(`${ADSBDB_BASE}/aircraft/${hex}`, {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { response?: { aircraft?: AdsbdbAircraft } | string };
        return typeof j.response === 'string' ? null : j.response?.aircraft ?? null;
      } catch {
        return null;
      }
    })(),
    (async () => {
      try {
        const { records } = await adsbFetch((p) => p.hex(hex));
        return records[0] ?? null;
      } catch {
        return null;
      }
    })(),
  ]);

  if (!registry && !live) {
    throw new Error(
      `No aircraft found for ICAO24 "${hex}" — it is not in the adsbdb registry and is not currently transmitting. Double-check the hex code (get_flights_in_area returns valid ones for aircraft overhead now).`,
    );
  }

  return {
    icao24: hex,
    registration: registry?.registration ?? live?.r ?? null,
    aircraft_type: registry?.type ?? live?.desc ?? null,
    icao_type_code: registry?.icao_type ?? live?.t ?? null,
    manufacturer: registry?.manufacturer ?? null,
    operator: registry?.registered_owner ?? live?.ownOp ?? null,
    operator_country: registry?.registered_owner_country_name ?? null,
    photo_url: registry?.url_photo ?? null,
    currently_tracked: Boolean(live),
    live_position: live ? shapeAdsb(live) : null,
    note: live ? undefined : 'Aircraft is not transmitting ADS-B right now; registry details only.',
  };
}

interface AdsbdbAirport {
  iata_code?: string;
  icao_code?: string;
  name?: string;
  municipality?: string;
  country_name?: string;
  latitude?: number;
  longitude?: number;
  elevation?: number;
}

function shapeAirport(a?: AdsbdbAirport | null) {
  if (!a) return null;
  return {
    iata: a.iata_code ?? null,
    icao: a.icao_code ?? null,
    name: a.name ?? null,
    city: a.municipality ?? null,
    country: a.country_name ?? null,
    latitude: a.latitude ?? null,
    longitude: a.longitude ?? null,
  };
}

async function getFlightRoute(callsign: string) {
  if (typeof callsign !== 'string' || !callsign.trim()) {
    throw new Error(
      'Required argument "callsign" is missing. Pass a flight callsign, e.g. get_flight_route({callsign: "UAL1"}).',
    );
  }
  const cs = callsign.trim().toUpperCase().replace(/\s+/g, '');
  const res = await pwFetch(`${ADSBDB_BASE}/callsign/${encodeURIComponent(cs)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (res.status === 404) {
    throw new Error(
      `No route on file for callsign "${cs}". adsbdb covers scheduled airline callsigns — private/GA flights, military, and one-off charters usually have none. Check the callsign form (ICAO "UAL1" and IATA "UA1" both work).`,
    );
  }
  if (!res.ok) throw await httpError(res, 'adsbdb route lookup failed');

  const j = (await res.json()) as {
    response?:
      | string
      | {
          flightroute?: {
            callsign?: string;
            callsign_icao?: string;
            callsign_iata?: string;
            airline?: { name?: string; icao?: string; iata?: string; country?: string; callsign?: string };
            origin?: AdsbdbAirport;
            destination?: AdsbdbAirport;
          };
        };
  };
  const fr = typeof j.response === 'string' ? null : j.response?.flightroute;
  if (!fr) throw new Error(`No route on file for callsign "${cs}".`);

  return {
    callsign: fr.callsign ?? cs,
    callsign_icao: fr.callsign_icao ?? null,
    callsign_iata: fr.callsign_iata ?? null,
    airline: fr.airline
      ? {
          name: fr.airline.name ?? null,
          icao: fr.airline.icao ?? null,
          iata: fr.airline.iata ?? null,
          country: fr.airline.country ?? null,
          radio_callsign: fr.airline.callsign ?? null,
        }
      : null,
    origin: shapeAirport(fr.origin),
    destination: shapeAirport(fr.destination),
    note: 'Scheduled route for this callsign, not a live position. Use get_flights_in_area / get_aircraft for where the aircraft is now.',
  };
}

/**
 * OpenSky OAuth2 (client_credentials). Tokens live ~30 min; cache per isolate so
 * a burst of calls does one token exchange, not one per request.
 */
let tokenCache: { token: string; expiresAt: number } | null = null;

/** Relay config injected by the gateway when a non-CF egress proxy is available. */
interface Relay {
  url: string;
  token: string;
}

function relayFrom(args: Record<string, unknown>): Relay | null {
  const url = typeof args._proxyUrl === 'string' ? args._proxyUrl : '';
  const token = typeof args._proxyToken === 'string' ? args._proxyToken : '';
  return url && token ? { url, token } : null;
}

/**
 * Cloudflare egress cannot reach opensky-network.org at all — the auth realm
 * times out (HTTP 522) and the API is unreachable — so when the gateway supplies
 * a relay we send OpenSky calls through it. `upstreamAuth` carries the OAuth
 * bearer to OpenSky; the relay's own token authenticates us to the relay.
 */
async function openskyFetch(
  url: string,
  relay: Relay | null,
  init?: { method?: string; body?: string; contentType?: string; bearer?: string },
): Promise<Response> {
  // OpenSky blackholes datacenter egress (no RST, no response), so an unbounded
  // fetch would pin the request until the platform kills it. Always bound it.
  const signal = AbortSignal.timeout(12000);
  if (relay) {
    return fetch(relay.url, {
      signal,
      method: 'POST',
      headers: { Authorization: `Bearer ${relay.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body !== undefined ? { body: init.body } : {}),
        ...(init?.contentType ? { contentType: init.contentType } : {}),
        ...(init?.bearer ? { upstreamAuth: `Bearer ${init.bearer}` } : {}),
      }),
    });
  }
  return fetch(url, {
    signal,
    method: init?.method ?? 'GET',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      ...(init?.contentType ? { 'Content-Type': init.contentType } : {}),
      ...(init?.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
    },
    ...(init?.body !== undefined ? { body: init.body } : {}),
  });
}

async function openskyToken(clientId: string, clientSecret: string, relay: Relay | null): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 30_000) return tokenCache.token;

  const res = await openskyFetch(OPENSKY_TOKEN_URL, relay, {
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `OpenSky authentication failed (HTTP ${res.status}). Check the client id/secret: _apiKey must be "clientId:clientSecret" from an OpenSky API client (Account -> API clients at opensky-network.org).`,
    );
  }
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error('OpenSky returned no access token.');
  tokenCache = { token: j.access_token, expiresAt: now + (j.expires_in ?? 1800) * 1000 };
  return j.access_token;
}

interface OpenskyFlight {
  icao24: string;
  firstSeen: number;
  lastSeen: number;
  callsign: string | null;
  estDepartureAirport: string | null;
  estArrivalAirport: string | null;
}

/**
 * Coordinates for the busiest fields, so the common cases resolve with no
 * network call (and still work if the lookup host is unreachable).
 */
const AIRPORT_COORDS: Record<string, [number, number]> = {
  KSFO: [37.6191, -122.3752], KLAX: [33.9416, -118.4085], KJFK: [40.6413, -73.7781],
  KEWR: [40.6895, -74.1745], KORD: [41.9742, -87.9073], KATL: [33.6407, -84.4277],
  KDFW: [32.8998, -97.0403], KDEN: [39.8561, -104.6737], KSEA: [47.4502, -122.3088],
  KBOS: [42.3656, -71.0096], KMIA: [25.7959, -80.2871], KLAS: [36.084, -115.1537],
  KPHX: [33.4342, -112.0116], KIAH: [29.9902, -95.3368], KMCO: [28.4312, -81.3081],
  EGLL: [51.47, -0.4543], EGKK: [51.1537, -0.1821], LFPG: [49.0097, 2.5479],
  EDDF: [50.0379, 8.5622], EDDM: [48.3537, 11.786], EHAM: [52.3105, 4.7683],
  LEMD: [40.4719, -3.5626], LIRF: [41.7999, 12.2462], LSZH: [47.4647, 8.5492],
  LOWW: [48.1103, 16.5697], EKCH: [55.6181, 12.656], ESSA: [59.6519, 17.9186],
  RJTT: [35.5494, 139.7798], RJAA: [35.7647, 140.3864], VHHH: [22.308, 113.9185],
  WSSS: [1.3644, 103.9915], OMDB: [25.2532, 55.3657], OTHH: [25.2731, 51.6081],
  YSSY: [-33.9399, 151.1753], NZAA: [-37.0082, 174.7850], CYYZ: [43.6777, -79.6248],
  CYVR: [49.1967, -123.1815], SBGR: [-23.4356, -46.4731], SAEZ: [-34.8222, -58.5358],
  FAOR: [-26.1392, 28.246], HECA: [30.1219, 31.4056], VIDP: [28.5562, 77.1],
  ZBAA: [40.0799, 116.6031], ZSPD: [31.1443, 121.8083], RKSI: [37.4602, 126.4407],
};

/** Great-circle distance in nautical miles. */
function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function airportCoords(icao: string): Promise<{ lat: number; lon: number; name?: string }> {
  const known = AIRPORT_COORDS[icao];
  if (known) return { lat: known[0], lon: known[1] };
  const res = await fetch(`https://airport-data.com/api/ap_info.json?icao=${encodeURIComponent(icao)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Could not resolve coordinates for airport "${icao}" (lookup HTTP ${res.status}).`);
  const j = (await res.json()) as { latitude?: string; longitude?: string; name?: string; error?: string };
  const lat = Number(j.latitude);
  const lon = Number(j.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(
      `Unknown ICAO airport code "${icao}". Use the 4-letter ICAO form (KSFO, EGLL, EDDF), not the 3-letter IATA code.`,
    );
  }
  return { lat, lon, name: j.name };
}

/**
 * Live arrivals/departures inferred from ADS-B around the field. OpenSky — the
 * only keyless source of HISTORICAL airport movements — is unreachable from
 * cloud egress entirely (it blackholes datacenter IPs: a bogus-credential auth
 * request that should 401 in ~1s instead hangs indefinitely, from Cloudflare and
 * from a non-CF relay alike). So the default here is live activity, which is
 * both reachable and what most callers actually want.
 */
async function liveAirportActivity(kind: 'arrival' | 'departure', icao: string, radiusNm: number, limit: number) {
  const ap = await airportCoords(icao);
  const { records, source } = await adsbFetch((p) =>
    p.point(Number(ap.lat.toFixed(4)), Number(ap.lon.toFixed(4)), Math.min(250, Math.max(1, radiusNm))),
  );

  const rows = records
    .filter((a) => typeof a.lat === 'number' && typeof a.lon === 'number')
    .map((a) => {
      const alt = typeof a.alt_baro === 'number' ? a.alt_baro : a.alt_baro === 'ground' ? 0 : null;
      return {
        ...shapeAdsb(a),
        distance_nm: Math.round(distanceNm(ap.lat, ap.lon, a.lat as number, a.lon as number) * 10) / 10,
        _rate: typeof a.baro_rate === 'number' ? a.baro_rate : 0,
        _alt: alt,
        _ground: a.alt_baro === 'ground',
      };
    })
    // Arrivals descend, departures climb. Ignore cruise traffic overflying the
    // field: anything level, or high and far, is neither.
    .filter((r) => {
      if (r._ground) return false;
      if (r._alt === null) return false;
      if (kind === 'arrival') return r._rate < -200 && r._alt < 15000;
      return r._rate > 200 && r._alt < 20000;
    })
    .sort((a, b) => a.distance_nm - b.distance_nm)
    .slice(0, limit)
    .map(({ _rate, _alt, _ground, ...keep }) => keep);

  return {
    airport: icao,
    airport_name: ap.name ?? null,
    mode: 'live',
    radius_nm: radiusNm,
    source,
    count: rows.length,
    [kind === 'arrival' ? 'arriving' : 'departing']: rows,
    note:
      `Aircraft currently ${kind === 'arrival' ? 'descending toward' : 'climbing out of'} ${icao}, from live ADS-B. ` +
      'This is a real-time picture, not a scheduled timetable or a historical log.',
  };
}

async function airportFlights(kind: 'arrival' | 'departure', args: Record<string, unknown>) {
  const airport = String(args.airport ?? '').trim().toUpperCase();
  const toolName = kind === 'arrival' ? 'get_arrivals' : 'get_departures';
  if (!airport) {
    throw new Error(
      `Required argument "airport" is missing. Pass an ICAO code, e.g. ${toolName}({airport: "KJFK", begin: 1753300000, end: 1753386400}).`,
    );
  }
  if (!/^[A-Z]{4}$/.test(airport)) {
    throw new Error(
      `"${airport}" is not an ICAO airport code. OpenSky needs the 4-letter ICAO form (KJFK, EGLL, KSFO) — not the 3-letter IATA code (JFK, LHR, SFO).`,
    );
  }
  // Default path: live ADS-B around the field. Historical (OpenSky) is opt-in via
  // begin/end and only works where OpenSky is reachable — not from our gateway.
  if (args.begin === undefined && args.end === undefined) {
    const radius = Math.min(250, Math.max(1, Math.floor(Number(args.radius_nm) || 40)));
    const limit = Math.min(200, Math.max(1, Math.floor(Number(args.limit) || 50)));
    return liveAirportActivity(kind, airport, radius, limit);
  }

  const begin = Math.floor(num(args.begin, 'begin'));
  const end = Math.floor(num(args.end, 'end'));
  if (end <= begin) throw new Error('"end" must be greater than "begin" (both Unix timestamps in seconds).');
  if (end - begin > 7 * 86400) {
    throw new Error(
      `OpenSky caps this query at 7 days; you requested ${((end - begin) / 86400).toFixed(1)} days. Narrow the window.`,
    );
  }

  // Credentials: platform (gateway-injected) or the caller's own via _apiKey.
  const inline = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  let clientId = typeof args._openskyClientId === 'string' ? args._openskyClientId : '';
  let clientSecret = typeof args._openskyClientSecret === 'string' ? args._openskyClientSecret : '';
  if (inline) {
    const i = inline.indexOf(':');
    if (i < 1) {
      throw new Error(
        'OpenSky _apiKey must be "clientId:clientSecret" (two values joined by a colon), created under Account -> API clients at opensky-network.org.',
      );
    }
    clientId = inline.slice(0, i);
    clientSecret = inline.slice(i + 1);
  }
  if (!clientId || !clientSecret) {
    throw new Error(
      `${toolName} with begin/end requests HISTORICAL movements, which come from OpenSky and need credentials (_apiKey = "clientId:clientSecret" from a free API client at opensky-network.org). Note that OpenSky is not reachable from cloud egress, so this path only works when self-hosting this pack. Omit begin/end to get LIVE ${kind}s at ${airport} from ADS-B instead — keyless and always available.`,
    );
  }

  const relay = relayFrom(args);
  const token = await openskyToken(clientId, clientSecret, relay);
  const params = new URLSearchParams({ airport, begin: String(begin), end: String(end) });
  const res = await openskyFetch(`${OPENSKY_BASE}/flights/${kind}?${params}`, relay, { bearer: token });

  // OpenSky answers 404 when the window simply holds no movements — that is an
  // empty result, not an error, and it used to surface as a hard failure.
  if (res.status === 404) {
    return {
      airport,
      window: { begin, end },
      count: 0,
      flights: [],
      note: `No ${kind}s recorded at ${airport} in this window. OpenSky coverage is crowd-sourced ADS-B, so quiet airports and very recent windows can legitimately be empty.`,
    };
  }
  if (res.status === 429) {
    throw new Error(
      'OpenSky rate limit reached for these credentials (authenticated accounts get ~4,000 credits/day). Retry later, or pass your own _apiKey = "clientId:clientSecret".',
    );
  }
  if (!res.ok) throw new Error(`OpenSky ${kind} lookup failed: HTTP ${res.status}`);

  const data = (await res.json()) as OpenskyFlight[];
  return {
    airport,
    window: { begin, end },
    count: data.length,
    flights: data.map((f) => ({
      icao24: f.icao24,
      callsign: f.callsign?.trim() || null,
      first_seen: f.firstSeen,
      last_seen: f.lastSeen,
      departure_airport: f.estDepartureAirport,
      arrival_airport: f.estArrivalAirport,
    })),
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
