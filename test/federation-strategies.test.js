const cds = require('@sap/cds')
const xtravels = cds.utils.path.join(__dirname, '..')
const { GET, POST, expect, defaults } = cds.test(xtravels, '--with-mocks')
defaults.auth = { username: 'alice' }
defaults.validateStatus = () => true

/**
 * One remote entity, four strategies — the matrix in
 * examples/xtravels/README.md (cds-data monorepo), asserted cell by cell.
 *
 *   sap.capire.xflights.Flights   @federation.replicate
 *   showcase.LiveFlights          @federation.delegate
 *   showcase.SnapshotFlights      @federation.delegate + cache.strategy 'entity'
 *   showcase.CachedFlights        @federation.delegate + cache.strategy 'response'
 *
 * All four project `FlightsService.Flights`, so nothing here depends on the
 * shape of the data: every difference below *is* the strategy. The negative
 * cells are asserted rather than skipped — a boundary you can run is worth more
 * than a test that was never written.
 *
 * Everything follows from one fact: a delegated query is executed by the
 * remote, a replicated one by SQLite.
 *
 * Caveat worth knowing: the remotes are mocked in-process here, so a delegated
 * entity is still backed by a local table belonging to the mock. Cells that
 * depend on the remote being genuinely remote — joins failing, reads surviving
 * an outage — are asserted in federation-remote.test.js instead.
 */
describe('One remote entity, four strategies', () => {

    const FLIGHTS = 'sap.capire.flights.FlightsService'
    const REPLICA = 'sap.capire.xflights.Flights'
    const { refreshEntityCache } = require('cds-data-federation/srv/entity-cache/public-api')
    const SNAPSHOT = 'sap.capire.travels.showcase.FederationShowcaseService.SnapshotFlights'

    /** Reads that actually reach the remote service. */
    let reads = 0
    before(async () => {
        cds.services[FLIGHTS].before('READ', 'Flights', () => { reads++ })
        // `preload` fills the replica in the background; don't race it.
        await POST('/pipeline/execute', { name: 'Flights' })
    })

    const resetCaches = async () => {
        const cache = await cds.connect.to('caching')
        await cache.deleteByTag('federation:CachedFlights')
        await refreshEntityCache(SNAPSHOT)
        reads = 0
    }

    describe('all four serve the same rows', () => {

        it('returns every remote row, whichever strategy is used', async () => {
            const remote = await SELECT.from(`${FLIGHTS}.Flights`)
            const replica = await SELECT.from(REPLICA)
            const live = await GET('/showcase/LiveFlights')
            const snapshot = await GET('/showcase/SnapshotFlights')
            const cached = await GET('/showcase/CachedFlights')

            expect(replica.length).to.equal(remote.length)
            for (const res of [live, snapshot, cached]) {
                expect(res.status).to.equal(200)
                expect(res.data.value).to.have.length(remote.length)
            }
        })

        it('applies $filter and $orderby the same way everywhere', async () => {
            const query = "$filter=free_seats gt 0&$orderby=ID&$select=ID,free_seats"
            const live = await GET(`/showcase/LiveFlights?${query}`)
            const snapshot = await GET(`/showcase/SnapshotFlights?${query}`)
            const cached = await GET(`/showcase/CachedFlights?${query}`)
            const replica = await GET(`/odata/v4/travel/Flights?$filter=free_seats gt 0&$orderby=ID&$select=ID,free_seats`)

            const ids = replica.data.value.map(f => f.ID)
            expect(ids.length).to.be.greaterThan(0)
            for (const res of [live, snapshot, cached]) {
                expect(res.data.value.map(f => f.ID)).to.eql(ids)
            }
        })
    })

    describe('freshness — who sees a remote change immediately', () => {

        let ID, date, before_
        beforeEach(async () => {
            await resetCaches()
            const flight = await SELECT.one`ID, date, free_seats`.from(REPLICA).orderBy('ID')
            ;({ ID, date, free_seats: before_ } = flight)
            // Warm the two caches with the query used below.
            await GET(`/showcase/CachedFlights?$filter=ID eq '${ID}' and date eq ${date}&$select=free_seats`)
            await GET(`/showcase/SnapshotFlights?$filter=ID eq '${ID}' and date eq ${date}&$select=free_seats`)
            await UPDATE(`${FLIGHTS}.Flights`)
                .set({ free_seats: before_ - 7, modifiedAt: new Date().toISOString() })
                .where({ ID, date })
        })

        afterEach(async () => {
            await UPDATE(`${FLIGHTS}.Flights`)
                .set({ free_seats: before_, modifiedAt: new Date().toISOString() })
                .where({ ID, date })
            await POST('/pipeline/execute', { name: 'Flights' })
            await resetCaches()
        })

        it('delegate: sees it at once', async () => {
            const { data } = await GET(`/showcase/LiveFlights?$filter=ID eq '${ID}' and date eq ${date}&$select=free_seats`)
            expect(data.value[0].free_seats).to.equal(before_ - 7)
        })

        it('replicate: keeps the last synced value until a run', async () => {
            const stale = await SELECT.one`free_seats`.from(REPLICA).where({ ID, date })
            expect(stale.free_seats).to.equal(before_)

            await POST('/pipeline/execute', { name: 'Flights' })
            const synced = await SELECT.one`free_seats`.from(REPLICA).where({ ID, date })
            expect(synced.free_seats).to.equal(before_ - 7)
        })

        it('entity cache: serves the snapshot until it is refreshed', async () => {
            const stale = await GET(`/showcase/SnapshotFlights?$filter=ID eq '${ID}' and date eq ${date}&$select=free_seats`)
            expect(stale.data.value[0].free_seats).to.equal(before_)

            await refreshEntityCache(SNAPSHOT)
            const fresh = await GET(`/showcase/SnapshotFlights?$filter=ID eq '${ID}' and date eq ${date}&$select=free_seats`)
            expect(fresh.data.value[0].free_seats).to.equal(before_ - 7)
        })

        it('response cache: serves the cached response until it is invalidated', async () => {
            const stale = await GET(`/showcase/CachedFlights?$filter=ID eq '${ID}' and date eq ${date}&$select=free_seats`)
            expect(stale.data.value[0].free_seats).to.equal(before_)

            const cache = await cds.connect.to('caching')
            await cache.deleteByTag('federation:CachedFlights')
            const fresh = await GET(`/showcase/CachedFlights?$filter=ID eq '${ID}' and date eq ${date}&$select=free_seats`)
            expect(fresh.data.value[0].free_seats).to.equal(before_ - 7)
        })
    })

    describe('cost — how many reads reach the remote', () => {

        beforeEach(resetCaches)

        it('replicate: none, the data is already local', async () => {
            await GET('/odata/v4/travel/Flights?$top=5&$orderby=ID')
            await GET("/odata/v4/travel/Flights?$filter=airline ne ''")
            expect(reads).to.equal(0)
        })

        it('delegate: one per request', async () => {
            await GET('/showcase/LiveFlights?$top=5&$orderby=ID')
            await GET('/showcase/LiveFlights?$top=5&$orderby=ID')
            expect(reads).to.equal(2)
        })

        it('entity cache: none until the TTL expires, whatever the query', async () => {
            await GET('/showcase/SnapshotFlights?$top=5&$orderby=ID')
            await GET('/showcase/SnapshotFlights?$filter=free_seats gt 10')
            await GET('/showcase/SnapshotFlights?$orderby=price desc&$top=3')
            expect(reads).to.equal(0) // the snapshot was filled by resetCaches
        })

        it('response cache: one per *distinct* query', async () => {
            await GET('/showcase/CachedFlights?$top=5&$orderby=ID')
            await GET('/showcase/CachedFlights?$top=5&$orderby=ID') // hit
            expect(reads).to.equal(1)

            await GET('/showcase/CachedFlights?$top=6&$orderby=ID') // miss: different query
            expect(reads).to.equal(2)
        })
    })

    describe('local joins — what SQL can reach', () => {

        it('replicate: joins local Bookings in one SQL statement', async () => {
            const [{ n }] = await SELECT`count(*) as n`
                .from('sap.capire.travels.Bookings as b')
                .join(`${REPLICA} as f`).on`f.ID = b.Flight_ID and f.date = b.Flight_date`
            expect(n).to.be.greaterThan(0)
        })

        it('replicate: aggregates across that join via $apply', async () => {
            const { status, data } = await GET(
                '/odata/v4/travel/Bookings?$apply=groupby((Flight/airline),aggregate(FlightPrice with sum as total))',
            )
            expect(status).to.equal(200)
            expect(data.value.filter(r => r.Flight?.airline).length).to.be.greaterThan(1)
        })

        it('the delegated variants own no table to join against', async () => {
            // A delegate handler intercepts reads *of the entity*; it cannot
            // intercept a JOIN inside someone else's statement. That the join
            // then fails outright is asserted in federation-remote.test.js:
            // here the "remote" is mocked in-process, so CAP can still compile
            // the projection into SQL over the mock's own table — which is
            // exactly the illusion in-process mocking creates.
            const tables = (await cds.db.run("select name from sqlite_master where type='table'")).map(t => t.name)
            for (const entity of ['LiveFlights', 'SnapshotFlights', 'CachedFlights']) {
                const fqn = `sap.capire.travels.showcase.FederationShowcaseService.${entity}`
                expect(tables, entity).to.not.include(fqn.replace(/\./g, '_'))
            }
        })

        it('only replicate and the entity cache keep anything on disk', async () => {
            const tables = (await cds.db.run("select name from sqlite_master where type='table'")).map(t => t.name)
            expect(tables).to.include('sap_capire_xflights_Flights')               // replica: a table you own
            expect(tables.some(n => n.includes('entity_cache') && n.includes('SnapshotFlights'))).to.be.true
            expect(tables.some(n => n.includes('LiveFlights'))).to.be.false
            expect(tables.some(n => n.includes('CachedFlights'))).to.be.false      // response cache is not SQL
        })
    })

    describe('writes — none of them are writable without opting in', () => {
        it('rejects CUD on every variant', async () => {
            for (const entity of ['LiveFlights', 'SnapshotFlights', 'CachedFlights']) {
                const { status } = await POST(`/showcase/${entity}`, { ID: 'XX', date: '2030-01-01' })
                expect(status, entity).to.equal(405)
            }
        })
    })
})
