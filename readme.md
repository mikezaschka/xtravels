# @capire/xtravels — federated with annotations

> A fork of [capire/xtravels](https://github.com/capire/xtravels). On this branch
> (`cds-data-federation-demo`) the app's hand-written replication is replaced by
> annotations from [`cds-data-federation`](https://github.com/mikezaschka/cds-data)
> and `cds-data-pipeline`. Upstream's own readme lives in
> [the original repository](https://github.com/capire/xtravels#readme).

## What changed

Upstream marks three consumption views `@federated` and keeps 35 lines in
`srv/data-federation.js` to sync them. Here that file is gone and the views say
what they want instead:

```cds
@federation.replicate: {
  mode: 'delta', delta: { field: 'modifiedAt' },
  schedule: 600000,   // the same cadence the hand-written version used
  preload: true,
}
entity Flights as projection on external.Flights { ... }
```

| Change | Where |
|---|---|
| `@federated` becomes `@federation.replicate: { ... }` on `Flights` and `Supplements` | [`apis/capire/xflights.cds`](apis/capire/xflights.cds) |
| The same on `Customers`, which syncs `mode: 'full'` | [`apis/capire/s4.cds`](apis/capire/s4.cds) |
| The hand-written sync, and the one-line hook that loaded it, deleted | `srv/data-federation.js`, `srv/server.js` |
| The two plugins, `cds-caching`, the pipeline management console, and a `federated` profile binding the remotes to local processes | [`package.json`](package.json) |
| `FederationShowcaseService`: live delegation, both caches, write-through, scoped views. Additive, so `TravelService` and the UI never see it | [`srv/showcase/`](srv/showcase/) |
| Event-driven refresh of the replica on the remote's `FlightsUpdated`, replacing the hand-written read-and-UPDATE that upstream kept in `service_integration()` | [`srv/showcase/showcase-service.js`](srv/showcase/showcase-service.js), `srv/travel-service/service.js` |
| Suites for every federated entity, in-process and against real remotes | [`test/`](test/) |
| This readme | `readme.md` |

Everything else is untouched: the Fiori app, the draft and status flows, the
`ReserveSeats` saga to xflights, the live S/4 value help, and upstream's own test
suite, which still passes unchanged. On top of what the custom code did, the
annotations bring run history, retry, a concurrency guard, a management API and
the Pipeline Console.

## Details

### Run it

xtravels needs its sibling packages. Following upstream's *Using Workspaces*
setup:

```sh
mkdir -p cap/samples && cd cap/samples
echo '{"workspaces":["*","*/apis/*","xtravels/test/providers/*"]}' > package.json
git clone -b cds-data-federation-demo https://github.com/mikezaschka/xtravels
git clone https://github.com/capire/xflights
git clone https://github.com/capire/common
git clone https://github.com/capire/s4
npm install
```

Then start the remotes and the app. Four processes, because federation against
something in your own process proves nothing:

```sh
cd xflights                      && npx cds serve --port 4006
```
```sh
cd xtravels/test/providers/hotels && npx cds mock sap.capire.hotels.HotelsService --port 4008
```
```sh
cd xtravels/test/providers/s4     && npx cds mock API_BUSINESS_PARTNER --port 4009
```
```sh
cd xtravels && CDS_ENV=federated npx cds serve --port 4005
```

Without `CDS_ENV=federated` the app mocks every remote in-process, exactly as
upstream does, and nothing crosses the network.

> If a provider starts but serves nothing, a stale entry in CAP's shared
> `~/.cds-services.json` is the usual cause. Prefix any of the commands with
> `CDS_CONFIG='{"no_bindings":true}'` to bypass that registry.

From the [cds-data monorepo](https://github.com/mikezaschka/cds-data), one
command does all four: `npm run examples:start:xtravels`.

### Where to look

| URL | What you get |
|---|---|
| http://localhost:4005/travels/webapp/index.html | The Fiori app, unchanged (log in as `alice` / `admin`) |
| http://localhost:4005/pipeline-console/ | **Pipeline Console** — see below |
| http://localhost:4005/pipeline/Pipelines | Management API: the registered pipelines |
| http://localhost:4005/pipeline/PipelineRuns | Every run with status, trigger, timings and row counts |
| http://localhost:4005/showcase/ | The delegation showcase (OData) |
| http://localhost:4005/odata/v4/travel/ | `TravelService`, as upstream ships it |
| http://localhost:4006/odata/v4/flights/Flights | xflights, the remote behind Flights (HCQL at `/hcql/flights`) |
| http://localhost:4008/odata/v4/hotels/Hotels | The bundled hotels microservice |
| http://localhost:4009/odata/v4/api-business-partner/A_BusinessPartner | S/4 Business Partner API (V2 at `/odata/v2/...`) |

### The Pipeline Console

Open **http://localhost:4005/pipeline-console/**. It is a UI5 app shipped with
the plugin, reading and writing the same `/pipeline/` API as the curl calls
below.

The list shows what the annotations produced: `Flights`, `Supplements` and
`Customers`, plus the entity cache behind `SnapshotFlights`, registered as
`data-federation-cache:…`. Per pipeline you get status, schedule, last
successful run and error counts, and an **Overview** tab that draws the whole
flow as a graph: remote services on one side, consumption views on the other, an
arrow for each flow.

Open one and you get its run history with rows created / updated / deleted per
run, the configuration in three layers (coded, overrides, effective), the data
flow graph, and a data inspector that previews source *or* target rows with
column selection and filters. Runs can be triggered from here, and schedules
paused or changed — pausing gates only the scheduled ticks, a manual run still
works. The view refreshes every 30 seconds, every 3 while something is running.

The same thing over HTTP, which is what the tests use:

```sh
curl -u alice:admin http://localhost:4005/pipeline/Pipelines
```
```sh
curl -u alice:admin -H 'Content-Type: application/json' \
  -d '{"name":"Flights"}' http://localhost:4005/pipeline/execute
```
```sh
curl -u alice:admin "http://localhost:4005/pipeline/PipelineRuns?\$orderby=startTime%20desc&\$top=5"
```

Book a seat on xflights (`POST /odata/v4/flights/ReserveSeats`) and run the
`Flights` pipeline again: the run reports exactly one changed row.

### What the showcase service exposes

| Entity | Strategy | Point |
|---|---|---|
| `Airlines` | delegate | Plain live proxy; read-only by default, so CUD is rejected with 405 |
| `Airports` | delegate + response cache | Repeated identical queries never reach the remote |
| `Hotels` | delegate | The read-only counterpart to the entity below |
| `HotelBookings` | delegate, `writable: true` | Write-through: create/update/delete land in the hotels process, synchronously |
| `Organizations` | delegate | S/4, renamed and scoped with `where BusinessPartnerCategory == '2'` |
| `LiveFlights` | delegate | Seat counts that must not be stale; also the expand target for `Airlines` |
| `SnapshotFlights` | delegate + entity cache | A local SQLite snapshot, queried as SQL |
| `CachedFlights` | delegate + response cache | Cached responses, keyed per query |

### One remote entity, four strategies

`FlightsService.Flights` is mapped four times: replicated by the app, delegated
three ways here. Any difference in behaviour is the strategy and nothing else.
`test/federation-strategies.test.js` asserts every cell.

| | replicate | delegate | + entity cache | + response cache |
|---|---|---|---|---|
| Sees a remote change | after the next run, or at once given an event | immediately | after TTL / refresh | after TTL / invalidation |
| Arbitrary `$filter` / `$orderby` | yes, SQL | yes, at the remote | yes, SQL over the snapshot | yes, but each distinct query is a miss |
| Reads reaching the remote | none | one per request | none within the TTL | one per *distinct* query |
| Joinable with local tables | **yes** | no | no | no |
| Survives the remote being down | yes | no | within its TTL | only the exact warmed query |
| Kept locally | a table you own | nothing | a cache store | serialized responses |

A delegated query is executed by the remote, a replicated one by SQLite.
Everything above follows from that. Joining local bookings with flight data
needs the rows to be *here*, which is what replication buys and no cache
provides.

### Configuration

Two layers: what the app switches on in `package.json`, and what each
consumption view asks for in its annotation.

#### Plugins and bindings

```jsonc
"cds": {
  "requires": {
    "data-pipeline": {
      "impl": "cds-data-pipeline",
      "management": { "reuse": { "api": true, "console": true } }
    },
    "caching": { "impl": "cds-caching" },

    // Bindings per profile. Without one of these, CAP mocks the service
    // in-process and nothing crosses the network.
    "[federated]": {
      "sap.capire.flights.FlightsService": {
        "kind": "hcql",
        "credentials": { "url": "http://localhost:4006/hcql/flights" }
      },
      "sap.capire.s4.business-partner": {
        "kind": "odata",
        "credentials": { "url": "http://localhost:4009/odata/v4/api-business-partner" }
      }
    },
    "[production]": {
      "sap.capire.s4.business-partner": {
        "kind": "odata-v2",
        "credentials": { "destination": "s4-dest", "path": "/sap/opu/odata/sap/API_BUSINESS_PARTNER" }
      }
    }
  }
}
```

`management.reuse.api` serves the management service at `/pipeline`, and
`.console` adds the UI at `/pipeline-console`. Switching the console on implies
the API, since it is a client of it. Both can be left off entirely: pipelines
run either way, you just lose the operator surface. `caching` is only needed for
`cache.strategy: 'response'`.

`kind` decides the protocol: `hcql` and `odata` here, `odata-v2` for the real
S/4 in `[production]`. The demo binds URLs because the providers are local;
production binds destinations.

#### Replication

```cds
@federation.replicate: {
  mode: 'delta',                      // 'full' re-reads everything
  delta: { field: 'modifiedAt' },     // the change marker to compare against
  schedule: 600000,                   // ms between runs; omit for manual-only
  preload: true,                      // fill the table at startup
}
```

Other options:

| Option | What it does |
|---|---|
| `delta.mode` | `'timestamp'` (default), `'key'` for monotonic IDs, `'datetime-fields'` for the V2 split date/time pattern. The last one does not combine with a static `where`, which is why `Customers` syncs `mode: 'full'` |
| `batchSize` | Rows requested per remote page (default 1000). A remote that caps lower is paged until exhausted anyway |
| `preload: { wait: true }` | Blocks startup until the first load finishes — a failure then fails boot |
| `name`, `description` | What the Console and management API show instead of the entity name |

Dropping `schedule` leaves the pipeline manual-only, which is what you want when
an external scheduler (BTP Job Scheduling, a Kubernetes CronJob) drives it with
`POST /pipeline/execute`. The plugin says as much in the log when it finds an
in-process schedule.

#### The fourth trigger: a remote event

`schedule`, `preload` and `POST /pipeline/execute` are all pull-based, so the
replica is only ever as fresh as the last run. When the remote can say *which
row* changed, a pipeline can be run for that row alone:

```js
// srv/showcase/showcase-service.js
xflights.on('FlightsUpdated', async ({ data: { flight: ID, date } }) => {
  await pipelines.executeEvent('Flights', { event: { read: 'key', keys: { ID, date } } })
})
```

xflights emits `FlightsUpdated` from its own `ReserveSeats` and `ReleaseSeats`
actions, so booking a seat refreshes that flight in the replica within the
event instead of up to ten minutes later. `read: 'key'` re-reads the row from
the remote through the consumption view, so every projected column is refreshed
and a static `where` still applies; `read: 'payload'` takes the row straight
from the event when it is already source-shaped. `event.action: 'delete'`
removes the local row instead.

The run is a real run: retried on failure, serialized against a concurrent
scheduled run, and listed in the Console with `trigger: 'event'` next to the
scheduled ones. Set `cds.showcase.eventRefresh: false` in `package.json` to
switch it off and watch the pull-only behaviour instead.

Upstream did this by hand in `srv/travel-service/service.js`, guarded by
`@cds.persistence.table`, an annotation its own `srv/data-federation.js` set on
every `@federated` entity. This branch deletes that file, and
`cds-data-federation` sets the annotation `false` on derived service-level
projections (they stay views over the replica rather than getting a table of
their own), so the guard was never true and the hand-written handler silently
stopped registering. Worth knowing if you port other `@federated` code: a guard
on that annotation is reading an implementation detail of the code this branch
removes.

#### Delegation

```cds
@federation.delegate: { writable: true }        // create + update + delete
@federation.delegate: { create: true, update: true }   // or per verb
@federation.delegate                            // no flags: @readonly, CUD → 405
```

And the two caches, which differ in what they store:

```cds
// Whole responses, keyed per query. A different $filter is a different entry.
@federation.delegate: { cache: { strategy: 'response', ttl: 60000, tags: ['airports'] } }

// A local SQLite snapshot of the entity. Arbitrary CQN runs against it as SQL.
@federation.delegate: { cache: { strategy: 'entity', ttl: 30000, preload: true } }
```

| Option | Applies to | What it does |
|---|---|---|
| `ttl` | both | Entry lifetime, or the snapshot's freshness window |
| `tags` | response | Extra invalidation tags; `federation:<Entity>` is always added, so `cache.deleteByTag('federation:Airports')` clears one entity |
| `service` | response | Which `cds-caching` instance to use, when you run more than one |
| `preload` | entity | Fill the snapshot at startup instead of on the first miss |
| `wait` | entity | On a cold miss, block the request (`true`) or serve a live read while it loads |
| `static`, `group` | entity | Share one snapshot across tenants; invalidate several entities together |
| `search` | entity | Answer `$search` from the snapshot, or forward it to the remote |

Snapshots land in the app's own database by default; declaring a
`cds.requires.'data-federation-cache'` datastore moves them to a separate one.

#### Changing things at runtime

Schedules, overrides and the enabled flag are also writable through the
management API, so none of the above needs a redeploy to try out:

```sh
curl -u alice:admin -H 'Content-Type: application/json' -d '{"enabled":false}' \
  "http://localhost:4005/pipeline/Pipelines('Flights')/setEnabled"
```

Pausing stops the scheduled ticks only, a manual run still works. The Console
exposes the same operations, and shows the coded, overridden and effective
configuration side by side.

### Tests

```sh
npm test
```

- `federation-replicate` / `federation-delegate` / `federation-strategies` — remotes mocked in-process, upstream's own style.
- `federation-remote` / `federation-remote-v2` — the same app against xflights and the S/4 API as **real server processes**: CQN over HCQL, and queries translated to OData V4 and V2 URLs, with deliberately awkward ones (nested functions, parenthesised `or`/`and`/`not`, filters on unselected columns, ordering plus paging plus counting). They need `../xflights` and `../s4` and skip themselves otherwise.

The remote suites assert that each remote connects as a `RemoteService`, and two
of them kill a provider mid-test: a replicated or snapshot-backed read keeps
working, a live delegate does not. Tests that pass without any network traffic
would not tell you whether federation works.

Event-driven refresh is only covered there for the same reason: the event has to
travel between two processes through CAP's messaging, so an in-process mock
cannot exercise it. Those three tests reserve a seat on the real provider and
assert the replica converges with no run of their own, that the run is recorded
with `trigger: 'event'` and one written row, and that switching the refresh off
leaves the replica stale until a pull.

### What this turned up in CAP

Running a real app against real remotes surfaced four things in the CAP runtime
itself, all still present in 10.1.1 unless noted:

- `cqn2odata` maps `=`, `!=` and `<>` but not CDL's null-safe `==`, so a view's `where x == 'y'` reaches the remote as a literal `=` and is rejected.
- Resolving a projection for a CQN-native remote (HCQL) drops the query's `limit` and `count`, so `$top`/`$skip` are ignored and `$count` comes back 0. Fixed in 10.1.1.
- A by-key miss over HCQL answers with an empty string where OData answers `undefined`, which the OData layer renders as `200 {"value":""}` instead of 404.
- The remote client never follows `@odata.nextLink`, so a remote that caps its responses truncates silently.

And one in this app: the value help in `srv/travel-service/service.js` forwards
`req.query` with `s4.run(...)`, and CAP does not carry a projection's `where` to
a remote service, so it returns business partners the consumption view excludes.
`test/federation-delegate.test.js` asserts that contrast against the annotated
views.

## License

Copyright (c) 2022 SAP SE or an SAP affiliate company, licensed under the Apache
Software License 2.0. See [LICENSE](LICENSE). The changes on this branch are
offered under the same terms.
