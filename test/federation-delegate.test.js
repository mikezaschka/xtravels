const cds = require('@sap/cds')
const xtravels = cds.utils.path.join(__dirname, '..')
// `DELETE` stays bound to CQL; the HTTP verb is aliased so both can be used.
const { GET, POST, PATCH, DELETE: httpDelete, expect, defaults } = cds.test(xtravels, '--with-mocks')
defaults.auth = { username: 'alice' }
defaults.validateStatus = () => true

/**
 * FederationShowcaseService — the @federation.delegate variations.
 *
 * Delegation forwards each read to the remote at request time, so unlike the
 * replicated views next door there is no local table and no staleness window.
 *
 * Remotes are mocked in-process here, as in upstream's own tests. The
 * protocol-level suite (complex $filter / $expand / paging over real OData and
 * HCQL servers) lives in the cds-data monorepo under
 * packages/cds-data-federation/test/integration/xtravels/.
 */
describe('@federation.delegate', () => {

    describe('Airlines (plain delegate, read-only)', () => {

        it('serves the remote rows through the showcase service', async () => {
            const { status, data } = await GET('/showcase/Airlines?$orderby=ID')
            const remote = await SELECT.from('sap.capire.flights.FlightsService.Airlines')
            expect(status).to.equal(200)
            expect(data.value).to.have.length(remote.length)
            expect(data.value.length).to.be.greaterThan(0)
        })

        it('keeps only the projected columns', async () => {
            const { data } = await GET('/showcase/Airlines?$top=1')
            const [airline] = data.value
            expect(airline).to.include.keys('ID', 'name', 'icon')
            // `modifiedAt` and the `flights` association are not projected
            expect(airline).to.not.have.property('modifiedAt')
            expect(airline).to.not.have.property('flights')
        })

        const ENTITY = 'sap.capire.travels.showcase.FederationShowcaseService.Airlines'

        it('gets no local table, unlike the replicated views', async () => {
            const tables = (await cds.db.run("select name from sqlite_master where type='table'"))
                .map(t => t.name)
            // Contrast: the replicated view is a real table, the delegate is not.
            // (Hotels next door does get an entity-cache snapshot — that is the
            // point of the other strategy, so match on this entity only.)
            expect(tables).to.include('sap_capire_xflights_Flights')
            expect(tables).to.not.include(ENTITY.replace(/\./g, '_'))
            // No snapshot either — that only comes with cache.strategy 'entity'.
            expect(tables.filter(n => n.includes('entity_cache') && n.includes('Airlines'))).to.be.empty
            expect(cds.model.definitions[ENTITY]['@readonly']).to.be.true
        })

        it('reflects remote changes immediately — no pipeline run in between', async () => {
            const [{ ID, name }] = await SELECT.from('sap.capire.flights.FlightsService.Airlines')
            await UPDATE('sap.capire.flights.FlightsService.Airlines')
                .set({ name: 'Renamed Airways' }).where({ ID })
            try {
                const { data } = await GET(`/showcase/Airlines?$filter=ID eq '${ID}'`)
                expect(data.value[0].name).to.equal('Renamed Airways')
            } finally {
                await UPDATE('sap.capire.flights.FlightsService.Airlines').set({ name }).where({ ID })
            }
            const { data } = await GET(`/showcase/Airlines?$filter=ID eq '${ID}'`)
            expect(data.value[0].name).to.equal(name)
        })

        it('reads a single airline by key', async () => {
            const [{ ID, name }] = await SELECT.from('sap.capire.flights.FlightsService.Airlines')
            const { status, data } = await GET(`/showcase/Airlines('${ID}')`)
            expect(status).to.equal(200)
            expect(data).to.include({ ID, name })
        })

        it('returns 404 for an unknown key', async () => {
            const { status } = await GET("/showcase/Airlines('NOPE')")
            expect(status).to.equal(404)
        })

        it('forwards $filter, $select, $orderby and $top to the remote', async () => {
            const all = await SELECT.from('sap.capire.flights.FlightsService.Airlines')
            expect(all.length).to.be.greaterThan(2) // otherwise the assertions below prove little

            // $filter really narrows: one airline out of several
            const one = await GET(`/showcase/Airlines?$filter=name eq '${all[0].name}'`)
            expect(one.data.value).to.have.length(1)
            expect(one.data.value[0].ID).to.equal(all[0].ID)

            // $select restricts, $orderby sorts, $top limits
            const { data } = await GET('/showcase/Airlines?$select=ID,name&$orderby=name desc&$top=2')
            expect(data.value).to.have.length(2)
            const names = data.value.map(a => a.name)
            expect(names).to.eql([...all.map(a => a.name)].sort().reverse().slice(0, 2))
            expect(data.value[0]).to.not.have.property('icon')
        })

        it('is read-only: CUD is rejected with 405', async () => {
            const [{ ID }] = await SELECT.from('sap.capire.flights.FlightsService.Airlines')
            const created = await POST('/showcase/Airlines', { ID: 'XX', name: 'Nope' })
            const patched = await PATCH(`/showcase/Airlines('${ID}')`, { name: 'Nope' })
            const deleted = await httpDelete(`/showcase/Airlines('${ID}')`)
            expect([created.status, patched.status, deleted.status]).to.eql([405, 405, 405])

            // ... and the remote is untouched.
            const remote = await SELECT.one.from('sap.capire.flights.FlightsService.Airlines').where({ ID: 'XX' })
            expect(remote).to.be.undefined
        })
    })

    describe('Airports (delegate + response cache)', () => {

        const FLIGHTS = 'sap.capire.flights.FlightsService'
        let reads = 0

        /** Counts the reads that actually reach the remote service. */
        before(() => {
            cds.services[FLIGHTS].before('READ', 'Airports', () => { reads++ })
        })

        beforeEach(async () => {
            const cache = await cds.connect.to('caching')
            await cache.deleteByTag('federation:Airports')
            reads = 0
        })

        it('serves the remote rows through the showcase service', async () => {
            const { status, data } = await GET('/showcase/Airports?$orderby=ID')
            const remote = await SELECT.from(`${FLIGHTS}.Airports`)
            expect(status).to.equal(200)
            expect(data.value).to.have.length(remote.length)
            expect(data.value[0]).to.include.keys('ID', 'name', 'city')
            expect(data.value[0]).to.not.have.property('modifiedAt')
        })

        it('answers a repeated query from the cache, without asking the remote again', async () => {
            const first = await GET('/showcase/Airports?$orderby=ID')
            expect(reads).to.equal(1)

            const second = await GET('/showcase/Airports?$orderby=ID')
            expect(reads).to.equal(1) // no second round trip
            expect(second.data.value).to.eql(first.data.value)
        })

        it('keys entries by query — a different $filter is a different entry', async () => {
            const [a, b] = await SELECT.from(`${FLIGHTS}.Airports`).columns('ID').orderBy('ID')
            await GET(`/showcase/Airports?$filter=ID eq '${a.ID}'`)
            await GET(`/showcase/Airports?$filter=ID eq '${b.ID}'`)
            expect(reads).to.equal(2)

            // ... and each of them is now cached on its own
            const repeat = await GET(`/showcase/Airports?$filter=ID eq '${a.ID}'`)
            expect(reads).to.equal(2)
            expect(repeat.data.value.map(r => r.ID)).to.eql([a.ID])
        })

        it('goes back to the remote once the entity is invalidated by tag', async () => {
            await GET('/showcase/Airports?$orderby=ID')
            await GET('/showcase/Airports?$orderby=ID')
            expect(reads).to.equal(1)

            const cache = await cds.connect.to('caching')
            await cache.deleteByTag('federation:Airports')

            await GET('/showcase/Airports?$orderby=ID')
            expect(reads).to.equal(2)
        })

        it('caching does not make it writable', async () => {
            const created = await POST('/showcase/Airports', { ID: 'XXX', name: 'Nope' })
            expect(created.status).to.equal(405)
        })
    })

    describe('Airlines → flights (delegated expand)', () => {

        const FLIGHTS = 'sap.capire.flights.FlightsService'

        it('resolves an expand whose both sides live on the remote', async () => {
            const { ID } = await SELECT.one`ID`.from(`${FLIGHTS}.Airlines`).orderBy('ID')
            const { status, data } = await GET(
                `/showcase/Airlines?$filter=ID eq '${ID}'&$expand=flights($select=ID,free_seats;$orderby=ID)`,
            )
            expect(status).to.equal(200)
            const [airline] = data.value
            expect(airline.flights.length).to.be.greaterThan(0)
            const expected = await SELECT.from(`${FLIGHTS}.Flights`).where({ airline_ID: ID })
            expect(airline.flights.length).to.equal(expected.length)
            expect(airline.flights[0]).to.include.keys('ID', 'free_seats')
        })

        it('honours $top inside the expand', async () => {
            const { data } = await GET(
                '/showcase/Airlines?$top=1&$orderby=ID&$expand=flights($top=2;$select=ID)',
            )
            expect(data.value[0].flights).to.have.length(2)
        })

        it('nothing of the expanded data is stored locally', async () => {
            const tables = (await cds.db.run("select name from sqlite_master where type='table'")).map(t => t.name)
            expect(tables.filter(n => n.toLowerCase().includes('liveflights'))).to.be.empty
        })
    })

    describe('LiveFlights vs the replica (same remote, two strategies)', () => {

        const FLIGHTS = 'sap.capire.flights.FlightsService'

        it('serves live seats while the replica keeps the last synced value', async () => {
            const { ID, date } = await SELECT.one`ID, date`.from('sap.capire.xflights.Flights').orderBy('ID')
            const before = (await SELECT.one`free_seats`
                .from('sap.capire.xflights.Flights').where({ ID, date })).free_seats

            await UPDATE(`${FLIGHTS}.Flights`)
                .set({ free_seats: before - 5, modifiedAt: new Date().toISOString() })
                .where({ ID, date })

            // Delegated: straight from the remote, no sync in between.
            const live = await GET(`/showcase/LiveFlights?$filter=ID eq '${ID}' and date eq ${date}&$select=free_seats`)
            expect(live.data.value[0].free_seats).to.equal(before - 5)

            // Replicated: still the value from the last pipeline run ...
            const stale = await SELECT.one`free_seats`.from('sap.capire.xflights.Flights').where({ ID, date })
            expect(stale.free_seats).to.equal(before)

            // ... until one runs.
            await POST('/pipeline/execute', { name: 'Flights' })
            const synced = await SELECT.one`free_seats`.from('sap.capire.xflights.Flights').where({ ID, date })
            expect(synced.free_seats).to.equal(before - 5)
        })
    })

    describe('HotelBookings (write-through) and Hotels (read-only)', () => {

        const HOTELS = 'sap.capire.hotels.HotelsService'
        const onRemote = q => cds.services[HOTELS].run(q)

        const aBooking = async () => {
            const [hotel] = await onRemote(SELECT.from(`${HOTELS}.Hotels`).columns('ID'))
            return {
                hotel_ID: hotel.ID,
                guest: 'Ada Lovelace',
                checkIn: '2027-03-01',
                checkOut: '2027-03-05',
                rooms: 1,
                totalPrice: 1680,
            }
        }

        it('creates on the remote, not locally', async () => {
            const { status, data } = await POST('/showcase/HotelBookings', await aBooking())
            expect(status).to.equal(201)
            expect(data.ID).to.exist
            try {
                const remote = await onRemote(SELECT.from(`${HOTELS}.Bookings`).where({ ID: data.ID }))
                expect(remote, 'booking on the remote').to.have.length(1)
                expect(remote[0].guest).to.equal('Ada Lovelace')
            } finally {
                await httpDelete(`/showcase/HotelBookings(${data.ID})`)
            }
        })

        it('updates through to the remote', async () => {
            const created = await POST('/showcase/HotelBookings', await aBooking())
            try {
                const { status } = await PATCH(`/showcase/HotelBookings(${created.data.ID})`, { rooms: 3 })
                expect(status).to.be.oneOf([200, 204])
                const [remote] = await onRemote(SELECT.from(`${HOTELS}.Bookings`).where({ ID: created.data.ID }))
                expect(remote.rooms).to.equal(3)
            } finally {
                await httpDelete(`/showcase/HotelBookings(${created.data.ID})`)
            }
        })

        it('deletes through to the remote', async () => {
            const created = await POST('/showcase/HotelBookings', await aBooking())
            const { status } = await httpDelete(`/showcase/HotelBookings(${created.data.ID})`)
            expect(status).to.equal(204)
            const remote = await onRemote(SELECT.from(`${HOTELS}.Bookings`).where({ ID: created.data.ID }))
            expect(remote).to.have.length(0)
        })

        it('keeps nothing of it locally', async () => {
            const created = await POST('/showcase/HotelBookings', await aBooking())
            try {
                const tables = (await cds.db.run("select name from sqlite_master where type='table'")).map(t => t.name)
                expect(tables.some(n => n.includes('HotelBookings'))).to.be.false
            } finally {
                await httpDelete(`/showcase/HotelBookings(${created.data.ID})`)
            }
        })

        it('surfaces the remote error rather than inventing one', async () => {
            // The remote owns the rules — here, its primary key. (It does *not*
            // reject an unknown hotel_ID, which is worth knowing: no foreign key
            // is enforced, so a write-through is exactly as strict as the remote.)
            const booking = { ...await aBooking(), ID: 'c0ffee00-0000-4000-8000-000000000001' }
            const first = await POST('/showcase/HotelBookings', booking)
            expect(first.status).to.equal(201)
            try {
                const duplicate = await POST('/showcase/HotelBookings', booking)
                expect(duplicate.status).to.be.within(400, 599)
            } finally {
                await httpDelete(`/showcase/HotelBookings(${booking.ID})`)
            }
        })

        it('the catalogue next door stays read-only', async () => {
            const [hotel] = await onRemote(SELECT.from(`${HOTELS}.Hotels`).columns('ID'))
            const created = await POST('/showcase/Hotels', { name: 'Nope' })
            const patched = await PATCH(`/showcase/Hotels(${hotel.ID})`, { name: 'Nope' })
            const deleted = await httpDelete(`/showcase/Hotels(${hotel.ID})`)
            expect([created.status, patched.status, deleted.status]).to.eql([405, 405, 405])
        })
    })

    describe('Organizations (delegate on S/4: renames + static where)', () => {

        const S4 = 'API_BUSINESS_PARTNER.A_BusinessPartner'
        const onS4 = q => cds.services['sap.capire.s4.business-partner'].run(q)

        const ORG = { BusinessPartner: '950001', PersonFullName: 'Contoso AG', BusinessPartnerCategory: '2' }

        before(async () => {
            // The shipped sample data is all persons; add one company to scope to.
            await onS4(INSERT.into(S4).entries({ ...ORG, LastChangeDate: '2026-01-02', LastChangeTime: '10:00:00' }))
        })

        after(async () => {
            await onS4(DELETE.from(S4).where({ BusinessPartner: ORG.BusinessPartner }))
        })

        it('scopes to companies via the static where', async () => {
            const { status, data } = await GET('/showcase/Organizations')
            expect(status).to.equal(200)
            expect(data.value.map(o => o.ID)).to.include(ORG.BusinessPartner)
            const persons = await onS4(SELECT.from(S4).columns('BusinessPartner').where({ BusinessPartnerCategory: '1' }))
            const returned = data.value.map(o => o.ID)
            expect(persons.every(p => !returned.includes(p.BusinessPartner)), 'no persons leak through').to.be.true
        })

        it('applies the renames declared in the projection', async () => {
            const { data } = await GET(`/showcase/Organizations?$filter=ID eq '${ORG.BusinessPartner}'`)
            const [org] = data.value
            expect(org).to.include.keys('ID', 'name', 'modifiedAt')
            expect(org.name).to.equal('Contoso AG')
            expect(org).to.not.have.property('PersonFullName')
            expect(org).to.not.have.property('BusinessPartnerCategory')
        })

        it('combines a client filter with the static scope', async () => {
            // A person's ID, asked for explicitly: the scope still wins.
            const [person] = await onS4(SELECT.from(S4).columns('BusinessPartner').where({ BusinessPartnerCategory: '1' }))
            const { data } = await GET(`/showcase/Organizations?$filter=ID eq '${person.BusinessPartner}'`)
            expect(data.value).to.have.length(0)
        })

        it('keeps nothing locally — it is a live read', async () => {
            const tables = (await cds.db.run("select name from sqlite_master where type='table'")).map(t => t.name)
            expect(tables.some(n => n.includes('Organizations'))).to.be.false
        })

        it('is read-only', async () => {
            const { status } = await POST('/showcase/Organizations', { ID: '950002', name: 'Nope' })
            expect(status).to.equal(405)
        })

        it("the app's own hand-written value help does not apply that scope", async () => {
            // Upstream keeps `this.on('READ', Customers, req => s4.run(req.query))`
            // in srv/travel-service/service.js. It forwards the query as-is, and
            // CAP does not carry a projection's `where` to a remote service — so
            // the company shows up there while the annotated views exclude it.
            // Same model, same remote: the annotation is what applies the scope.
            const { data } = await GET(`/odata/v4/travel/Customers?$filter=ID eq '${ORG.BusinessPartner}'`)
            expect(data.value, 'upstream value help is unscoped').to.have.length(1)

            const replicated = await SELECT.from('sap.capire.s4.Customers').where({ ID: ORG.BusinessPartner })
            expect(replicated, 'the replica applies it').to.have.length(0)
        })
    })
})
