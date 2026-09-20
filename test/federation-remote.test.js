const cds = require('@sap/cds')
const { hasSiblingRepos, startRemotes, stopRemotes, stopFlights } = require('./support/remote-providers')

/**
 * The point of federation is that it works against a *remote*, so this suite
 * runs xtravels against xflights and the S/4 Business Partner API as separate
 * server processes: every read here is an HTTP round trip, with CQN serialized
 * over HCQL and queries translated to OData V4 URLs.
 *
 * The queries are deliberately awkward — nested functions, parenthesised
 * or/and/not, filters on columns that are not selected, paging combined with
 * ordering and counting — because that translation layer is where federation
 * breaks, and none of it is exercised by the in-process suites.
 *
 * Needs ../xflights and ../s4 (see "Using Workspaces" in the readme); skips
 * itself otherwise.
 */
const suite = hasSiblingRepos() ? describe : describe.skip

suite('federation against real remotes (HCQL + OData V4)', () => {

    before(async () => {
        await startRemotes({ s4: 'v4' })
    })

    after(async () => {
        await stopRemotes()
    })

    // `DELETE` stays bound to CQL here; the HTTP verb is aliased so both can be used.
    const { GET, POST, PATCH, DELETE: httpDelete, expect, defaults } = cds.test(cds.utils.path.join(__dirname, '..'))
    defaults.auth = { username: 'alice', password: 'admin' }
    defaults.validateStatus = () => true

    const FLIGHTS = 'sap.capire.flights.FlightsService'
    const AIRLINES = `${FLIGHTS}.Airlines`

    /** Reads straight from the provider process — the ground truth to compare against. */
    const onRemote = async query => (await cds.connect.to(FLIGHTS)).run(query)

    describe('the remotes really are remote', () => {
        it('connects each one as a RemoteService', async () => {
            // This app serves HotelsService itself, so a half-resolved binding
            // would quietly hand back the local service and every test below
            // would pass without touching the network.
            for (const name of [FLIGHTS, 'sap.capire.s4.business-partner', 'sap.capire.hotels.HotelsService']) {
                const srv = await cds.connect.to(name)
                expect(srv.constructor.name, name).to.equal('RemoteService')
            }
        })
    })

    describe('@federation.replicate over HCQL (Flights, Supplements)', () => {

        it('copies every remote row into the local table', async () => {
            const remote = await onRemote(SELECT.from(`${FLIGHTS}.Flights`))
            const local = await SELECT.from('sap.capire.xflights.Flights')
            expect(local.length).to.equal(remote.length)
            expect(local.length).to.be.greaterThan(0)
        })

        it('flattens association paths across the wire', async () => {
            // airline.name / origin.name / destination.name resolved remotely:
            // OData cannot express this, HCQL can.
            const flight = await SELECT.one.from('sap.capire.xflights.Flights').orderBy('ID')
            expect(flight.airline).to.be.a('string').and.not.be.empty
            expect(flight.origin).to.be.a('string').and.not.be.empty
            expect(flight.destination).to.be.a('string').and.not.be.empty
        })

        it('picks up only what changed on the remote since the last run', async () => {
            const { ID, date } = await SELECT.one`ID, date`.from('sap.capire.xflights.Flights').orderBy('ID')

            const noop = await POST('/pipeline/execute', { name: 'Flights' })
            expect(noop.status).to.equal(200)
            const before = await lastRun('Flights')
            expect(before.statistics_created + before.statistics_updated).to.equal(0)

            // Change it *in the remote process*. The remote serves Flights
            // read-only, so go through its own action — which is exactly how
            // the app books a seat.
            const seatsBefore = (await SELECT.one`free_seats`
                .from('sap.capire.xflights.Flights').where({ ID, date })).free_seats
            const flights = await cds.connect.to(FLIGHTS)
            await flights.send('ReserveSeats', { flight: ID, date, seats: [1] })

            await POST('/pipeline/execute', { name: 'Flights' })
            const after = await lastRun('Flights')
            expect(after.statistics_created + after.statistics_updated).to.equal(1)

            const replica = await SELECT.one.from('sap.capire.xflights.Flights').where({ ID, date })
            expect(replica.free_seats).to.equal(seatsBefore - 1)
        })

        async function lastRun(name) {
            const { data } = await GET(
                `/pipeline/PipelineRuns?$filter=pipeline_name eq '${name}'&$orderby=startTime desc&$top=1`,
            )
            return data.value[0]
        }
    })

    describe('@federation.replicate over OData V4 (Customers)', () => {

        it('applies the static where as an OData $filter', async () => {
            const s4 = await cds.connect.to('sap.capire.s4.business-partner')
            const E = 'API_BUSINESS_PARTNER.A_BusinessPartner'
            await s4.run(INSERT.into(E).entries(
                { BusinessPartner: 'ORG777', PersonFullName: 'Umbrella Corp', BusinessPartnerCategory: '2' },
            ))
            await s4.run(INSERT.into(E).entries(
                { BusinessPartner: 'PER777', PersonFullName: 'Alan Turing', BusinessPartnerCategory: '1' },
            ))
            try {
                await POST('/pipeline/execute', { name: 'Customers' })
                const ids = (await SELECT`ID`.from('sap.capire.s4.Customers')).map(c => c.ID)
                expect(ids).to.include('PER777')
                expect(ids).to.not.include('ORG777')
            } finally {
                await s4.run(DELETE.from(E, { BusinessPartner: 'ORG777' }))
                await s4.run(DELETE.from(E, { BusinessPartner: 'PER777' }))
                await DELETE.from('sap.capire.s4.Customers').where({ ID: { in: ['ORG777', 'PER777'] } })
            }
        })

        it('maps the renamed columns declared in the projection', async () => {
            const customer = await SELECT.one.from('sap.capire.s4.Customers')
            expect(customer).to.include.keys('ID', 'Name', 'modifiedAt', 'modifiedAtTime')
            expect(customer).to.not.have.property('PersonFullName')
        })
    })

    describe('@federation.delegate over HCQL (Airlines) — complex queries', () => {

        let remote
        before(async () => {
            remote = await onRemote(SELECT.from(AIRLINES).columns('ID', 'name', 'icon'))
            expect(remote.length).to.be.greaterThan(3)
        })

        it('parenthesised or/and/not combination', async () => {
            const [a, b, c] = remote
            const { status, data } = await GET(
                `/showcase/Airlines?$filter=(ID eq '${a.ID}' or ID eq '${b.ID}') and not (ID eq '${c.ID}')&$orderby=ID`,
            )
            expect(status).to.equal(200)
            expect(data.value.map(r => r.ID)).to.eql([a.ID, b.ID].sort())
        })

        it('nested string functions', async () => {
            const { name, ID } = remote[0]
            const fragment = name.slice(1, 4).toLowerCase()
            const { status, data } = await GET(
                `/showcase/Airlines?$filter=contains(tolower(name),'${fragment}')`,
            )
            expect(status).to.equal(200)
            expect(data.value.map(r => r.ID)).to.include(ID)
            expect(data.value.every(r => r.name.toLowerCase().includes(fragment))).to.be.true
        })

        it('length() with a comparison', async () => {
            const longest = remote.reduce((a, b) => (a.name.length >= b.name.length ? a : b))
            const threshold = longest.name.length - 1
            const { status, data } = await GET(`/showcase/Airlines?$filter=length(name) gt ${threshold}`)
            expect(status).to.equal(200)
            expect(data.value.map(r => r.ID)).to.include(longest.ID)
            expect(data.value.every(r => r.name.length > threshold)).to.be.true
        })

        it('filters on a column the client did not select', async () => {
            const { name, ID } = remote[0]
            const { data } = await GET(`/showcase/Airlines?$filter=name eq '${name}'&$select=ID`)
            expect(data.value.map(r => r.ID)).to.eql([ID])
            expect(data.value[0]).to.not.have.property('name')
            expect(data.value[0]).to.not.have.property('icon')
        })

        it('ordering, paging and counting together', async () => {
            const byNameDesc = [...remote].sort((a, b) => b.name.localeCompare(a.name)).map(r => r.ID)
            const { data } = await GET(
                '/showcase/Airlines?$orderby=name desc&$skip=1&$top=2&$count=true',
            )
            expect(data.value.map(r => r.ID)).to.eql(byNameDesc.slice(1, 3))
            expect(data['@odata.count']).to.equal(remote.length)
        })

        it('counts the filtered set, not the page', async () => {
            const { data } = await GET(
                `/showcase/Airlines?$filter=ID ne '${remote[0].ID}'&$top=1&$count=true`,
            )
            expect(data.value).to.have.length(1)
            expect(data['@odata.count']).to.equal(remote.length - 1)
        })

        it('in-list with a null comparison', async () => {
            const [a, b] = remote
            const { status, data } = await GET(
                `/showcase/Airlines?$filter=ID in ('${a.ID}','${b.ID}') and icon ne null`,
            )
            expect(status).to.equal(200)
            expect(data.value.map(r => r.ID).sort()).to.eql([a.ID, b.ID].sort())
        })

        it('single entity by key, and 404 for an unknown one', async () => {
            const hit = await GET(`/showcase/Airlines('${remote[0].ID}')`)
            const miss = await GET("/showcase/Airlines('NOPE')")
            expect(hit.status).to.equal(200)
            expect(hit.data).to.include({ ID: remote[0].ID, name: remote[0].name })
            expect(miss.status).to.equal(404)
        })

        it('stays read-only and leaves the remote untouched', async () => {
            const created = await POST('/showcase/Airlines', { ID: 'ZZ', name: 'Nope' })
            const patched = await PATCH(`/showcase/Airlines('${remote[0].ID}')`, { name: 'Nope' })
            const deleted = await httpDelete(`/showcase/Airlines('${remote[0].ID}')`)
            expect([created.status, patched.status, deleted.status]).to.eql([405, 405, 405])

            const after = await onRemote(SELECT.from(AIRLINES).columns('ID', 'name'))
            expect(after).to.have.length(remote.length)
            expect(after.find(r => r.ID === remote[0].ID).name).to.equal(remote[0].name)
        })
    })


    describe('mashups over the real remote', () => {

        it('resolves a delegated expand on the remote, in one request', async () => {
            const [{ ID }] = await onRemote(SELECT.from(AIRLINES).columns('ID').orderBy('ID'))
            const { status, data } = await GET(
                `/showcase/Airlines?$filter=ID eq '${ID}'&$expand=flights($select=ID,free_seats;$orderby=ID)`,
            )
            expect(status).to.equal(200)
            const expected = await onRemote(
                SELECT.from(`${FLIGHTS}.Flights`).columns('ID').where({ airline_ID: ID }),
            )
            expect(data.value[0].flights.length).to.equal(expected.length)
        })

        it('serves live seats next to the replica, from the same remote', async () => {
            const { ID, date } = await SELECT.one`ID, date`.from('sap.capire.xflights.Flights').orderBy('ID')
            const replicaBefore = (await SELECT.one`free_seats`
                .from('sap.capire.xflights.Flights').where({ ID, date })).free_seats

            const flights = await cds.connect.to(FLIGHTS)
            await flights.send('ReserveSeats', { flight: ID, date, seats: [1] })

            const live = await GET(`/showcase/LiveFlights?$filter=ID eq '${ID}' and date eq ${date}&$select=free_seats`)
            expect(live.data.value[0].free_seats).to.equal(replicaBefore - 1)

            const replica = await SELECT.one`free_seats`.from('sap.capire.xflights.Flights').where({ ID, date })
            expect(replica.free_seats).to.equal(replicaBefore)

            await POST('/pipeline/execute', { name: 'Flights' })
            const synced = await SELECT.one`free_seats`.from('sap.capire.xflights.Flights').where({ ID, date })
            expect(synced.free_seats).to.equal(replicaBefore - 1)
        })

        it('joins local bookings to the replicated flights in SQL', async () => {
            const { status, data } = await GET(
                '/odata/v4/travel/Bookings?$apply=groupby((Flight/airline),aggregate(FlightPrice with sum as total))',
            )
            expect(status).to.equal(200)
            const airlines = data.value.map(r => r.Flight?.airline).filter(Boolean)
            expect(airlines.length).to.be.greaterThan(1)
        })

        it('filters local travels by a column replicated from S/4', async () => {
            const { Name } = await SELECT.one`Name`.from('sap.capire.s4.Customers').where({ Name: { '!=': null } })
            const { status, data } = await GET(
                `/odata/v4/travel/Travels?$filter=IsActiveEntity eq true and Customer/Name eq '${Name}'&$select=ID&$count=true`,
            )
            expect(status).to.equal(200)
            expect(data['@odata.count']).to.be.greaterThan(0)
        })
    })


    describe('what delegation cannot do (real remote)', () => {

        it('no delegated variant can be joined in SQL', async () => {
            // The rows are not in this database — the boundary that replication
            // exists to remove. With a mocked remote this would quietly succeed,
            // which is why the claim is asserted here.
            for (const entity of ['LiveFlights', 'SnapshotFlights', 'CachedFlights']) {
                const fqn = `sap.capire.travels.showcase.FederationShowcaseService.${entity}`
                await expect(
                    SELECT`count(*) as n`.from('sap.capire.travels.Bookings as b')
                        .join(`${fqn} as f`).on`f.ID = b.Flight_ID`,
                    entity,
                ).to.be.rejected
            }
        })

        it('but the replica can, in one statement', async () => {
            const [{ n }] = await SELECT`count(*) as n`
                .from('sap.capire.travels.Bookings as b')
                .join('sap.capire.xflights.Flights as f').on`f.ID = b.Flight_ID and f.date = b.Flight_date`
            expect(n).to.be.greaterThan(0)
        })
    })


    describe('write-through to a real remote (HotelBookings)', () => {

        const HOTELS = 'sap.capire.hotels.HotelsService'
        const onHotels = async q => (await cds.connect.to(HOTELS)).run(q)

        const aBooking = async () => {
            const [hotel] = await onHotels(SELECT.from(`${HOTELS}.Hotels`).columns('ID'))
            return {
                hotel_ID: hotel.ID,
                guest: 'Grace Hopper',
                checkIn: '2027-05-02',
                checkOut: '2027-05-06',
                rooms: 2,
                totalPrice: 2400,
            }
        }

        it('creates, updates and deletes across the network', async () => {
            const created = await POST('/showcase/HotelBookings', await aBooking())
            expect(created.status).to.equal(201)
            const { ID } = created.data

            // The row exists in the other process, not here.
            const [remote] = await onHotels(SELECT.from(`${HOTELS}.Bookings`).where({ ID }))
            expect(remote.guest).to.equal('Grace Hopper')
            expect(remote.rooms).to.equal(2)

            const patched = await PATCH(`/showcase/HotelBookings(${ID})`, { rooms: 4 })
            expect(patched.status).to.be.oneOf([200, 204])
            const [afterPatch] = await onHotels(SELECT.from(`${HOTELS}.Bookings`).where({ ID }))
            expect(afterPatch.rooms).to.equal(4)

            const removed = await httpDelete(`/showcase/HotelBookings(${ID})`)
            expect(removed.status).to.equal(204)
            expect(await onHotels(SELECT.from(`${HOTELS}.Bookings`).where({ ID }))).to.have.length(0)
        })

        it('reads back what the remote stored, including its defaults', async () => {
            const created = await POST('/showcase/HotelBookings', await aBooking())
            try {
                // `status` is defaulted by the remote's own model, not by us.
                expect(created.data.status).to.equal('confirmed')
                const { data } = await GET(`/showcase/HotelBookings(${created.data.ID})`)
                expect(data.guest).to.equal('Grace Hopper')
            } finally {
                await httpDelete(`/showcase/HotelBookings(${created.data.ID})`)
            }
        })

        it('leaves the read-only catalogue read-only', async () => {
            const { status } = await POST('/showcase/Hotels', { name: 'Nope' })
            expect(status).to.equal(405)
        })
    })


    describe('Organizations over a real S/4 (renames + static where)', () => {

        const S4 = 'API_BUSINESS_PARTNER.A_BusinessPartner'
        const onS4 = async q => (await cds.connect.to('sap.capire.s4.business-partner')).run(q)

        it("sends the view's `== '2'` as an OData filter and returns only companies", async () => {
            const { status, data } = await GET('/showcase/Organizations?$orderby=ID')
            expect(status).to.equal(200)
            // The provider seeds four organizations; everything else is a person.
            expect(data.value.length).to.be.greaterThan(0)
            const companies = await onS4(
                SELECT.from(S4).columns('BusinessPartner').where({ BusinessPartnerCategory: '2' }),
            )
            expect(data.value.map(o => o.ID)).to.eql(companies.map(c => c.BusinessPartner).sort())
        })

        it('renames columns across the wire', async () => {
            const { data } = await GET('/showcase/Organizations?$top=1&$orderby=ID')
            expect(data.value[0]).to.include.keys('ID', 'name', 'modifiedAt')
            expect(data.value[0]).to.not.have.property('PersonFullName')
        })

        it('keeps the scope against a client filter that names a person', async () => {
            const [person] = await onS4(
                SELECT.from(S4).columns('BusinessPartner').where({ BusinessPartnerCategory: '1' }),
            )
            const { data } = await GET(`/showcase/Organizations?$filter=ID eq '${person.BusinessPartner}'`)
            expect(data.value).to.have.length(0)
        })

        it('supports $count and paging on the scoped set', async () => {
            const { data } = await GET('/showcase/Organizations?$count=true&$top=2&$orderby=ID')
            const companies = await onS4(
                SELECT.from(S4).columns('BusinessPartner').where({ BusinessPartnerCategory: '2' }),
            )
            expect(data['@odata.count']).to.equal(companies.length)
            expect(data.value).to.have.length(Math.min(2, companies.length))
        })
    })

    // Runs last: it takes xflights down and leaves it down.
    describe('@federation.delegate + response cache over HCQL (Airports)', () => {

        const { refreshEntityCache } = require('cds-data-federation/srv/entity-cache/public-api')
        const SNAPSHOT_FLIGHTS = 'sap.capire.travels.showcase.FederationShowcaseService.SnapshotFlights'

        it('caches per query and serves those reads without the remote', async () => {
            const cache = await cds.connect.to('caching')
            await cache.deleteByTag('federation:Airports')

            const warm = await GET('/showcase/Airports?$orderby=ID')
            expect(warm.status).to.equal(200)
            expect(warm.data.value.length).to.be.greaterThan(0)

            const airlinesBefore = await GET('/showcase/Airlines?$top=1')
            expect(airlinesBefore.status).to.equal(200)

            // Fill the flights snapshot too, for the outage test below: an
            // entity cache only survives an outage while its TTL still holds.
            await refreshEntityCache(SNAPSHOT_FLIGHTS)

            // The remote disappears. Nothing else in this file may need it.
            await stopFlights()

            // The cached query is still answered, byte for byte ...
            const cached = await GET('/showcase/Airports?$orderby=ID')
            expect(cached.status).to.equal(200)
            expect(cached.data.value).to.eql(warm.data.value)

            // ... a query that was never cached is not ...
            const uncached = await GET('/showcase/Airports?$orderby=name desc')
            expect(uncached.status).to.be.greaterThan(399)

            // ... and neither is the uncached delegate next door, which proves
            // the first response really came from the cache and not from a
            // still-running server.
            const airlines = await GET('/showcase/Airlines?$top=1')
            expect(airlines.status).to.be.greaterThan(399)
        })

        it('shows which of the four strategies survive the outage', async () => {
            // xflights is already down from the test above.

            // Replicated: a local table, so everything still works — including
            // queries it has never seen, and joins.
            const replica = await GET('/odata/v4/travel/Flights?$filter=free_seats gt 5&$orderby=price desc&$top=3')
            expect(replica.status, 'replicate').to.equal(200)
            expect(replica.data.value.length).to.be.greaterThan(0)

            // Snapshot: a local copy too, so arbitrary queries still run ...
            const snapshot = await GET('/showcase/SnapshotFlights?$filter=free_seats gt 5&$orderby=price desc&$top=3')
            expect(snapshot.status, 'entity cache').to.equal(200)
            expect(snapshot.data.value.length).to.be.greaterThan(0)

            // ... but it cannot be refreshed while the remote is gone, and once
            // the TTL lapses a read fails rather than serving the stale copy.
            await expect(refreshEntityCache(SNAPSHOT_FLIGHTS)).to.be.rejected

            // Live delegation: nothing to serve.
            const live = await GET('/showcase/LiveFlights?$top=1')
            expect(live.status, 'delegate').to.be.greaterThan(399)
        })
    })
})
